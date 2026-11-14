from copy import deepcopy
from datetime import datetime, timezone
import json
from pathlib import Path
from threading import RLock
from types import SimpleNamespace

import pytest

from lecture_processor.domains.runtime_jobs import store
from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.runtime import core
from lecture_processor.services import job_state_service


@pytest.fixture
def retention_state():
    state = SimpleNamespace(now=10000.0, documents={}, writes=[], deleted=[])

    def set_doc(_db, _collection, job_id, payload, merge=False):
        if not merge:
            state.documents[job_id] = {}
        state.documents.setdefault(job_id, {}).update(deepcopy(payload))
        state.writes.append(deepcopy(payload))

    def get_doc(_db, _collection, job_id):
        payload = deepcopy(state.documents.get(job_id))
        return SimpleNamespace(exists=payload is not None, to_dict=lambda: deepcopy(payload))

    def delete_doc(_db, _collection, job_id):
        state.deleted.append(job_id)
        state.documents.pop(job_id, None)

    state.runtime = SimpleNamespace(
        db=object(), jobs={}, JOBS_LOCK=RLock(), JOB_TTL_SECONDS=1800,
        time=SimpleNamespace(time=lambda: state.now),
        RUNTIME_JOBS_COLLECTION='runtime_jobs',
        RUNTIME_JOB_PERSISTED_FIELDS=PERSISTED_RUNTIME_JOB_FIELDS,
        job_state_service=job_state_service,
        runtime_jobs_repo=SimpleNamespace(set_doc=set_doc, get_doc=get_doc, delete_doc=delete_doc),
        logger=SimpleNamespace(warning=lambda *_args, **_kwargs: None),
    )
    return state


@pytest.mark.parametrize('status', ['complete', 'completed', 'error'])
def test_terminal_snapshots_persist_a_utc_expiration_from_completion(retention_state, status):
    state = retention_state
    snapshot = store.set_job('terminal', {'status': status, 'finished_at': 9900.0}, runtime=state.runtime)

    expected = datetime.fromtimestamp(11700.0, tz=timezone.utc)
    assert state.documents['terminal']['expires_at_ts'] == expected
    assert snapshot['expires_at_ts'] == expected
    assert snapshot['expires_at_ts'].tzinfo is timezone.utc


@pytest.mark.parametrize('status', ['queued', 'starting', 'processing'])
def test_active_snapshots_have_no_expiration(retention_state, status):
    state = retention_state
    store.set_job('active', {'status': status, 'started_at': 1.0}, runtime=state.runtime)
    assert state.documents['active'].get('expires_at_ts') is None


def test_partial_terminal_updates_keep_the_deadline_and_do_not_rewrite_results(retention_state):
    state = retention_state
    store.set_job('terminal', {'status': 'complete', 'finished_at': 9900.0, 'result': 'saved content'}, runtime=state.runtime)
    original = state.documents['terminal']['expires_at_ts']
    state.now += 600
    store.update_job_fields('terminal', step_description='Ready', runtime=state.runtime)

    assert state.documents['terminal']['expires_at_ts'] == original
    assert 'result' not in state.writes[-1]
    assert state.documents['terminal']['result'] == 'saved content'


def test_missing_completion_time_uses_now_and_keeps_that_deadline(retention_state):
    state = retention_state
    store.set_job('long-job', {'status': 'processing', 'started_at': 1.0}, runtime=state.runtime)
    first = store.update_job_fields('long-job', status='complete', runtime=state.runtime)
    expected = datetime.fromtimestamp(11800.0, tz=timezone.utc)
    assert first['expires_at_ts'] == expected

    state.now += 200
    store.update_job_fields('long-job', step_description='Ready', runtime=state.runtime)
    store.mutate_job('long-job', lambda job: job.update(credit_refunded=True), runtime=state.runtime)
    assert state.documents['long-job']['expires_at_ts'] == expected


def test_later_completion_time_replaces_the_provisional_deadline(retention_state):
    state = retention_state
    store.set_job('terminal', {'status': 'complete'}, runtime=state.runtime)
    state.now += 25
    store.update_job_fields('terminal', finished_at=state.now, runtime=state.runtime)
    expected = datetime.fromtimestamp(11825.0, tz=timezone.utc)
    assert state.documents['terminal']['expires_at_ts'] == expected
    state.now += 50
    store.update_job_fields('terminal', step=3, runtime=state.runtime)
    assert state.documents['terminal']['expires_at_ts'] == expected


