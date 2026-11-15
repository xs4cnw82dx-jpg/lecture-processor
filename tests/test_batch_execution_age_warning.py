"""Execution-age diagnostics observe real workers without changing their outcomes."""

from contextlib import contextmanager
from copy import deepcopy
import logging
import threading
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import batch_orchestrator as batch
from tests.test_batch_slide_conversion import slides  # noqa: F401


class _Clock:
    def __init__(self):
        self.elapsed = 0.0
        self.wall = 1_800_000_000.0

    def monotonic(self):
        return 100.0 + self.elapsed

    def time(self):
        return self.wall


class _Warnings(logging.Handler):
    def __init__(self):
        super().__init__(logging.WARNING)
        self.messages = []

    def emit(self, record):
        self.messages.append(record.getMessage())

    def age_messages(self, batch_id):
        return [message for message in self.messages
                if batch_id in message and 'execution age' in message.lower()]


def _without_heartbeat(payload):
    return {key: value for key, value in payload.items() if key != 'last_heartbeat_at'}


@contextmanager
def _running_upload(slides, monkeypatch, strategy, *, configured_wait=300, scheme=1):
    clock = _Clock()
    original_time = slides.runtime.time
    monkeypatch.setattr(slides.runtime, 'time', SimpleNamespace(
        time=clock.time, monotonic=clock.monotonic, sleep=original_time.sleep,
    ))
    monkeypatch.setattr(batch, 'time', SimpleNamespace(monotonic=clock.monotonic))
    monkeypatch.setattr(slides.runtime, 'BATCH_MAX_WAIT_SECONDS', configured_wait, raising=False)
    monkeypatch.setattr(slides.runtime, 'INSTANT_BATCH_MAX_PARALLEL_ROWS', 1)
    monkeypatch.setattr(batch, '_batch_heartbeat_interval_seconds', lambda **_kwargs: 0.01)
    if scheme == 2:
        slides.store.documents[('users', 'slide-owner')].update(credits_version=2, credits=100)

    warnings = _Warnings()
    logger = logging.Logger('synthetic-batch-age', level=logging.WARNING)
    logger.addHandler(warnings)
    monkeypatch.setattr(slides.runtime, 'logger', logger)
    cancels = []
    slides.runtime.client.batches = SimpleNamespace(cancel=lambda **kwargs: cancels.append(kwargs))

    response = slides.post(strategy)
    assert response.status_code == 200
    batch_id = response.get_json()['batch_id']
    target, args, kwargs = slides.submitted.pop()
    assert slides.submitted == []
    entered, release = threading.Event(), threading.Event()
    condition = threading.Condition()
    ticks = []
    original_heartbeat = batch._heartbeat_batch

    def observe_heartbeat(*args, **kwargs):
        result = original_heartbeat(*args, **kwargs)
        with condition:
            ticks.append(result)
            condition.notify_all()
        return result

    monkeypatch.setattr(batch, '_heartbeat_batch', observe_heartbeat)

    def hold_upload(_path):
        if not entered.is_set():
            entered.set()
            assert release.wait(5), 'Synthetic upload was not released'

    slides.upload_hook = hold_upload
    errors = []

    def execute():
        try:
            target(*args, **kwargs)
        except BaseException as error:
            errors.append(error)

    thread = threading.Thread(target=execute, name='synthetic-batch-worker')
    thread.start()

    def wait_ticks(count=3):
        with condition:
            target_ticks = len(ticks) + count
            assert condition.wait_for(lambda: len(ticks) >= target_ticks, timeout=2), (
                f'Heartbeat stopped before {target_ticks} ticks; observed {ticks}'
            )

    def wait_stopped():
        with condition:
            assert condition.wait_for(lambda: False in ticks, timeout=2)

    state = SimpleNamespace(
        batch_id=batch_id, clock=clock, thread=thread, ticks=ticks,
        warnings=warnings, cancels=cancels, wait_ticks=wait_ticks, wait_stopped=wait_stopped,
    )
    try:
        assert entered.wait(2), f'Worker did not reach the synthetic upload: {errors}'
        wait_ticks()
        state.parent = batch._get_batch(batch_id, runtime=slides.runtime)
        state.rows = batch._list_rows(batch_id, runtime=slides.runtime)
        state.user = slides.store.docs('users')['slide-owner']
        state.charges = deepcopy(slides.charges)
        state.refund_ledger = slides.store.docs('credit_refunds')
        yield state
    finally:
        release.set()
        thread.join(timeout=5)
        logger.removeHandler(warnings)
        assert not thread.is_alive(), 'Synthetic worker did not finish after upload release'
        assert errors == []


