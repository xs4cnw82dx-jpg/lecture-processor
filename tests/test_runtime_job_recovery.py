from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from lecture_processor.domains.runtime_jobs import recovery
from lecture_processor.services import upload_runtime_service
from tests.support.runtime_job_recovery import add_job


def test_default_stale_bound_is_independent_of_recovery_lease(recovery_state):
    state = recovery_state
    runtime = state['runtime']
    runtime.RUNTIME_JOB_RECOVERY_LEASE_SECONDS = 3600
    job = add_job(state, last_heartbeat_at=820.0)

    assert recovery._runtime_job_recovery_stale_seconds(runtime=runtime) == 180
    assert recovery._runtime_job_is_stale(job, now_ts=999.0, runtime=runtime) is False
    assert recovery._runtime_job_is_stale(job, now_ts=1000.0, runtime=runtime) is True


def test_periodic_pass_recovers_job_that_was_fresh_at_startup_once(recovery_state):
    state = recovery_state
    runtime = state['runtime']
    add_job(state, last_heartbeat_at=950.0)

    recovery.run_startup_recovery_once(runtime=runtime)
    assert state['refunds'] == []
    state['now'] = 1140.0
    assert recovery.run_periodic_recovery(runtime=runtime) == 1
    assert recovery.run_periodic_recovery(runtime=runtime) == 0
    assert state['lease_calls'] == 3
    assert state['durable']['job']['status'] == 'error'
    assert state['durable']['job']['billing_receipt']['refunded'] == {'lecture_credits_standard': 1, 'slides_credits': 1}
    assert [entry[2] for entry in state['refunds']] == ['runtime-job:job:primary', 'runtime-job:job:extras']
    assert len(state['logs']) == 1


@pytest.mark.parametrize('disabled', [True, False])
def test_periodic_pass_respects_enabled_flag_and_existing_lease(recovery_state, disabled):
    state = recovery_state
    add_job(state)
    state['runtime'].RUNTIME_JOB_RECOVERY_ENABLED = not disabled
    state['lease_available'] = False

    assert recovery.run_periodic_recovery(runtime=state['runtime']) == 0
    assert state['lease_calls'] == (0 if disabled else 1)
    assert state['queries'] == 0
    assert state['refunds'] == []


@pytest.mark.parametrize('status', ['queued', 'starting', 'processing'])
def test_locally_active_jobs_are_not_recovered_by_scan(recovery_state, status):
    state = recovery_state
    add_job(state, status=status)
    state['active'].add('job')

    assert recovery.recover_stale_runtime_jobs(runtime=state['runtime']) == 0
    assert state['transaction_reads'] == 0
    assert state['refunds'] == []
    assert state['durable']['job']['status'] == status


def test_claim_rechecks_local_activity_inside_transaction(recovery_state):
    state = recovery_state
    add_job(state)
    state['before_transaction_read'] = lambda: state['active'].add('job')

    assert recovery.recover_stale_runtime_jobs(runtime=state['runtime']) == 0
    assert state['transaction_reads'] == 1
    assert state['refunds'] == []


@pytest.mark.parametrize('change', ['heartbeat', 'terminal'])
def test_transaction_reread_protects_job_changed_after_cached_snapshot(recovery_state, change):
    state = recovery_state
    add_job(state)
    def refresh():
        state['durable']['job'].update({'last_heartbeat_at': state['now']} if change == 'heartbeat' else {'status': 'complete'})
    state['before_transaction_read'] = refresh

    assert recovery.recover_runtime_job_if_stale('job', runtime=state['runtime']) is False
    assert state['transaction_reads'] == 1
    assert state['refunds'] == []


def test_owner_status_read_recovers_and_returns_updated_snapshot(recovery_state):
    state = recovery_state
    add_job(state)

    response = upload_runtime_service.get_status(state['runtime'], object(), 'job')

    assert response['status'] == 'error'
    assert response['credit_refunded'] is True
    assert response['billing_receipt']['refunded'] == {'lecture_credits_standard': 1, 'slides_credits': 1}
    assert state['transaction_reads'] == 1
    assert recovery.recover_runtime_job_if_stale('job', runtime=state['runtime']) is False
    assert len(state['refunds']) == 2


