"""Durable heartbeats remain independent of later full-snapshot writes."""

import pytest

from lecture_processor.domains.runtime_jobs import store
from tests.test_runtime_job_retention import retention_state as retention_state


@pytest.mark.parametrize('status', ['processing', 'complete', 'error'])
def test_full_snapshot_does_not_move_the_durable_heartbeat_back(retention_state, status):
    state = retention_state
    old = store.set_job('job', {'status': 'processing', 'started_at': state.now,
                                'last_heartbeat_at': state.now}, runtime=state.runtime)
    state.now += 65
    store.update_job_fields('job', last_heartbeat_at=state.now, runtime=state.runtime)
    old.update(status=status, step_description='Later snapshot result')
    if status != 'processing':
        old['finished_at'] = state.now

    store.set_job('job', old, runtime=state.runtime)

    assert state.documents['job']['last_heartbeat_at'] == state.now
    assert state.documents['job']['status'] == status
    assert state.documents['job']['step_description'] == 'Later snapshot result'


def test_explicit_heartbeat_update_still_persists_without_copying_result(retention_state):
    state = retention_state
    store.set_job('job', {'status': 'processing', 'started_at': state.now, 'result': 'Large existing output'}, runtime=state.runtime)
    state.now += 35

    store.update_job_fields('job', last_heartbeat_at=state.now, runtime=state.runtime)

    assert state.documents['job']['last_heartbeat_at'] == state.now
    assert state.documents['job']['result'] == 'Large existing output'
    assert 'result' not in state.writes[-1]
    assert state.documents['job']['expires_at_ts'] is None


def test_full_snapshot_cannot_advance_the_heartbeat_without_an_explicit_update(retention_state):
    state = retention_state
    store.set_job('job', {'status': 'processing', 'started_at': state.now}, runtime=state.runtime)
    store.update_job_fields('job', last_heartbeat_at=state.now, runtime=state.runtime)
    snapshot = store.get_job_snapshot('job', runtime=state.runtime)
    snapshot['last_heartbeat_at'] = state.now + 500

    store.set_job('job', snapshot, runtime=state.runtime)

    assert state.documents['job']['last_heartbeat_at'] == state.now
    assert 'last_heartbeat_at' not in state.writes[-1]


def test_memory_only_full_snapshot_keeps_its_heartbeat(retention_state):
    state = retention_state
    state.runtime.db = None
    snapshot = store.set_job('job', {'status': 'processing', 'last_heartbeat_at': state.now}, runtime=state.runtime)
    assert snapshot['last_heartbeat_at'] == state.now
    assert store.get_job_snapshot('job', runtime=state.runtime)['last_heartbeat_at'] == state.now
    assert state.writes == []