def _assert_observation_only(slides, state):
    current = batch._get_batch(state.batch_id, runtime=slides.runtime)
    assert _without_heartbeat(current) == _without_heartbeat(state.parent)
    assert current['last_heartbeat_at'] == state.clock.wall
    assert batch._list_rows(state.batch_id, runtime=slides.runtime) == state.rows
    assert slides.store.docs('users')['slide-owner'] == state.user
    assert slides.charges == state.charges
    assert slides.store.docs('credit_refunds') == state.refund_ledger
    assert slides.refunds == []
    assert slides.saved_packs == []
    assert slides.job_logs == []
    assert len(slides.uploads) == 1
    assert state.cancels == []
    assert state.thread.is_alive()


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('scheme', [1, 2], ids=['legacy', 'unified'])
def test_long_running_worker_warns_once_and_preserves_work_and_credits(slides, monkeypatch, strategy, scheme):
    with _running_upload(slides, monkeypatch, strategy, scheme=scheme) as state:
        # A wall-clock correction does not make a newly started execution old.
        state.clock.wall += 100_000
        state.clock.elapsed = 100
        state.wait_ticks()
        assert state.warnings.age_messages(state.batch_id) == []
        _assert_observation_only(slides, state)

        state.clock.elapsed = 900
        state.wait_ticks()
        assert state.warnings.age_messages(state.batch_id) == []
        state.clock.elapsed = 901
        state.clock.wall += 1
        state.wait_ticks()
        assert len(state.warnings.age_messages(state.batch_id)) == 1
        _assert_observation_only(slides, state)

        state.clock.elapsed += 10_000
        state.clock.wall += 10_000
        state.wait_ticks()
        assert len(state.warnings.age_messages(state.batch_id)) == 1
        _assert_observation_only(slides, state)

    assert batch._get_batch(state.batch_id, runtime=slides.runtime)['status'] == 'complete'
    assert len(slides.saved_packs) == 2
    assert slides.refunds == []
    assert slides.store.docs('users')['slide-owner'] == state.user
    assert slides.charges == state.charges
    assert slides.store.docs('credit_refunds') == state.refund_ledger
    assert len(state.warnings.age_messages(state.batch_id)) == 1


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('configured_wait', [None, 0, -1, 'not-a-number', float('nan'), float('inf')])
def test_invalid_max_wait_uses_default_age_without_disabling_heartbeat(slides, monkeypatch, strategy, configured_wait):
    with _running_upload(slides, monkeypatch, strategy, configured_wait=configured_wait) as state:
        state.clock.elapsed = 901
        state.clock.wall += 901
        state.wait_ticks()
        assert state.warnings.age_messages(state.batch_id) == []
        _assert_observation_only(slides, state)

        state.clock.elapsed = 87_000
        state.wait_ticks()
        assert state.warnings.age_messages(state.batch_id) == []
        state.clock.elapsed = 87_001
        state.clock.wall += 1
        state.wait_ticks()
        assert len(state.warnings.age_messages(state.batch_id)) == 1
        _assert_observation_only(slides, state)


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_completed_worker_needs_no_age_warning(slides, monkeypatch, strategy):
    with _running_upload(slides, monkeypatch, strategy) as state:
        state.clock.elapsed = 899
        state.wait_ticks()
        assert state.warnings.age_messages(state.batch_id) == []
    assert batch._get_batch(state.batch_id, runtime=slides.runtime)['status'] == 'complete'
    assert state.warnings.age_messages(state.batch_id) == []
    assert len(slides.saved_packs) == 2
    assert slides.refunds == []


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_terminal_batch_stops_heartbeat_without_age_warning_or_new_side_effects(slides, monkeypatch, strategy):
    with _running_upload(slides, monkeypatch, strategy) as state:
        batch._upsert_batch(state.batch_id, {'status': 'error', 'error': 'Synthetic external stop'}, runtime=slides.runtime)
        state.clock.elapsed = 901
        state.wait_stopped()
        assert state.warnings.age_messages(state.batch_id) == []
        assert slides.refunds == []
        assert state.cancels == []
    current = batch._get_batch(state.batch_id, runtime=slides.runtime)
    assert current['status'] == 'error'
    assert current['error'] == 'Synthetic external stop'
    assert slides.saved_packs == []
    assert slides.refunds == []
    assert slides.store.docs('users')['slide-owner'] == state.user
    assert slides.charges == state.charges
    assert slides.store.docs('credit_refunds') == state.refund_ledger