def test_snapshot_deadline_survives_a_restart_and_subsequent_update(retention_state):
    state = retention_state
    store.set_job('terminal', {'status': 'completed', 'job_scope': 'account-export'}, runtime=state.runtime)
    original = state.documents['terminal']['expires_at_ts']
    state.runtime.jobs.clear()
    state.now += 500
    restored = store.get_job_snapshot('terminal', runtime=state.runtime)
    assert restored['expires_at_ts'] == original
    store.update_job_fields('terminal', step_description='Ready', runtime=state.runtime)
    assert state.documents['terminal']['expires_at_ts'] == original


@pytest.mark.parametrize('status', ['queued', 'starting', 'processing'])
def test_returning_to_an_active_state_clears_the_persisted_expiry(retention_state, status):
    state = retention_state
    old_expiry = datetime.fromtimestamp(state.now - 1, tz=timezone.utc)
    store.set_job('retry', {'status': 'error', 'expires_at_ts': old_expiry}, runtime=state.runtime)
    store.update_job_fields('retry', status=status, runtime=state.runtime)
    assert state.documents['retry']['expires_at_ts'] is None
    assert state.runtime.jobs['retry']['expires_at_ts'] is None


def test_direct_completion_time_update_includes_the_expiration(retention_state):
    state = retention_state
    store.persist_runtime_job_snapshot(
        'terminal', {'status': 'complete', 'finished_at': 9900.0, 'step': 3, 'result': 'large content'},
        changed_fields={'step', 'finished_at'}, runtime=state.runtime,
    )
    assert state.documents['terminal']['expires_at_ts'].timestamp() == 11700.0
    assert 'result' not in state.writes[-1]


def test_delayed_heartbeat_cannot_clear_a_terminal_deadline(retention_state):
    state = retention_state
    active = store.set_job('job', {'status': 'processing', 'last_heartbeat_at': state.now}, runtime=state.runtime)
    delayed_heartbeat = dict(active, last_heartbeat_at=state.now + 1)
    state.now += 2
    store.update_job_fields('job', status='complete', finished_at=state.now, runtime=state.runtime)
    terminal_deadline = state.documents['job']['expires_at_ts']

    store.persist_runtime_job_snapshot(
        'job', delayed_heartbeat, changed_fields={'last_heartbeat_at'}, runtime=state.runtime,
    )
    assert state.documents['job']['status'] == 'complete'
    assert state.documents['job']['expires_at_ts'] == terminal_deadline
    assert 'expires_at_ts' not in state.writes[-1]


def test_updating_a_legacy_terminal_snapshot_adds_its_derived_deadline(retention_state):
    state = retention_state
    state.documents['legacy'] = {'status': 'completed', 'finished_at': 9900.0}
    store.get_job_snapshot('legacy', runtime=state.runtime)
    store.update_job_fields('legacy', step_description='Ready', runtime=state.runtime)
    assert state.documents['legacy']['expires_at_ts'].timestamp() == 11700.0


def test_local_only_terminal_job_still_receives_a_deadline(retention_state):
    state = retention_state
    state.runtime.db = None
    snapshot = store.set_job('local', {'status': 'completed'}, runtime=state.runtime)
    assert snapshot['expires_at_ts'].timestamp() == 11800.0
    assert state.writes == []


def bind_cleanup(monkeypatch, state):
    monkeypatch.setattr(core, 'jobs', state.runtime.jobs)
    monkeypatch.setattr(core, 'JOBS_LOCK', state.runtime.JOBS_LOCK)
    monkeypatch.setattr(core, 'JOB_TTL_SECONDS', state.runtime.JOB_TTL_SECONDS)
    monkeypatch.setattr(core, 'time', state.runtime.time)
    monkeypatch.setattr(core, 'delete_runtime_job_snapshot', lambda job_id: store.delete_runtime_job_snapshot(job_id, runtime=state.runtime))


