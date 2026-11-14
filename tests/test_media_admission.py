"""Admission behavior across queued media downloads and batch conversion."""

from concurrent.futures import ThreadPoolExecutor
import io
import json
from pathlib import Path
from threading import Event, Lock
from types import SimpleNamespace
import zipfile

import pytest

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.rate_limit import limiter
from lecture_processor.domains.upload import import_audio
from lecture_processor.services import media_admission, upload_quota_service
from tests.credit_test_support import make_credit_runtime


class _MediaState(SimpleNamespace):
    @property
    def charges(self):
        return list(self.store.docs('credit_charges').values())


@pytest.fixture
def media_requests(app, core, monkeypatch, tmp_path):
    app.config['TESTING'] = True
    state = _MediaState(
        entered=Event(), release=Event(), lock=Lock(), hold='', held=False,
        failure='', quota=[], media=[], submitted=[],
    )
    credit_runtime, state.store = make_credit_runtime(users={
        uid: {'uid': uid, 'account_status': 'active', 'slides_credits': 100, 'total_processed': 0}
        for uid in ('first', 'other')
    }, unified_enabled=False)

    def token(request):
        uid = request.headers.get('X-Test-Uid', '')
        return {'uid': uid, 'email': f'{uid}@example.test'} if uid else None

    monkeypatch.setattr(core, 'verify_firebase_token', token)
    monkeypatch.setattr(core, 'is_email_allowed', lambda email: not email.startswith('denied@'))
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda email, runtime=None: not email.startswith('denied@'))
    monkeypatch.setattr(lifecycle, 'ensure_account_allows_writes', lambda uid, runtime=None: (uid != 'deleting', 'Account unavailable'))
    monkeypatch.setattr(lifecycle, 'count_active_jobs_for_user', lambda *_args, **_kwargs: 0)
    monkeypatch.setattr(limiter, 'check_rate_limit', lambda **_kwargs: (True, 0))
    monkeypatch.setattr(core, 'client', object())
    monkeypatch.setattr(core, 'db', credit_runtime.db)
    monkeypatch.setattr(core, 'UNIFIED_CREDITS_ENABLED', False)
    monkeypatch.setattr(core.firestore, 'transactional', credit_runtime.firestore.transactional)
    monkeypatch.setattr(core.firestore, 'Increment', credit_runtime.firestore.Increment)
    monkeypatch.setattr(core, 'UPLOAD_FOLDER', str(tmp_path))
    monkeypatch.setattr(core, 'submit_background_job', lambda target, *args, **kwargs: target(*args, **kwargs))
    monkeypatch.setattr(core, 'get_or_create_user', lambda uid, _email: state.store.docs('users')[uid])
    monkeypatch.setattr(core, 'get_batch_background_queue_stats', lambda: {'active': 0, 'capacity': 4})
    monkeypatch.setattr(core, 'get_saved_file_size', lambda path: Path(path).stat().st_size)
    monkeypatch.setattr(core, 'cleanup_files', lambda paths, _remote: [Path(path).unlink(missing_ok=True) for path in paths])
    monkeypatch.setattr(import_audio, 'cleanup_expired_audio_import_tokens', lambda **_kwargs: None)
    monkeypatch.setattr(import_audio, 'validate_video_import_fetch_target', lambda *_args, **_kwargs: ('https://example.test/media', ''))
    monkeypatch.setattr(core, 'submit_batch_background_job', lambda *_args, **_kwargs: state.submitted.append(True))

    def reserve(runtime, uid, _bytes, **kwargs):
        state.quota.append((uid, kwargs.get('context')))
        if state.failure == 'quota':
            return None, runtime.jsonify({'error': 'Quota unavailable'}), 429
        return SimpleNamespace(), None, 0

    def adjust(runtime, *_args, **_kwargs):
        if state.failure == 'adjust':
            return runtime.jsonify({'error': 'Storage unavailable'}), 503
        return None, 0

    monkeypatch.setattr(upload_quota_service, 'reserve_upload_quota', reserve)
    monkeypatch.setattr(upload_quota_service, 'adjust_reserved_upload_bytes', adjust)
    monkeypatch.setattr(upload_quota_service, 'commit_upload_quota', lambda *_args: None)
    monkeypatch.setattr(upload_quota_service, 'release_uncommitted_upload_quota', lambda *_args: None)

    def media_work(kind):
        with state.lock:
            state.media.append(kind)
            hold = state.hold == kind and not state.held
            if hold:
                state.held = True
        if hold:
            state.entered.set()
            assert state.release.wait(10), 'Test did not release its held media operation.'
        if state.failure == 'media':
            raise RuntimeError('Synthetic media failure')

    def download(_target, prefix):
        media_work('download')
        path = tmp_path / f'{prefix}.mp3'
        path.write_bytes(b'ID3 synthetic recording')
        return str(path), path.name, path.stat().st_size

    monkeypatch.setattr(core, 'download_audio_from_video_url', download)
    monkeypatch.setattr(core, 'convert_pptx_to_pdf', lambda *_args: pytest.fail('Queued batch must not convert on POST.'))

    def slide_bytes(extension):
        if extension.lower() == '.pdf':
            return b'%PDF-1.7 synthetic slides'
        output = io.BytesIO()
        with zipfile.ZipFile(output, 'w') as archive:
            archive.writestr('[Content_Types].xml', '<Types/>')
            archive.writestr('ppt/presentation.xml', '<presentation/>')
        return output.getvalue()

    def post(kind, uid='first', extension='.PPTX'):
        with app.test_client() as client:
            if kind == 'download':
                response = client.post('/api/tools/lecture-download', headers={'X-Test-Uid': uid, 'Accept': 'application/json'},
                                       json={'url': 'https://example.test/media', 'format': 'audio'})
            else:
                endpoint = '/api/instant-batch/jobs' if kind == 'instant' else '/api/batch/jobs'
                data = {
                    'mode': 'slides-only', 'batch_title': 'Synthetic batch',
                    'rows': json.dumps([{'row_id': 'row-1'}, {'row_id': 'row-2'}]),
                    'row_1_slides': (io.BytesIO(slide_bytes(extension)), f'first{extension}'),
                    'row_2_slides': (io.BytesIO(slide_bytes('.pdf')), 'second.pdf'),
                    # Unselected files must not make a PDF-only batch require conversion.
                    'unused_slides': (io.BytesIO(b'unselected slides'), 'unused.pptx'),
                }
                response = client.post(endpoint, headers={'X-Test-Uid': uid}, data=data)
            payload = response.get_json(silent=True)
            if kind == 'download' and response.status_code == 202:
                payload['worker_status'] = client.get(f"/api/tools/lecture-download/{payload['job_id']}", headers={'X-Test-Uid': uid}).get_json()['status']
            result = (response.status_code, dict(response.headers), payload)
            response.close()
            return result

    state.post = post
    yield state
    state.release.set()


