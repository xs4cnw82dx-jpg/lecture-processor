"""Download compatibility responses and bounded artifact cleanup work."""

from copy import deepcopy
import os
from types import SimpleNamespace
import uuid

import pytest

from lecture_processor.domains.rate_limit import limiter
from lecture_processor.services import tools_download_service
from tests.test_background_lecture_download import downloads as downloads


_REAL_RATE_LIMIT_CHECK = limiter.check_rate_limit


def enable_one_request_window(state, monkeypatch):
    monkeypatch.setattr(limiter, 'check_rate_limit', _REAL_RATE_LIMIT_CHECK)
    monkeypatch.setattr(state.core, 'VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS', 1)
    monkeypatch.setattr(state.core, 'VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS', 3600)


def test_legacy_refresh_prompts_do_not_consume_the_download_rate_limit(downloads, monkeypatch):
    enable_one_request_window(downloads, monkeypatch)
    for _ in range(3):
        response = downloads.post(headers={'Accept': '*/*'})
        assert response.status_code == 409
        assert response.get_json() == {'error': 'Please refresh this page before starting a download.'}
    assert downloads.core.RATE_LIMIT_EVENTS == {}
    assert downloads.queued == downloads.media == downloads.reserved == []

    assert downloads.post().status_code == 202
    assert len(downloads.core.RATE_LIMIT_EVENTS['lecture_download:owner']) == 1
    assert downloads.post().status_code == 429
    assert len(downloads.queued) == 1


def test_json_downloads_still_consume_and_obey_the_rate_limit(downloads, monkeypatch):
    enable_one_request_window(downloads, monkeypatch)
    assert downloads.post().status_code == 202
    response = downloads.post()
    assert response.status_code == 429
    assert int(response.headers['Retry-After']) > 0
    assert len(downloads.core.RATE_LIMIT_EVENTS['lecture_download:owner']) == 1
    assert len(downloads.queued) == len(downloads.reserved) == 1


@pytest.mark.parametrize('guard,expected_status', [('signed_out', 401), ('email', 403), ('deleting', 409)])
def test_legacy_response_does_not_bypass_account_guards(downloads, monkeypatch, guard, expected_status):
    enable_one_request_window(downloads, monkeypatch)
    headers = {'Accept': '*/*'}
    if guard == 'signed_out':
        headers['X-Test-Uid'] = ''
    elif guard == 'email':
        monkeypatch.setattr(downloads.core, 'is_email_allowed', lambda _email: False)
    else:
        downloads.deleting = True
    response = downloads.post(headers=headers)
    assert response.status_code == expected_status
    assert response.get_json()['error'] != 'Please refresh this page before starting a download.'
    assert downloads.core.RATE_LIMIT_EVENTS == {}
    assert downloads.queued == downloads.media == downloads.reserved == []


@pytest.fixture
def cleanup_state(downloads, monkeypatch, tmp_path):
    state = downloads
    state.now = 10000
    state.documents = {}
    state.reads = []
    state.scans = []
    state.read_errors = set()
    state.next_id = 1
    monkeypatch.setattr(state.core, 'time', SimpleNamespace(time=lambda: state.now))
    monkeypatch.setattr(state.core, 'db', object())

    def get_doc(_db, _collection, job_id):
        state.reads.append(job_id)
        if job_id in state.read_errors:
            raise RuntimeError('Synthetic durable read failure')
        value = deepcopy(state.documents.get(job_id))
        return SimpleNamespace(exists=value is not None, to_dict=lambda: value)

    monkeypatch.setattr(state.core.runtime_jobs_repo, 'get_doc', get_doc)
    isolated_os = SimpleNamespace(**vars(os))

    def listdir(path):
        state.scans.append(path)
        return os.listdir(path)

    isolated_os.listdir = listdir
    monkeypatch.setattr(state.core, 'os', isolated_os)

    def make_job(*, cached=False, status='complete', expires_at=1, scope='lecture_download', age=3600, count=3):
        job_id = str(uuid.UUID(int=state.next_id))
        state.next_id += 1
        job = {
            'job_scope': scope, 'status': status,
            'result': {'download': {'expires_at': expires_at}},
        }
        state.documents[job_id] = deepcopy(job)
        if cached:
            state.core.jobs[job_id] = deepcopy(job)
        paths = []
        for index in range(count):
            path = tmp_path / f'{job_id}_tooldownload_{index}.mp3'
            path.write_bytes(b'synthetic media')
            os.utime(path, (state.now - age, state.now - age))
            paths.append(path)
        return job_id, paths

    state.make_job = make_job
    return state


