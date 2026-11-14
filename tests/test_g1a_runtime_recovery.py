"""Recovery and queued-worker boundaries using only synthetic durable storage."""

from concurrent.futures import Future
from copy import deepcopy
from datetime import datetime, timezone
import os
from threading import RLock, Thread
from types import SimpleNamespace

from flask import has_app_context
import pytest

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.billing import job_charges
from lecture_processor.domains.runtime_jobs import execution, recovery, store
from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.domains.study import interview_coding_runs
from lecture_processor.repositories import batch_repo, runtime_jobs_repo, study_repo
from lecture_processor.services import job_state_service
from tests.credit_test_support import make_credit_runtime


def make_runtime(scheme=2):
    user = {'uid': 'owner', 'account_status': 'active', 'total_processed': 0,
            'lecture_credits_standard': 5, 'slides_credits': 5, 'interview_credits_short': 5}
    if scheme == 2:
        user.update(credits_version=2, credits=100)
    runtime, state = make_credit_runtime(users={'owner': user}, unified_enabled=False)
    runtime.jobs, runtime.JOBS_LOCK = {}, RLock()
    runtime.job_state_service = job_state_service
    runtime.runtime_jobs_repo, runtime.batch_repo = runtime_jobs_repo, batch_repo
    runtime.repositories = SimpleNamespace(study=study_repo, users=runtime.users_repo)
    runtime.RUNTIME_JOBS_COLLECTION = 'runtime_jobs'
    runtime.RUNTIME_JOB_PERSISTED_FIELDS = PERSISTED_RUNTIME_JOB_FIELDS
    runtime.JOB_TTL_SECONDS = 1800
    runtime.RUNTIME_JOB_RECOVERY_ENABLED = True
    runtime.RUNTIME_JOB_RECOVERY_BATCH_LIMIT = 100
    runtime.RUNTIME_JOB_RECOVERY_LEASE_COLLECTION = 'recovery_leases'
    runtime.RUNTIME_JOB_RECOVERY_LEASE_ID = 'runtime'
    runtime.RUNTIME_JOB_RECOVERY_LEASE_SECONDS = 300
    runtime.RUNTIME_JOB_RECOVERY_LOCK = RLock()
    runtime.RUNTIME_JOB_RECOVERY_DONE = False
    runtime.get_timestamp = lambda value: value.timestamp() if isinstance(value, datetime) else float(value or 0)
    runtime.os = os
    runtime.client, runtime.MAX_ACTIVE_JOBS_PER_USER = object(), 10
    runtime.logs = []
    runtime.save_job_log = lambda *args, **kwargs: runtime.logs.append((deepcopy(args), kwargs))
    return runtime, state


def admit(runtime, job_id='job'):
    return job_charges.admit_runtime_job(
        'owner', job_id, 'lecture-notes', {'primary': {'action': 'lecture_notes', 'units': 1}}, runtime=runtime,
    )


class Dispatcher:
    def __init__(self):
        self.entries = []

    def submit(self, target, *args, **kwargs):
        future = Future()
        self.entries.append((future, target, args, kwargs))
        return future

    def run(self):
        future, target, args, kwargs = self.entries.pop(0)
        if future.set_running_or_notify_cancel():
            try:
                future.set_result(target(*args, **kwargs))
            except BaseException as error:
                future.set_exception(error)


@pytest.mark.parametrize('scheme', [1, 2])
def test_first_periodic_pass_can_renew_startup_lease_and_refund_once(scheme):
    runtime, state = make_runtime(scheme)
    original = deepcopy(state.docs('users')['owner'])
    admit(runtime)
    recovery.run_startup_recovery_once(runtime=runtime)
    assert state.docs('runtime_jobs')['job']['status'] == 'starting'
    state.now += 299

    assert recovery.run_periodic_recovery(runtime=runtime) == 1
    assert state.docs('runtime_jobs')['job']['status'] == 'error'
    assert state.docs('runtime_jobs')['job']['credit_refunded']
    assert recovery.run_periodic_recovery(runtime=runtime) == 0
    user = state.docs('users')['owner']
    balance = 'credits' if scheme == 2 else 'lecture_credits_standard'
    assert user[balance] == original[balance]
    assert len(runtime.logs) == 1


def test_other_holder_cannot_renew_a_live_recovery_lease():
    runtime, state = make_runtime()
    state.documents[('recovery_leases', 'runtime')] = {'holder_id': 'another-worker', 'expires_at': state.now + 300}
    assert recovery.acquire_runtime_job_recovery_lease(runtime=runtime) is False


