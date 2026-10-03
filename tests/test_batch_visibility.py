"""Visibility changes must never become processing or billing changes."""
from copy import deepcopy
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.account import lifecycle
from tests.test_batch_mode import core, _patch_batch_auth


@pytest.fixture
def batch_visibility(monkeypatch, allow_account_writes, runtime):
    _patch_batch_auth(monkeypatch)
    monkeypatch.setattr(core, 'db', None)
    original = {
        'batch_id': 'visibility-test', 'uid': 'u-batch', 'status': 'error',
        'mode': 'lecture-notes', 'processing_strategy': 'batch',
        'created_at': 10, 'updated_at': 20, 'last_heartbeat_at': 19,
        'credits_charged': 2, 'credits_refunded': 2, 'credits_refund_pending': 0,
        'total_rows': 2, 'completed_rows': 0, 'failed_rows': 2,
        'completion_email_status': 'sent', 'error_summary': 'Provider failed',
    }
    monkeypatch.setattr(core, '_BATCH_JOBS_MEMORY', {'visibility-test': deepcopy(original)}, raising=False)
    monkeypatch.setattr(core, '_BATCH_ROWS_MEMORY', {'visibility-test': {'r1': {'error': 'kept'}}}, raising=False)
    # Earlier API tests may initialize stores on AppRuntime itself. Seed both
    # bindings so these tests stay isolated regardless of collection order.
    monkeypatch.setattr(runtime, '_BATCH_JOBS_MEMORY', core._BATCH_JOBS_MEMORY, raising=False)
    monkeypatch.setattr(runtime, '_BATCH_ROWS_MEMORY', core._BATCH_ROWS_MEMORY, raising=False)
    return original


@pytest.mark.parametrize('strategy', ['batch', 'instant'])
@pytest.mark.parametrize('status', ['complete', 'partial', 'error'])
def test_archive_restore_is_additive_idempotent_and_stays_listed(client, batch_visibility, strategy, status):
    job = core._BATCH_JOBS_MEMORY['visibility-test']
    job.update(status=status, processing_strategy=strategy)
    before = deepcopy(job)
    path = '/api/batch/jobs/visibility-test/visibility'
    archived = client.patch(path, json={'archived': True})
    assert archived.status_code == 200
    stamp = archived.json['archived_at']
    assert stamp > 0
    assert client.patch(path, json={'archived': True}).json['archived_at'] == stamp
    assert {k: v for k, v in job.items() if k not in {'archived', 'archived_at'}} == before
    listed = client.get('/api/batch/jobs').json['batches']
    assert listed[0]['archived'] is True
    assert listed[0]['batch_id'] == 'visibility-test'
    assert client.patch(path, json={'archived': False}).json == {
        'batch_id': 'visibility-test', 'archived': False, 'archived_at': 0,
    }
    assert core._BATCH_ROWS_MEMORY['visibility-test'] == {'r1': {'error': 'kept'}}


@pytest.mark.parametrize('status', ['queued', 'processing', 'preparing'])
def test_active_batches_cannot_be_archived(client, batch_visibility, status):
    core._BATCH_JOBS_MEMORY['visibility-test']['status'] = status
    response = client.patch('/api/batch/jobs/visibility-test/visibility', json={'archived': True})
    assert response.status_code == 409
    assert 'archived' not in core._BATCH_JOBS_MEMORY['visibility-test']


@pytest.mark.parametrize('payload', [{}, {'archived': 'true'}, {'archived': 1}, {'archived': None}, {'archived': True, 'status': 'complete'}, []])
def test_visibility_rejects_invalid_payload(client, batch_visibility, payload):
    assert client.patch('/api/batch/jobs/visibility-test/visibility', json=payload).status_code == 400


def test_visibility_requires_owner_and_allows_no_admin_override(client, batch_visibility, monkeypatch):
    core._BATCH_JOBS_MEMORY['visibility-test']['uid'] = 'another-owner'
    assert client.patch('/api/batch/jobs/visibility-test/visibility', json={'archived': True}).status_code == 403
    assert client.patch('/api/batch/jobs/missing/visibility', json={'archived': True}).status_code == 404
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: None)
    assert client.patch('/api/batch/jobs/visibility-test/visibility', json={'archived': True}).status_code == 401


def test_visibility_respects_account_write_guard(client, batch_visibility, monkeypatch):
    monkeypatch.setattr(lifecycle, 'ensure_account_allows_writes', lambda *_a, **_k: (False, 'Account deletion in progress'))
    assert client.patch('/api/batch/jobs/visibility-test/visibility', json={'archived': True}).status_code == 409


def test_old_batches_default_to_unarchived(client, batch_visibility):
    batch = client.get('/api/batch/jobs').json['batches'][0]
    assert batch['archived'] is False
    assert batch['archived_at'] == 0


def test_firestore_visibility_reads_and_updates_in_one_transaction(batch_visibility, monkeypatch):
    record = deepcopy(batch_visibility)
    reads, writes = [], []
    transaction = SimpleNamespace(update=lambda ref, payload: writes.append((ref, payload)))
    ref = SimpleNamespace(get=lambda **kwargs: (reads.append(kwargs) or SimpleNamespace(exists=True, to_dict=lambda: record)))
    monkeypatch.setattr(core, 'db', SimpleNamespace(transaction=lambda: transaction))
    monkeypatch.setattr(core.batch_repo, 'batch_job_doc_ref', lambda _db, _id: ref)
    monkeypatch.setattr(core, 'firestore', SimpleNamespace(transactional=lambda fn: fn))
    payload, status = batch_orchestrator.set_batch_visibility('visibility-test', 'u-batch', True, runtime=core)
    assert status == 200
    assert reads == [{'transaction': transaction}]
    assert writes == [(ref, {'archived': True, 'archived_at': payload['archived_at']})]
    record['status'] = 'processing'
    assert batch_orchestrator.set_batch_visibility('visibility-test', 'u-batch', True, runtime=core)[1] == 409
    record['status'], record['uid'] = 'error', 'someone-else'
    assert batch_orchestrator.set_batch_visibility('visibility-test', 'u-batch', True, runtime=core)[1] == 403
    assert len(writes) == 1


@pytest.mark.parametrize('prefix', ['/batch_mode', '/instant_batch_mode'])
@pytest.mark.parametrize('suffix', ['', '_slides_extraction', '_interview_transcription', '_audio_transcription', '_text_combine'])
def test_legacy_links_redirect_to_focused_details(client, prefix, suffix):
    response = client.get(prefix + suffix + '?batch_id=batch-123')
    assert response.status_code == 302
    assert response.location == '/batch_status/batch-123'
    assert client.get(prefix + suffix).status_code == 200


def test_detail_shell_does_not_include_upload_form(client):
    response = client.get('/batch_status/batch-123')
    assert response.status_code == 200
    assert b'id="batch-detail"' in response.data
    assert b'id="batch-form"' not in response.data