@pytest.mark.parametrize('cached', [True, False], ids=['cached', 'restart'])
def test_one_directory_scan_cleans_many_terminal_jobs(cleanup_state, cached):
    state = cleanup_state
    groups = [state.make_job(cached=cached) for _ in range(24)]
    tools_download_service.cleanup_expired_downloads(state.core)
    assert all(not path.exists() for _job_id, paths in groups for path in paths)
    assert len(state.scans) == 1
    expected_reads = [] if cached else [job_id for job_id, _paths in groups]
    assert sorted(state.reads) == sorted(expected_reads)


@pytest.mark.parametrize('kind', ['queued', 'starting', 'processing', 'unexpired', 'foreign', 'read_error'])
def test_restart_cleanup_preserves_protected_artifacts_with_one_lookup(cleanup_state, kind):
    state = cleanup_state
    status = kind if kind in {'queued', 'starting', 'processing'} else 'complete'
    scope = 'account-export' if kind == 'foreign' else 'lecture_download'
    expires_at = state.now + 100 if kind == 'unexpired' else 1
    job_id, paths = state.make_job(status=status, scope=scope, expires_at=expires_at)
    if kind == 'read_error':
        state.read_errors.add(job_id)
    tools_download_service.cleanup_expired_downloads(state.core)
    assert all(path.exists() for path in paths)
    assert state.reads == [job_id]
    assert len(state.scans) == 1


@pytest.mark.parametrize('status', ['queued', 'starting', 'processing', 'complete'])
def test_cached_active_or_unexpired_jobs_keep_their_artifacts(cleanup_state, status):
    state = cleanup_state
    _job_id, paths = state.make_job(cached=True, status=status, expires_at=state.now + 100)
    tools_download_service.cleanup_expired_downloads(state.core)
    assert all(path.exists() for path in paths)
    assert state.reads == []
    assert len(state.scans) == 1


def test_restart_cleanup_requires_old_download_marker_before_a_lookup(cleanup_state, tmp_path):
    state = cleanup_state
    _fresh_id, fresh_paths = state.make_job(age=10)
    other_id = str(uuid.UUID(int=999))
    unmarked = tmp_path / f'{other_id}_partial.mp3'
    unmarked.write_bytes(b'unrelated partial upload')
    os.utime(unmarked, (1, 1))
    tools_download_service.cleanup_expired_downloads(state.core)
    assert all(path.exists() for path in fresh_paths)
    assert unmarked.exists()
    assert state.reads == []
    assert len(state.scans) == 1


@pytest.mark.parametrize('cached', [True, False], ids=['cached', 'restart'])
def test_cleanup_preserves_symlinks_and_unrelated_prefixes(cleanup_state, tmp_path, cached):
    state = cleanup_state
    job_id, owned_paths = state.make_job(cached=cached)
    outside = tmp_path.parent / f'{job_id}_outside.mp3'
    outside.write_bytes(b'outside protected data')
    linked = tmp_path / f'{job_id}_tooldownload_link.mp3'
    linked.symlink_to(outside)
    other_prefix = tmp_path / f'{job_id}-other_tooldownload.mp3'
    other_prefix.write_bytes(b'other protected data')
    os.utime(other_prefix, (1, 1))
    tools_download_service.cleanup_expired_downloads(state.core)
    assert all(not path.exists() for path in owned_paths)
    assert linked.is_symlink()
    assert outside.read_bytes() == b'outside protected data'
    assert other_prefix.read_bytes() == b'other protected data'


def test_missing_durable_job_can_remove_its_old_artifacts(cleanup_state):
    state = cleanup_state
    job_id, paths = state.make_job()
    state.documents.pop(job_id)
    tools_download_service.cleanup_expired_downloads(state.core)
    assert all(not path.exists() for path in paths)
    assert state.reads == [job_id]