@pytest.mark.parametrize('second_uid,expected', [('first', 429), ('other', 503)])
def test_held_download_rejects_second_download_before_quota_or_charge(media_requests, second_uid, expected):
    state = media_requests
    state.hold = 'download'
    with ThreadPoolExecutor(max_workers=1) as worker:
        first = worker.submit(state.post, 'download')
        try:
            assert state.entered.wait(5)
            before = (list(state.quota), list(state.charges), list(state.media))
            status, headers, payload = state.post('download', second_uid)
            assert status == expected
            assert headers['Retry-After'] == '5'
            assert payload == {'error': 'Media processing is busy. Please try again shortly.', 'retry_after_seconds': 5}
            assert (state.quota, state.charges, state.media) == before
        finally:
            state.release.set()
        assert first.result(timeout=5)[0] == 202
    assert state.post('download', second_uid)[0] == 202


@pytest.mark.parametrize('failure,expected', [('quota', 429), ('media', 400), ('adjust', 503)])
def test_failed_download_releases_process_and_account_admission(media_requests, failure, expected):
    state = media_requests
    state.failure = failure
    response = state.post('download')
    if failure != 'quota':
        assert response[0] == 202
        assert response[2]['worker_status'] == 'error'
    else:
        assert response[0] == expected
    state.failure = ''
    assert state.post('download')[0] == 202
    assert state.post('download', 'other')[0] == 202


