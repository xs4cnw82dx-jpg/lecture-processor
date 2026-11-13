"""Local dispatch and recovery lifecycle checks without external services."""

from concurrent.futures import Future
import logging
import threading
from types import SimpleNamespace

import pytest

from lecture_processor.domains.runtime_jobs import execution, store
from lecture_processor.runtime import core
from lecture_processor.runtime.job_dispatcher import JobQueueFullError
from lecture_processor.services import job_state_service


class ManualDispatcher:
    def __init__(self):
        self.entries = []

    def submit(self, target, *args, **kwargs):
        future = Future()
        self.entries.append((future, target, args, kwargs))
        return future

    def run_next(self):
        future, target, args, kwargs = self.entries.pop(0)
        if future.set_running_or_notify_cancel():
            try:
                future.set_result(target(*args, **kwargs))
            except BaseException as error:
                future.set_exception(error)


@pytest.fixture
def dispatch(monkeypatch):
    persisted = []
    runtime = SimpleNamespace(
        jobs={}, JOBS_LOCK=threading.Lock(), job_state_service=job_state_service,
        time=SimpleNamespace(time=lambda: 1000.0), logger=logging.getLogger('synthetic-job'),
    )
    dispatcher = ManualDispatcher()
    monkeypatch.setattr(core, 'job_dispatcher', dispatcher)
    monkeypatch.setattr(core, '_self_runtime', lambda: runtime)
    monkeypatch.setattr(store, 'persist_runtime_job_snapshot', lambda *args, **kwargs: persisted.append((args, kwargs)))
    return runtime, dispatcher, persisted


@pytest.mark.parametrize('argument_style', ['job_first', 'app_first', 'keyword'])
def test_submit_tracks_named_job_id_before_dispatch_and_preserves_arguments(dispatch, argument_style):
    runtime, dispatcher, persisted = dispatch
    job_id = f'synthetic-{argument_style}'
    runtime.jobs[job_id] = {'status': 'queued'}
    target_runtime = object()
    calls = []

    def target(job_id, *, runtime=None):
        calls.append((job_id, runtime, execution.is_job_active(job_id)))
        return 'done'

    def app_target(app_ctx, job_id, *, runtime=None):
        assert app_ctx == 'synthetic-app'
        return target(job_id, runtime=runtime)

    if argument_style == 'app_first':
        future = core.submit_background_job(app_target, 'synthetic-app', job_id, runtime=target_runtime)
    elif argument_style == 'keyword':
        future = core.submit_background_job(target, job_id=job_id, runtime=target_runtime)
    else:
        future = core.submit_background_job(target, job_id, runtime=target_runtime)
    assert execution.is_job_active(job_id, runtime=runtime)
    assert persisted == []
    dispatcher.run_next()
    assert future.result() == 'done'
    assert calls == [(job_id, target_runtime, True)]
    assert not execution.is_job_active(job_id, runtime=runtime)
    assert runtime.jobs[job_id]['last_heartbeat_at'] == 1000.0
    assert all(kwargs['changed_fields'] == {'last_heartbeat_at'} for _args, kwargs in persisted)


def test_cancelled_queued_future_releases_registration(dispatch):
    runtime, dispatcher, persisted = dispatch
    called = []

    def target(job_id):
        called.append(job_id)

    future = core.submit_background_job(target, 'synthetic-cancel')
    assert execution.is_job_active('synthetic-cancel')
    assert future.cancel()
    assert not execution.is_job_active('synthetic-cancel')
    dispatcher.run_next()
    assert called == []
    assert persisted == []
    assert runtime.jobs == {}


def test_submission_failure_releases_registration(dispatch, monkeypatch):
    _runtime, dispatcher, _persisted = dispatch
    observed = []

    def reject(*_args, **_kwargs):
        observed.append(execution.is_job_active('synthetic-rejected'))
        raise JobQueueFullError('Synthetic queue full')

    monkeypatch.setattr(dispatcher, 'submit', reject)
    with pytest.raises(JobQueueFullError):
        core.submit_background_job(lambda job_id: None, 'synthetic-rejected')
    assert observed == [True]
    assert not execution.is_job_active('synthetic-rejected')


@pytest.mark.parametrize('raises', [False, True])
def test_duplicate_submissions_keep_registration_until_last_future_finishes(dispatch, raises):
    _runtime, dispatcher, _persisted = dispatch

    def target(job_id):
        assert execution.is_job_active(job_id)
        if raises:
            raise RuntimeError('Synthetic worker failure')

    first = core.submit_background_job(target, 'synthetic-duplicate')
    second = core.submit_background_job(target, 'synthetic-duplicate')
    dispatcher.run_next()
    assert execution.is_job_active('synthetic-duplicate')
    dispatcher.run_next()
    assert not execution.is_job_active('synthetic-duplicate')
    for future in (first, second):
        if raises:
            with pytest.raises(RuntimeError, match='Synthetic worker failure'):
                future.result()
        else:
            assert future.result() is None


@pytest.mark.parametrize('status', ['complete', 'completed', 'error', None])
def test_heartbeat_does_not_create_or_revive_terminal_records(dispatch, status):
    runtime, dispatcher, persisted = dispatch
    if status is not None:
        runtime.jobs['synthetic-terminal'] = {'status': status, 'last_heartbeat_at': 50.0}
    before = {key: dict(value) for key, value in runtime.jobs.items()}
    future = core.submit_background_job(lambda job_id: 'done', 'synthetic-terminal')
    dispatcher.run_next()
    assert future.result() == 'done'
    assert runtime.jobs == before
    assert persisted == []
    assert not execution.is_job_active('synthetic-terminal')


def test_periodic_heartbeat_only_runs_while_worker_is_active(dispatch, monkeypatch):
    runtime, dispatcher, persisted = dispatch
    job_id = 'synthetic-heartbeat'
    runtime.jobs[job_id] = {'status': 'processing'}
    now = [1000.0]
    runtime.time.time = lambda: now[0]
    monkeypatch.setattr(execution, 'HEARTBEAT_INTERVAL_SECONDS', 0.01)
    changed = threading.Condition()
    original = execution._heartbeat_job
    attempts = []

    def heartbeat(*args):
        try:
            return original(*args)
        finally:
            with changed:
                attempts.append(now[0])
                changed.notify_all()

    monkeypatch.setattr(execution, '_heartbeat_job', heartbeat)
    entered = threading.Event()
    release = threading.Event()

    def target(job_id):
        entered.set()
        assert release.wait(3)

    future = core.submit_background_job(target, job_id)
    worker = threading.Thread(target=dispatcher.run_next)
    worker.start()
    try:
        assert entered.wait(1)
        for _ in range(3):
            with changed:
                now[0] += 31
                assert changed.wait_for(lambda: runtime.jobs[job_id]['last_heartbeat_at'] == now[0], timeout=1)
        with changed:
            runtime.jobs[job_id]['status'] = 'completed'
            previous = len(attempts)
            terminal = dict(runtime.jobs[job_id])
            now[0] += 31
            assert changed.wait_for(lambda: len(attempts) > previous, timeout=1)
        assert runtime.jobs[job_id] == terminal
    finally:
        release.set()
        worker.join(2)
    assert not worker.is_alive()
    assert future.result() is None
    assert not execution.is_job_active(job_id)
    assert len(persisted) >= 4
