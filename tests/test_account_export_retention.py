from copy import deepcopy
from datetime import datetime, timezone
import io
import os
from pathlib import Path
import zipfile

import pytest

from lecture_processor.domains.runtime_jobs import store
from lecture_processor.runtime import core
from lecture_processor.services import account_data_service
from tests.test_runtime_job_retention import bind_cleanup, retention_state as retention_state


@pytest.fixture
def completed_export(client, retention_state, monkeypatch, tmp_path):
    state = retention_state
    bind_cleanup(monkeypatch, state)
    monkeypatch.setattr(core, 'db', state.runtime.db)
    monkeypatch.setattr(core, 'runtime_jobs_repo', state.runtime.runtime_jobs_repo)
    monkeypatch.setattr(core, 'UPLOAD_FOLDER', str(tmp_path))
    state.uid = 'export-owner'
    monkeypatch.setattr(core, 'verify_firebase_token', lambda *_args, **_kwargs: {
        'uid': state.uid, 'email': 'export@example.com', 'auth_time': state.now,
    })
    monkeypatch.setattr(core, 'is_email_allowed', lambda _email: True)

    def build_archive(*_args):
        archive = io.BytesIO()
        with zipfile.ZipFile(archive, 'w') as output:
            output.writestr('account_json/account-export.json', '{"synthetic": true}')
        archive.seek(0)
        return archive, 'account-export.zip'

    monkeypatch.setattr(account_data_service, '_build_account_bundle_archive', build_archive)
    submitted = []
    monkeypatch.setattr(core, 'submit_background_job', lambda target, *args: submitted.append((target, args)))
    response = client.post('/api/account/export-bundle', json={
        'scope': 'account', 'include': {'account_json': True},
    }, headers={'Authorization': 'Bearer synthetic'})
    assert response.status_code == 202
    state.urls = response.get_json()
    state.job_id = state.urls['job_id']
    assert state.documents[state.job_id]['status'] == 'queued'
    assert state.documents[state.job_id]['expires_at_ts'] is None
    target, args = submitted.pop()
    target(*args)
    assert state.documents[state.job_id]['status'] == 'completed'
    state.finished_at = state.now
    state.path = Path(state.documents[state.job_id]['export_path'])
    # The synthetic clock also controls the file-age boundary used by cleanup.
    os.utime(state.path, (state.now, state.now))
    state.client = client
    return state


@pytest.mark.parametrize('elapsed', [1801, 2700, 3599])
@pytest.mark.parametrize('restart', [False, True], ids=['memory', 'restart'])
def test_completed_export_remains_downloadable_for_the_zip_lifetime(completed_export, elapsed, restart):
    state = completed_export
    state.now += elapsed
    if restart:
        state.runtime.jobs.clear()
        assert store.get_job_snapshot(state.job_id, runtime=state.runtime)['status'] == 'completed'
    core.cleanup_old_jobs()
    account_data_service._cleanup_expired_account_exports(core)

    response = state.client.get(state.urls['status_url'], headers={'Authorization': 'Bearer synthetic'})
    assert response.status_code == 200
    assert response.get_json()['status'] == 'completed'
    download = state.client.get(state.urls['download_url'], headers={'Authorization': 'Bearer synthetic'})
    assert download.status_code == 200
    assert download.mimetype == 'application/zip'
    with zipfile.ZipFile(io.BytesIO(download.data)) as archive:
        assert archive.read('account_json/account-export.json') == b'{"synthetic": true}'
    deadline = state.finished_at + account_data_service.ACCOUNT_EXPORT_FILE_TTL_SECONDS
    assert state.documents[state.job_id]['expires_at_ts'] == datetime.fromtimestamp(deadline, tz=timezone.utc)
    assert state.runtime.jobs[state.job_id]['expires_at_ts'].timestamp() == deadline
    state.uid = 'another-user'
    assert state.client.get(state.urls['download_url'], headers={'Authorization': 'Bearer synthetic'}).status_code == 404