@pytest.mark.parametrize('scheme', [1, 2])
def test_startup_recovery_runs_unstubbed_on_a_plain_thread(scheme, core, monkeypatch):
    runtime, state = make_runtime(scheme)
    admit(runtime)
    state.now += 181
    # Exercise the actual core entry point and job-log writer, without an app
    # context or replacing any recovery/claim/refund function.
    for name, value in vars(runtime).items():
        if name not in {'save_job_log', 'logs'}:
            monkeypatch.setattr(core, name, value, raising=False)
    errors = []

    def recover():
        try:
            assert not has_app_context()
            core.run_startup_recovery_once()
        except BaseException as error:
            errors.append(error)

    thread = Thread(target=recover)
    thread.start()
    thread.join(3)
    assert not thread.is_alive()
    assert not errors
    assert state.docs('runtime_jobs')['job']['status'] == 'error'
    assert state.docs('runtime_jobs')['job']['credit_refunded']
    assert state.docs('job_logs')['job']['status'] == 'error'


def test_submit_heartbeats_a_job_before_the_dispatcher_runs():
    runtime, state = make_runtime()
    admit(runtime)
    state.now += 60
    dispatcher = Dispatcher()
    future = execution.submit_job(dispatcher, lambda job_id: None, 'job', execution_runtime=runtime)
    try:
        assert state.docs('runtime_jobs')['job']['last_heartbeat_at'] == state.now
        assert execution.is_job_active('job')
    finally:
        future.cancel()


def test_durable_read_failure_at_worker_start_does_not_call_target():
    runtime, state = make_runtime()
    admit(runtime)
    dispatcher, calls = Dispatcher(), []
    future = execution.submit_job(dispatcher, lambda job_id: calls.append(job_id), 'job', execution_runtime=runtime)
    state.fail_reads.add(('runtime_jobs', 'job'))
    dispatcher.run()
    with pytest.raises(RuntimeError, match='Synthetic read failure'):
        future.result()
    assert calls == []
    assert not execution.is_job_active('job')


def test_submit_heartbeat_failure_can_retry_safely_at_worker_start():
    runtime, state = make_runtime()
    admit(runtime)
    state.fail_reads.add(('runtime_jobs', 'job'))
    dispatcher, calls = Dispatcher(), []
    future = execution.submit_job(dispatcher, lambda job_id: calls.append(job_id), 'job', execution_runtime=runtime)
    state.fail_reads.clear()
    dispatcher.run()
    assert future.result() is None
    assert calls == ['job']
    assert not execution.is_job_active('job')


@pytest.mark.parametrize('remote_state', ['error', 'complete', 'completed', 'deleted', 'claimed'])
def test_queued_worker_checks_durable_state_before_calling_target(remote_state):
    runtime, state = make_runtime()
    admit(runtime)
    dispatcher, calls = Dispatcher(), []
    future = execution.submit_job(dispatcher, lambda job_id: calls.append(job_id), 'job', execution_runtime=runtime)
    key = ('runtime_jobs', 'job')
    if remote_state == 'deleted':
        state.documents.pop(key)
    elif remote_state == 'claimed':
        state.documents[key]['recovery_claimed_at'] = state.now
    else:
        state.documents[key].update(status=remote_state, credit_refunded=True, finished_at=state.now)
    dispatcher.run()
    assert future.result() is None
    assert calls == []
    assert not execution.is_job_active('job')
    assert lifecycle.count_active_jobs_for_user('owner', runtime=runtime) == (1 if remote_state == 'claimed' else 0)
    snapshot = store.get_job_snapshot('job', runtime=runtime)
    if remote_state == 'deleted':
        assert snapshot is None
    elif remote_state != 'claimed':
        assert snapshot['status'] == remote_state


@pytest.mark.parametrize('remote_state', ['complete', 'deleted'])
def test_reconciling_remote_terminal_state_preserves_a_newer_local_terminal_snapshot(remote_state):
    runtime, state = make_runtime()
    admit(runtime)
    dispatcher = Dispatcher()
    future = execution.submit_job(dispatcher, lambda job_id: pytest.fail('Terminal job was dispatched'), 'job', execution_runtime=runtime)
    key = ('runtime_jobs', 'job')
    if remote_state == 'deleted':
        state.documents.pop(key)
    else:
        state.documents[key]['status'] = remote_state
    newer = {**runtime.jobs['job'], 'status': 'error', 'error': 'Newer local completion'}

    def finish_locally(operations):
        if not operations:
            runtime.jobs['job'] = deepcopy(newer)

    state.after_commit = finish_locally
    dispatcher.run()
    assert future.result() is None
    assert runtime.jobs['job'] == newer
    assert (state.documents.get(key) or {}).get('status') == (None if remote_state == 'deleted' else remote_state)


