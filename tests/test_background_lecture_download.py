"""Owned, asynchronous lecture media downloads with isolated synthetic files."""

from pathlib import Path
from types import SimpleNamespace

import pytest

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.rate_limit import limiter, quotas
from lecture_processor.domains.upload import import_audio
from lecture_processor.services import media_admission


@pytest.fixture
def downloads(client, core, monkeypatch, tmp_path):
    state = SimpleNamespace(client=client, core=core, queued=[], media=[], released=[], reserved=[], paths=[], deleting=False)
    monkeypatch.setattr(core, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(core, 'verify_firebase_token', lambda req: {'uid': req.headers.get('X-Test-Uid', 'owner'), 'email': 'user@example.test'} if req.headers.get('X-Test-Uid', 'owner') else None)
    monkeypatch.setattr(core, 'is_email_allowed', lambda _email: True)
    monkeypatch.setattr(lifecycle, 'ensure_account_allows_writes', lambda *_args, **_kwargs: (not state.deleting, 'Account unavailable'))
    monkeypatch.setattr(limiter, 'check_rate_limit', lambda **_kwargs: (True, 0))
    monkeypatch.setattr(import_audio, 'validate_video_import_fetch_target', lambda *_args, **_kwargs: ('https://media.example.test/file?secret=signed', ''))
    monkeypatch.setattr(quotas, 'has_sufficient_upload_disk_space', lambda *_args, **_kwargs: (True, 10**12, 0))
    monkeypatch.setattr(quotas, 'reserve_daily_upload_bytes', lambda uid, size, **_kwargs: state.reserved.append((uid, size)) or (True, 0))
    monkeypatch.setattr(quotas, 'release_daily_upload_bytes', lambda uid, size, **_kwargs: state.released.append((uid, size)) or True)
    monkeypatch.setattr(core, 'submit_background_job', lambda target, *args, **kwargs: state.queued.append((target, args, kwargs)))

    def download(target, prefix):
        state.media.append(target)
        path = tmp_path / f'{prefix}_audio.mp3'
        path.write_bytes(b'ID3 synthetic lecture')
        state.paths.append(path)
        return str(path), path.name, path.stat().st_size

    monkeypatch.setattr(core, 'download_audio_from_video_url', download)
    def post(**kwargs):
        headers = {'Accept': 'application/json', **kwargs.pop('headers', {})}
        return client.post('/api/tools/lecture-download', json={'url': 'https://media.example.test/file?secret=signed', 'format': 'audio'}, headers=headers, **kwargs)

    state.post = post
    yield state
    # Tests that deliberately withhold the worker still release process admission.
    for target, args, kwargs in state.queued:
        for value in (*args, *kwargs.values()):
            if isinstance(value, media_admission._MediaLease):
                value.release()


def test_request_returns_queued_before_any_media_work(downloads):
    response = downloads.post()
    assert response.status_code == 202
    assert response.get_json()['status'] == 'queued'
    assert response.get_json()['job_id']
    assert downloads.media == []
    assert len(downloads.queued) == 1


def run_worker(state):
    target, args, kwargs = state.queued.pop(0)
    target(*args, **kwargs)


def status(state, job_id, uid='owner'):
    return state.client.get(f'/api/tools/lecture-download/{job_id}', headers={'X-Test-Uid': uid})


def file_response(state, job_id, token, uid='owner', **headers):
    return state.client.get(f'/api/tools/lecture-download/{job_id}/file', query_string={'token': token}, headers={'X-Test-Uid': uid, **headers})


def test_legacy_client_refreshes_before_any_work(downloads):
    response = downloads.post(headers={'Accept': '*/*'})
    assert response.status_code == 409
    assert response.get_json() == {'error': 'Please refresh this page before starting a download.'}
    assert downloads.queued == downloads.media == downloads.reserved == []


def test_worker_finishes_outside_request_context_and_file_can_retry_and_range(downloads):
    job_id = downloads.post().get_json()['job_id']
    assert status(downloads, job_id).get_json()['status'] == 'queued'
    run_worker(downloads)
    ready = status(downloads, job_id).get_json()
    assert ready['status'] == 'complete'
    assert ready['size_bytes'] == len(b'ID3 synthetic lecture')
    assert ready['file_name'].endswith('.mp3')
    assert len(ready['download_token']) >= 40
    for _ in range(2):
        response = file_response(downloads, job_id, ready['download_token'])
        assert response.status_code == 200
        assert response.data == b'ID3 synthetic lecture'
        assert response.headers['Cache-Control'] == 'private, no-store'
        response.close()
        assert downloads.paths[0].exists()
    partial = file_response(downloads, job_id, ready['download_token'], Range='bytes=0-2')
    assert partial.status_code == 206
    assert partial.data == b'ID3'
    partial.close()
    assert 'signed' not in repr(downloads.core.jobs)
    assert 'secret' not in repr(ready)
    assert downloads.core.jobs[job_id]['job_scope'] == 'lecture_download'
    assert 'credit_deducted' not in downloads.core.jobs[job_id]


@pytest.mark.parametrize('uid,expected', [('', 401), ('other', 404)])
def test_status_and_file_are_owner_only_even_with_token(downloads, uid, expected):
    job_id = downloads.post().get_json()['job_id']
    run_worker(downloads)
    ready = status(downloads, job_id).get_json()
    assert status(downloads, job_id, uid).status_code == expected
    assert file_response(downloads, job_id, ready['download_token'], uid).status_code == expected
    assert downloads.paths[0].exists()


def test_missing_or_wrong_token_is_rejected_without_deleting_file(downloads):
    job_id = downloads.post().get_json()['job_id']
    run_worker(downloads)
    for token in ('', 'wrong'):
        assert file_response(downloads, job_id, token).status_code == 404
    assert downloads.paths[0].exists()


@pytest.mark.parametrize('reader', ['status', 'file', 'cleanup'])
def test_expired_file_is_removed_without_another_download(downloads, monkeypatch, reader):
    job_id = downloads.post().get_json()['job_id']
    run_worker(downloads)
    ready = status(downloads, job_id).get_json()
    deadline = downloads.core.jobs[job_id]['result']['download']['expires_at']
    monkeypatch.setattr(downloads.core, 'time', SimpleNamespace(time=lambda: deadline + 1))
    if reader == 'status':
        assert status(downloads, job_id).get_json()['status'] == 'error'
    elif reader == 'file':
        assert file_response(downloads, job_id, ready['download_token']).status_code == 410
    else:
        downloads.core.cleanup_old_jobs()
    assert not downloads.paths[0].exists()


@pytest.mark.parametrize('target', ['outside', 'symlink', 'other_job'])
def test_file_path_cannot_escape_owned_artifact(downloads, tmp_path, target):
    job_id = downloads.post().get_json()['job_id']
    run_worker(downloads)
    ready = status(downloads, job_id).get_json()
    outside = tmp_path.parent / f'{job_id}_private.txt'
    outside.write_text('private synthetic contents')
    if target == 'symlink':
        path = tmp_path / f'{job_id}_linked.mp3'
        path.symlink_to(outside)
    elif target == 'other_job':
        path = tmp_path / 'other-job_audio.mp3'
        path.write_text('other account synthetic audio')
    else:
        path = outside
    downloads.core.jobs[job_id]['export_path'] = str(path)
    assert file_response(downloads, job_id, ready['download_token']).status_code == 404
    assert path.exists()
    assert outside.read_text() == 'private synthetic contents'


def test_queued_job_retains_admission_until_worker_finishes(downloads):
    job_id = downloads.post().get_json()['job_id']
    assert downloads.post().status_code == 429
    assert downloads.post(headers={'X-Test-Uid': 'other'}).status_code == 503
    assert len(downloads.reserved) == 1
    run_worker(downloads)
    assert status(downloads, job_id).get_json()['status'] == 'complete'
    assert downloads.post().status_code == 202


@pytest.mark.parametrize('exception_kind,status_code', [('full', 503), ('unexpected', 500)])
def test_enqueue_failure_releases_admission_and_quota(downloads, monkeypatch, exception_kind, status_code):
    from lecture_processor.runtime.job_dispatcher import JobQueueFullError

    original = downloads.core.submit_background_job
    error = JobQueueFullError('full') if exception_kind == 'full' else RuntimeError('private queue details')
    monkeypatch.setattr(downloads.core, 'submit_background_job', lambda *_args, **_kwargs: (_ for _ in ()).throw(error))
    response = downloads.post()
    assert response.status_code == status_code
    assert 'private queue' not in response.get_data(as_text=True)
    assert downloads.released == downloads.reserved
    assert downloads.media == []
    assert all(job['status'] == 'error' for job in downloads.core.jobs.values())
    monkeypatch.setattr(downloads.core, 'submit_background_job', original)
    assert downloads.post().status_code == 202


def test_cancelled_queued_future_releases_admission_and_quota(downloads, monkeypatch):
    from concurrent.futures import Future

    future = Future()
    monkeypatch.setattr(downloads.core, 'submit_background_job', lambda *_args, **_kwargs: future)
    job_id = downloads.post().get_json()['job_id']
    assert future.cancel()
    assert status(downloads, job_id).get_json()['status'] == 'error'
    assert downloads.released == downloads.reserved
    lease, code = media_admission.try_acquire('owner')
    assert code == 0
    lease.release()


@pytest.mark.parametrize('boundary', ['before_worker', 'after_download'])
def test_account_deletion_prevents_publishing_and_cleans_files(downloads, monkeypatch, boundary):
    job_id = downloads.post().get_json()['job_id']
    if boundary == 'before_worker':
        downloads.deleting = True
    else:
        original = downloads.core.download_audio_from_video_url

        def delete_during_download(*args):
            result = original(*args)
            downloads.deleting = True
            return result

        monkeypatch.setattr(downloads.core, 'download_audio_from_video_url', delete_during_download)
    run_worker(downloads)
    assert downloads.core.jobs[job_id]['status'] == 'error'
    assert all(not path.exists() for path in downloads.paths)
    assert downloads.released == downloads.reserved
    assert 'export_path' not in downloads.core.jobs[job_id]


def test_failed_media_cleans_partial_files_and_releases_quota(downloads, monkeypatch, tmp_path):
    def failing(_target, prefix):
        path = tmp_path / f'{prefix}.part'
        path.write_bytes(b'incomplete media')
        downloads.paths.append(path)
        raise RuntimeError('upstream https://media.example.test/file?secret=signed failure')

    monkeypatch.setattr(downloads.core, 'download_audio_from_video_url', failing)
    job_id = downloads.post().get_json()['job_id']
    run_worker(downloads)
    body = status(downloads, job_id).get_json()
    assert body['status'] == 'error'
    assert 'signed' not in repr(body)
    assert all(not path.exists() for path in downloads.paths)
    assert downloads.released == downloads.reserved
    assert downloads.post().status_code == 202


def test_adjustment_failure_is_handled_in_worker_app_context(downloads, monkeypatch):
    from lecture_processor.services import upload_quota_service

    monkeypatch.setattr(upload_quota_service, 'adjust_reserved_upload_bytes', lambda runtime, *_args, **_kwargs: (runtime.jsonify({'error': 'Synthetic full disk'}), 503))
    job_id = downloads.post().get_json()['job_id']
    run_worker(downloads)
    assert status(downloads, job_id).get_json()['status'] == 'error'
    assert all(not path.exists() for path in downloads.paths)
    assert downloads.released == downloads.reserved
    assert downloads.post().status_code == 202


def test_download_jobs_do_not_appear_as_study_jobs(downloads):
    job_id = downloads.post().get_json()['job_id']
    active = downloads.client.get('/api/runtime-jobs/active').get_json()
    assert active['jobs'] == []
    assert downloads.client.get(f'/status/{job_id}').get_json()['status'] == 'queued'


def test_expiration_does_not_remove_active_job_partial_files(downloads, tmp_path):
    from lecture_processor.services import tools_download_service

    job_id = downloads.post().get_json()['job_id']
    path = tmp_path / f'{job_id}_partial.mp3'
    path.write_bytes(b'in progress')
    tools_download_service.cleanup_expired_downloads(downloads.core)
    assert path.exists()


def test_bundle_checks_extra_disk_without_doubling_daily_quota(downloads, monkeypatch, tmp_path):
    import io
    import zipfile

    checked = []
    monkeypatch.setattr(quotas, 'has_sufficient_upload_disk_space', lambda size, **_kwargs: checked.append(size) or (True, 10**12, 0))

    def video(_target, prefix):
        path = tmp_path / f'{prefix}.mp4'
        path.write_bytes(b'synthetic video')
        downloads.paths.append(path)
        return str(path), path.name, path.stat().st_size

    def convert(path):
        audio = Path(path).with_suffix('.mp3')
        audio.write_bytes(b'ID3 audio')
        downloads.paths.append(audio)
        return str(audio), True

    monkeypatch.setattr(downloads.core, 'download_video_from_video_url', video)
    monkeypatch.setattr(downloads.core, 'convert_audio_to_mp3_with_ytdlp', convert)
    monkeypatch.setattr(downloads.core, 'file_looks_like_audio', lambda _path: True)
    response = downloads.client.post('/api/tools/lecture-download', headers={'Accept': 'application/json'}, json={'url': 'https://media.example.test', 'format': 'both'})
    assert response.status_code == 202
    job_id = response.get_json()['job_id']
    run_worker(downloads)
    ready = status(downloads, job_id).get_json()
    assert ready['status'] == 'complete'
    response = file_response(downloads, job_id, ready['download_token'])
    archive = zipfile.ZipFile(io.BytesIO(response.data))
    assert archive.read('lecture-video.mp4') == b'synthetic video'
    assert archive.read('lecture-audio.mp3') == b'ID3 audio'
    response.close()
    media_bytes = len(b'synthetic video') + len(b'ID3 audio')
    assert downloads.reserved == [('owner', downloads.core.MAX_AUDIO_UPLOAD_BYTES * 2)]
    assert sum(size for _uid, size in downloads.reserved) - sum(size for _uid, size in downloads.released) == media_bytes
    assert checked[0] >= downloads.core.MAX_AUDIO_UPLOAD_BYTES * 4
    assert checked[-1] >= media_bytes
    assert all(not path.exists() for path in downloads.paths)
    assert list(tmp_path.glob('*')) == [Path(downloads.core.jobs[job_id]['export_path'])]


def test_bundle_low_disk_rejects_before_quota_and_can_retry(downloads, monkeypatch):
    monkeypatch.setattr(quotas, 'has_sufficient_upload_disk_space', lambda size, **_kwargs: (size <= downloads.core.MAX_AUDIO_UPLOAD_BYTES * 2, 0, size))
    response = downloads.client.post('/api/tools/lecture-download', headers={'Accept': 'application/json'}, json={'url': 'https://media.example.test', 'format': 'both'})
    assert response.status_code == 503
    assert downloads.reserved == downloads.media == downloads.queued == []
    assert downloads.post().status_code == 202


@pytest.mark.parametrize('durable_status', ['missing', 'complete', 'processing', 'read_error'])
def test_cleanup_after_restart_checks_durable_ownership(downloads, monkeypatch, tmp_path, durable_status):
    import os

    from lecture_processor.services import tools_download_service

    job_id = downloads.post().get_json()['job_id']
    run_worker(downloads)
    job = downloads.core.jobs.pop(job_id)
    future = job['result']['download']['expires_at'] + 1
    monkeypatch.setattr(downloads.core, 'time', SimpleNamespace(time=lambda: future))
    os.utime(downloads.paths[0], (future - 3600, future - 3600))
    monkeypatch.setattr(downloads.core, 'db', object())

    def get_doc(*_args):
        if durable_status == 'read_error':
            raise RuntimeError('Synthetic lookup outage')
        stored = {**job, 'status': durable_status}
        return SimpleNamespace(exists=durable_status != 'missing', to_dict=lambda: stored)

    monkeypatch.setattr(downloads.core.runtime_jobs_repo, 'get_doc', get_doc)
    tools_download_service.cleanup_expired_downloads(downloads.core)
    assert downloads.paths[0].exists() is (durable_status in {'processing', 'read_error'})


def test_runtime_record_survives_memory_loss_without_signed_url(downloads, monkeypatch):
    documents = {}
    monkeypatch.setattr(downloads.core, 'db', object())

    def set_doc(_db, _collection, job_id, fields, **_kwargs):
        documents.setdefault(job_id, {}).update(fields)

    monkeypatch.setattr(downloads.core.runtime_jobs_repo, 'set_doc', set_doc)
    monkeypatch.setattr(downloads.core.runtime_jobs_repo, 'get_doc', lambda _db, _collection, job_id: SimpleNamespace(exists=job_id in documents, to_dict=lambda: dict(documents[job_id])))
    job_id = downloads.post().get_json()['job_id']
    assert documents[job_id]['status'] == 'queued'
    assert 'signed' not in repr(documents)
    run_worker(downloads)
    assert documents[job_id]['status'] == 'complete'
    downloads.core.jobs.clear()
    ready = status(downloads, job_id).get_json()
    assert ready['status'] == 'complete'
    assert file_response(downloads, job_id, ready['download_token']).data == b'ID3 synthetic lecture'
    assert 'signed' not in repr(documents)


def test_named_job_submission_tracks_queued_and_running_execution(downloads, monkeypatch):
    from concurrent.futures import Future
    from lecture_processor.domains.runtime_jobs import execution

    state = SimpleNamespace(run=None)
    future = Future()

    def submit(target):
        state.run = target
        return future

    dispatcher = SimpleNamespace(submit=submit)
    monkeypatch.setattr(downloads.core, 'submit_background_job', lambda target, *args, **kwargs: execution.submit_job(dispatcher, target, *args, execution_runtime=downloads.core, **kwargs))
    job_id = downloads.post().get_json()['job_id']
    assert execution.is_job_active(job_id)
    original = downloads.core.download_audio_from_video_url

    def check_running(*args):
        assert execution.is_job_active(job_id)
        assert downloads.core.jobs[job_id]['last_heartbeat_at'] > 0
        return original(*args)

    monkeypatch.setattr(downloads.core, 'download_audio_from_video_url', check_running)
    state.run()
    assert not execution.is_job_active(job_id)
    assert status(downloads, job_id).get_json()['status'] == 'complete'


def test_restart_recovery_finishes_zero_credit_download_without_refund(downloads, monkeypatch):
    from lecture_processor.domains.billing import credits

    job_id = downloads.post().get_json()['job_id']
    downloads.core.jobs[job_id]['started_at'] = downloads.core.time.time() - 3600
    document = dict(downloads.core.jobs[job_id])
    monkeypatch.setattr(downloads.core, 'db', object())
    monkeypatch.setattr(downloads.core, 'RUNTIME_JOB_RECOVERY_ENABLED', True)
    monkeypatch.setattr(downloads.core.runtime_jobs_repo, 'get_doc', lambda *_args: SimpleNamespace(id=job_id, exists=True, to_dict=lambda: dict(document)))
    monkeypatch.setattr(downloads.core.runtime_jobs_repo, 'set_doc', lambda _db, _collection, _job_id, fields, **_kwargs: document.update(fields))
    monkeypatch.setattr(downloads.core, 'save_job_log', lambda *_args: None)
    monkeypatch.setattr(credits, 'refund_credit', lambda *_args, **_kwargs: pytest.fail('A free download must not refund a credit'))
    monkeypatch.setattr(credits, 'refund_slides_credits', lambda *_args, **_kwargs: pytest.fail('A free download must not refund a credit'))
    body = status(downloads, job_id).get_json()
    assert body['status'] == 'error'
    assert document['status'] == 'error'
    assert not document.get('credit_refunded')
    # A delayed queued callback must not revive or begin media for that job.
    run_worker(downloads)
    assert downloads.media == []
    assert downloads.core.jobs[job_id]['status'] == 'error'
    assert downloads.released == downloads.reserved


def test_external_terminal_transition_during_media_is_preserved(downloads, monkeypatch):
    job_id = downloads.post().get_json()['job_id']
    original = downloads.core.download_audio_from_video_url

    def stop_during_download(*args):
        output = original(*args)
        downloads.core.jobs[job_id].update(status='error', error='Synthetic external cancellation')
        return output

    monkeypatch.setattr(downloads.core, 'download_audio_from_video_url', stop_during_download)
    run_worker(downloads)
    assert downloads.core.jobs[job_id]['error'] == 'Synthetic external cancellation'
    assert 'export_path' not in downloads.core.jobs[job_id]
    assert all(not path.exists() for path in downloads.paths)
    assert downloads.released == downloads.reserved