@pytest.mark.parametrize('restart', [False, True], ids=['memory', 'restart'])
def test_completed_export_job_and_zip_expire_after_the_same_deadline(completed_export, restart):
    state = completed_export
    state.now += account_data_service.ACCOUNT_EXPORT_FILE_TTL_SECONDS
    if restart:
        state.runtime.jobs.clear()
        store.get_job_snapshot(state.job_id, runtime=state.runtime)
    core.cleanup_old_jobs()
    account_data_service._cleanup_expired_account_exports(core)
    assert state.job_id in state.runtime.jobs
    assert state.job_id in state.documents
    assert state.path.exists()

    state.now += 1
    core.cleanup_old_jobs()
    account_data_service._cleanup_expired_account_exports(core)
    assert state.job_id not in state.runtime.jobs
    assert state.job_id not in state.documents
    assert not state.path.exists()
    assert state.client.get(state.urls['status_url'], headers={'Authorization': 'Bearer synthetic'}).status_code == 404
    assert state.client.get(state.urls['download_url'], headers={'Authorization': 'Bearer synthetic'}).status_code == 404
    core.cleanup_old_jobs()
    assert state.deleted == [state.job_id]


def test_legacy_export_without_a_persisted_deadline_uses_the_file_lifetime(retention_state, monkeypatch):
    state = retention_state
    bind_cleanup(monkeypatch, state)
    state.documents['legacy-export'] = {
        'job_scope': 'account-export', 'status': 'completed', 'finished_at': state.now,
    }
    original = deepcopy(state.documents['legacy-export'])
    state.now += 2700
    store.get_job_snapshot('legacy-export', runtime=state.runtime)
    core.cleanup_old_jobs()
    assert state.documents['legacy-export'] == original
    assert state.writes == []
    assert 'legacy-export' in state.runtime.jobs
    state.now += 901
    core.cleanup_old_jobs()
    assert state.runtime.jobs == state.documents == {}


@pytest.mark.parametrize('finished_at', [None, 0, -1, 'invalid', float('nan'), float('inf'), 1e300])
def test_invalid_export_completion_time_gets_a_bounded_stable_deadline(retention_state, monkeypatch, finished_at):
    state = retention_state
    bind_cleanup(monkeypatch, state)
    store.set_job('export', {
        'job_scope': 'account-export', 'status': 'completed',
        'started_at': 1, 'finished_at': finished_at,
    }, runtime=state.runtime)
    deadline = state.now + account_data_service.ACCOUNT_EXPORT_FILE_TTL_SECONDS
    assert state.documents['export']['expires_at_ts'].timestamp() == deadline
    state.now += 2700
    state.runtime.jobs.clear()
    store.get_job_snapshot('export', runtime=state.runtime)
    store.update_job_fields('export', step_description='Ready', runtime=state.runtime)
    core.cleanup_old_jobs()
    assert state.documents['export']['expires_at_ts'].timestamp() == deadline
    state.now = deadline + 1
    core.cleanup_old_jobs()
    assert state.runtime.jobs == state.documents == {}


@pytest.mark.parametrize('status', ['queued', 'starting', 'processing'])
def test_active_export_never_receives_terminal_retention(retention_state, monkeypatch, status):
    state = retention_state
    bind_cleanup(monkeypatch, state)
    snapshot = store.set_job('active-export', {
        'job_scope': 'account-export', 'status': status, 'started_at': 1,
    }, runtime=state.runtime)
    assert snapshot['expires_at_ts'] is None
    state.now += 7200
    state.runtime.jobs.clear()
    assert store.get_job_snapshot('active-export', runtime=state.runtime)['expires_at_ts'] is None
    core.cleanup_old_jobs()
    assert 'active-export' in state.documents
    assert 'active-export' in state.runtime.jobs


@pytest.mark.parametrize('job_scope,status', [
    ('lecture', 'complete'), ('lecture', 'completed'), ('lecture', 'error'), ('account-export', 'error'),
])
def test_other_terminal_jobs_keep_the_configured_thirty_minute_lifetime(retention_state, monkeypatch, job_scope, status):
    state = retention_state
    bind_cleanup(monkeypatch, state)
    store.set_job('ordinary', {'job_scope': job_scope, 'status': status, 'finished_at': state.now}, runtime=state.runtime)
    assert state.documents['ordinary']['expires_at_ts'].timestamp() == state.now + 1800
    state.now += 1800
    core.cleanup_old_jobs()
    assert 'ordinary' in state.documents
    state.now += 1
    core.cleanup_old_jobs()
    assert state.runtime.jobs == state.documents == {}