@pytest.mark.parametrize('released_pool', ['download', 'conversion'])
def test_operation_pools_keep_independent_account_limits_and_releases(released_pool):
    acquire = {
        'download': media_admission.try_acquire,
        'conversion': media_admission.try_acquire_conversion,
    }
    leases = []
    try:
        for operation in acquire.values():
            lease, status = operation('same-owner')
            assert status == 0
            assert isinstance(lease, media_admission._MediaLease)
            leases.append(lease)
            assert operation('same-owner') == (None, 429)
            assert operation('another-owner') == (None, 503)
        lease = leases[0 if released_pool == 'download' else 1]
        lease.release()
        lease.release()
        remaining_pool = 'conversion' if released_pool == 'download' else 'download'
        assert acquire[remaining_pool]('same-owner') == (None, 429)
        assert acquire[remaining_pool]('another-owner') == (None, 503)
        replacement, status = acquire[released_pool]('same-owner')
        assert status == 0
        leases.append(replacement)
    finally:
        for lease in leases:
            lease.release()


@pytest.mark.parametrize('kind', ['batch', 'instant'])
@pytest.mark.parametrize('failure,expected', [('quota', 429), ('adjust', 503)])
def test_batch_staging_failure_leaves_media_admission_available(media_requests, kind, failure, expected):
    state = media_requests
    state.failure = failure
    assert state.post(kind)[0] == expected
    assert state.media == []
    state.failure = ''
    assert state.post('download')[0] == 202
    assert state.post(kind)[0] == 200


def test_batch_credit_preflight_leaves_media_admission_available(media_requests):
    state = media_requests
    state.store.documents[('users', 'first')]['slides_credits'] = 0
    assert state.post('batch')[0] == 402
    assert state.quota == []
    assert state.post('download')[0] == 202
    assert state.post('batch', 'other')[0] == 200


@pytest.mark.parametrize('kind', ['batch', 'instant'])
@pytest.mark.parametrize('uid', ['first', 'other'])
@pytest.mark.parametrize('extension', ['.pdf', '.PPTX'])
def test_batch_staging_does_not_need_media_admission(media_requests, kind, uid, extension):
    state = media_requests
    state.hold = 'download'
    with ThreadPoolExecutor(max_workers=1) as worker:
        first = worker.submit(state.post, 'download')
        try:
            assert state.entered.wait(5)
            assert state.post(kind, uid, extension=extension)[0] == 200
            assert state.media == ['download']
            assert len(state.charges) == 2
            assert state.store.docs('users')[uid]['slides_credits'] == 98
            assert all(item['charged'] == {'slides_credits': 1} for item in state.charges)
        finally:
            state.release.set()
        assert first.result(timeout=5)[0] == 202


@pytest.mark.parametrize('uid,expected', [('', 401), ('denied', 403), ('deleting', 409)])
@pytest.mark.parametrize('kind', ['download', 'batch'])
def test_existing_access_checks_run_before_media_admission(media_requests, kind, uid, expected):
    state = media_requests
    state.hold = 'download'
    with ThreadPoolExecutor(max_workers=1) as worker:
        first = worker.submit(state.post, 'download')
        try:
            assert state.entered.wait(5)
            assert state.post(kind, uid)[0] == expected
            assert len(state.quota) == 1
            assert state.charges == []
        finally:
            state.release.set()
        assert first.result(timeout=5)[0] == 202