def test_claim_blocks_second_recovery_while_first_refund_is_in_flight(recovery_state, monkeypatch):
    state = recovery_state
    add_job(state)
    refund_started = Event()
    finish_refund = Event()

    def refund(uid, credit_type, target_units, refund_ref, **kwargs):
        refund_started.set()
        assert finish_refund.wait(timeout=2)
        kwargs['runtime'] = state['credit_runtime']
        result = state['compatibility_refund'](uid, credit_type, target_units, refund_ref, **kwargs)
        state['refunds'].append((uid, (credit_type, target_units), refund_ref))
        return result

    monkeypatch.setattr(recovery.job_charges.ledger, 'refund_legacy_credits', refund)

    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(recovery.recover_runtime_job_if_stale, 'job', runtime=state['runtime'])
        try:
            assert refund_started.wait(timeout=2)
            assert recovery.recover_runtime_job_if_stale('job', runtime=state['runtime']) is False
            assert state['refunds'] == []
            assert state['logs'] == []
        finally:
            finish_refund.set()
        assert first.result(timeout=2) is True
    assert len(state['refunds']) == 2
    assert len(state['logs']) == 1
    assert state['credit_store'].docs('users')['owner']['lecture_credits_standard'] == 1
    assert state['credit_store'].docs('users')['owner']['slides_credits'] == 1
    assert len(state['credit_store'].docs('credit_refunds')) == 2


@pytest.mark.parametrize('protected_by', ['local-registry', 'fresh-heartbeat'])
def test_status_read_of_active_job_does_not_query_recovery(recovery_state, protected_by):
    state = recovery_state
    add_job(state)
    if protected_by == 'local-registry':
        state['active'].add('job')
    else:
        state['memory']['job']['last_heartbeat_at'] = state['now']
        state['durable']['job']['last_heartbeat_at'] = state['now']

    response = upload_runtime_service.get_status(state['runtime'], object(), 'job')

    assert response['status'] == 'processing'
    assert state['reads'] == 0
    assert state['transaction_reads'] == 0
    assert state['refunds'] == []


@pytest.mark.parametrize('viewer', [None, 'other-owner'])
def test_status_read_authorizes_before_recovery(recovery_state, viewer):
    state = recovery_state
    add_job(state)
    state['viewer'] = viewer

    response, status = upload_runtime_service.get_status(state['runtime'], object(), 'job')

    assert status == (401 if viewer is None else 403)
    assert 'error' in response
    assert state['transaction_reads'] == 0
    assert state['reads'] == 0
    assert state['refunds'] == []


def test_admin_status_read_checks_admin_before_recovery(recovery_state, monkeypatch):
    state = recovery_state
    add_job(state)
    state['viewer'] = 'administrator'
    state['admin'] = True
    original = recovery._claim_stale_runtime_job
    def claim(*args, **kwargs):
        state['events'].append('claim')
        return original(*args, **kwargs)
    monkeypatch.setattr(recovery, '_claim_stale_runtime_job', claim)

    response = upload_runtime_service.get_status(state['runtime'], object(), 'job')

    assert response['status'] == 'error'
    assert state['events'] == ['admin-check', 'claim']


def test_status_recovery_disabled_does_not_query_or_mutate(recovery_state):
    state = recovery_state
    add_job(state)
    state['runtime'].RUNTIME_JOB_RECOVERY_ENABLED = False

    response = upload_runtime_service.get_status(state['runtime'], object(), 'job')

    assert response['status'] == 'processing'
    assert state['reads'] == 0
    assert state['transaction_reads'] == 0
    assert state['refunds'] == []


@pytest.mark.parametrize('status', ['complete', 'error'])
def test_terminal_status_read_does_not_attempt_recovery(recovery_state, status):
    state = recovery_state
    add_job(state, status=status, result='Synthetic result', error='Synthetic error')

    response = upload_runtime_service.get_status(state['runtime'], object(), 'job')

    assert response['status'] == status
    assert state['reads'] == 0
    assert state['transaction_reads'] == 0
    assert state['refunds'] == []


def test_unknown_status_read_does_not_attempt_recovery(recovery_state):
    state = recovery_state

    response, status = upload_runtime_service.get_status(state['runtime'], object(), 'missing')

    assert status == 404
    assert response['retryable'] is True
    assert state['reads'] == 0
    assert state['transaction_reads'] == 0
    assert state['refunds'] == []