@pytest.mark.parametrize('status', ['complete', 'completed', 'error'])
def test_cleanup_removes_expired_terminal_snapshots_and_keeps_other_jobs(retention_state, monkeypatch, status):
    state = retention_state
    bind_cleanup(monkeypatch, state)
    store.set_job('old', {'status': status, 'finished_at': 8000.0}, runtime=state.runtime)
    store.set_job('fresh', {'status': status, 'finished_at': 9999.0}, runtime=state.runtime)
    store.set_job('active', {'status': 'processing', 'started_at': 1.0}, runtime=state.runtime)
    core.cleanup_old_jobs()
    assert set(state.runtime.jobs) == {'fresh', 'active'}
    assert set(state.documents) == {'fresh', 'active'}
    assert state.deleted == ['old']


def test_cleanup_uses_the_completion_deadline_for_a_long_job(retention_state, monkeypatch):
    state = retention_state
    bind_cleanup(monkeypatch, state)
    store.set_job('long-job', {'status': 'complete', 'started_at': 1.0}, runtime=state.runtime)
    core.cleanup_old_jobs()
    assert 'long-job' in state.runtime.jobs
    state.now += 1801
    core.cleanup_old_jobs()
    assert state.runtime.jobs == {}
    assert state.documents == {}


def test_reading_a_legacy_snapshot_does_not_backfill_or_delete_it(retention_state):
    state = retention_state
    legacy = {'status': 'complete', 'finished_at': 1.0, 'result': 'saved legacy output'}
    state.documents['legacy'] = deepcopy(legacy)
    snapshot = store.get_job_snapshot('legacy', runtime=state.runtime)
    assert 'expires_at_ts' not in snapshot
    assert state.documents['legacy'] == legacy
    assert state.writes == []
    assert state.deleted == []


def test_runtime_snapshot_ttl_is_enabled_without_a_single_field_index():
    config = json.loads((Path(__file__).resolve().parents[1] / 'firestore.indexes.json').read_text())
    overrides = [entry for entry in config['fieldOverrides']
                 if entry['collectionGroup'] == 'runtime_jobs' and entry['fieldPath'] == 'expires_at_ts']
    assert len(overrides) == 1
    assert overrides[0]['ttl'] is True
    assert overrides[0]['indexes'] == []


@pytest.mark.parametrize('pending', [
    {'credit_refund_pending': True, 'credit_refund_error': 'credit_refund_failed'},
    {'extra_slides_refund_pending': 2},
])
@pytest.mark.parametrize('status', ['error', 'complete'])
def test_pending_refund_survives_restart_and_cleanup_until_settled(retention_state, monkeypatch, pending, status):
    state = retention_state
    bind_cleanup(monkeypatch, state)
    store.set_job('pending-refund', {'status': status, 'finished_at': 1.0, **pending}, runtime=state.runtime)
    assert state.documents['pending-refund']['expires_at_ts'] is None
    assert all(state.documents['pending-refund'][key] == value for key, value in pending.items())
    state.runtime.jobs.clear()
    restored = store.get_job_snapshot('pending-refund', runtime=state.runtime)
    assert all(restored[key] == value for key, value in pending.items())
    core.cleanup_old_jobs()
    assert 'pending-refund' in state.documents
    assert 'pending-refund' in state.runtime.jobs

    store.update_job_fields('pending-refund', runtime=state.runtime,
                            credit_refund_pending=False, credit_refund_error='', extra_slides_refund_pending=0)
    assert state.documents['pending-refund']['expires_at_ts'].timestamp() == 1801.0
    core.cleanup_old_jobs()
    assert 'pending-refund' not in state.documents
    assert state.deleted == ['pending-refund']


@pytest.mark.parametrize('field,value', [('credit_refund_pending', True), ('extra_slides_refund_pending', 1)])
def test_late_pending_refund_marker_clears_previously_written_expiry(retention_state, field, value):
    state = retention_state
    snapshot = store.set_job('terminal', {'status': 'error', 'finished_at': state.now}, runtime=state.runtime)
    assert snapshot['expires_at_ts'] is not None
    store.update_job_fields('terminal', runtime=state.runtime, **{field: value})
    assert state.documents['terminal']['expires_at_ts'] is None


def test_direct_pending_refund_update_clears_expiry_without_rewriting_result(retention_state):
    state = retention_state
    job = store.set_job('terminal', {'status': 'error', 'finished_at': state.now, 'result': 'saved'}, runtime=state.runtime)
    store.persist_runtime_job_snapshot('terminal', dict(job, credit_refund_pending=True),
                                       changed_fields={'credit_refund_pending'}, runtime=state.runtime)
    assert state.documents['terminal']['expires_at_ts'] is None
    assert 'result' not in state.writes[-1]