def test_heartbeat_removes_old_active_expiry_without_touching_terminal_deadlines():
    runtime, state = make_runtime()
    admit(runtime)
    old_expiry = datetime.fromtimestamp(state.now - 1, tz=timezone.utc)
    state.documents[('runtime_jobs', 'job')]['expires_at_ts'] = old_expiry
    runtime.jobs['job']['expires_at_ts'] = old_expiry
    assert execution._heartbeat_job('job', runtime)
    assert state.docs('runtime_jobs')['job']['expires_at_ts'] is None
    terminal_expiry = datetime.fromtimestamp(state.now + 1800, tz=timezone.utc)
    state.documents[('runtime_jobs', 'job')].update(status='complete', expires_at_ts=terminal_expiry)
    # The local snapshot is intentionally still active, as in another worker.
    assert execution._heartbeat_job('job', runtime) is False
    assert state.docs('runtime_jobs')['job']['expires_at_ts'] == terminal_expiry


def test_new_active_job_has_no_ttl_while_it_is_alive():
    runtime, state = make_runtime()
    admit(runtime)
    state.now += runtime.JOB_TTL_SECONDS + 1
    assert execution._heartbeat_job('job', runtime)
    assert state.docs('runtime_jobs')['job']['expires_at_ts'] is None


def test_untracked_background_task_remains_dispatchable():
    runtime, state = make_runtime()
    dispatcher, calls = Dispatcher(), []
    future = execution.submit_job(dispatcher, lambda job_id: calls.append(job_id), 'audio-import', execution_runtime=runtime)
    dispatcher.run()
    assert future.result() is None
    assert calls == ['audio-import']
    assert state.docs('runtime_jobs') == {}


@pytest.mark.parametrize('scheme', [1, 2])
def test_recovery_terminalizes_a_coding_mirror_after_its_account_run_is_purged(scheme):
    runtime, state = make_runtime(scheme)
    state.documents[('study_packs', 'pack')] = {'uid': 'owner', 'mode': 'interview'}
    run_id, created = interview_coding_runs.claim_run(runtime, 'owner', 'pack', 1)
    assert created
    assert interview_coding_runs.start_processing(runtime, run_id)
    state.documents.pop(('interview_ai_coding_runs', run_id))
    state.documents.pop(('users', 'owner'))
    state.now += 181

    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    job = state.docs('runtime_jobs')[run_id]
    assert job['status'] == 'error'
    assert job['finished_at'] == state.now
    assert job['error'] == interview_coding_runs.ERROR_MESSAGE
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 0
    assert state.docs('users') == {}
    assert state.docs('credit_refunds') == {}
    assert state.docs('interview_ai_coding_runs') == {}


def test_missing_coding_run_mirror_is_not_recovered_while_fresh_or_locally_queued():
    runtime, state = make_runtime()
    state.documents[('study_packs', 'pack')] = {'uid': 'owner', 'mode': 'interview'}
    run_id, _ = interview_coding_runs.claim_run(runtime, 'owner', 'pack', 1)
    interview_coding_runs.cache_job(runtime, run_id)
    state.documents.pop(('interview_ai_coding_runs', run_id))
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 0
    dispatcher = Dispatcher()
    future = execution.submit_job(dispatcher, lambda job_id: None, run_id, execution_runtime=runtime)
    try:
        state.now += 181
        assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 0
        assert state.docs('runtime_jobs')[run_id]['status'] == 'queued'
    finally:
        future.cancel()


def test_successful_coding_draft_repairs_its_mirror_without_refunding():
    runtime, state = make_runtime()
    state.documents[('study_packs', 'pack')] = {'uid': 'owner', 'mode': 'interview'}
    run_id, _ = interview_coding_runs.claim_run(runtime, 'owner', 'pack', 1)
    state.documents[('interview_ai_coding_runs', run_id)]['status'] = 'draft'
    state.now += 181
    recovery.recover_stale_runtime_jobs(runtime=runtime)
    assert state.docs('runtime_jobs')[run_id]['status'] == 'complete'
    assert state.docs('credit_refunds') == {}
    assert state.docs('users')['owner']['credits'] == 98
