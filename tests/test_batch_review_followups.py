"""Batch lifecycle regressions with synthetic providers and the real credit ledger."""

from copy import deepcopy
import os
from pathlib import Path
import threading
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import batch_orchestrator as batch
from lecture_processor.domains.rate_limit import quotas
from tests.test_batch_slide_conversion import slides as slides
from tests.test_batch_worker_heartbeat import BatchHarness


def _use_credit_scheme(slides, scheme, *, exempt=False):
    user = slides.store.documents[('users', 'slide-owner')]
    if scheme == 2:
        user.update(credits_version=2, credits=100)
    user['unlimited_credits'] = {'slides': exempt}


@pytest.mark.parametrize('scheme', [1, 2], ids=['legacy', 'unified'])
@pytest.mark.parametrize('failure', ['reported', 'raised', 'oversize', 'low_disk'])
def test_deferred_failed_pptx_row_refunds_only_itself_and_continues(slides, monkeypatch, scheme, failure):
    _use_credit_scheme(slides, scheme)
    response = slides.post()
    assert response.status_code == 200
    batch_id = response.get_json()['batch_id']
    charged = slides.store.docs('users')['slide-owner']
    assert charged['credits' if scheme == 2 else 'slides_credits'] == 98
    monkeypatch.setattr(slides.runtime, 'MAX_PDF_UPLOAD_BYTES', 1000)

    def fail_conversion(_source, target):
        Path(target).write_bytes(b'%PDF-' + b'x' * 1000 if failure == 'oversize' else b'partial output')
        if failure == 'raised':
            raise TimeoutError('Synthetic converter timeout')
        if failure == 'reported':
            return '', 'Synthetic converter failed'
        return str(target), ''

    slides.conversion_hook = fail_conversion
    if failure == 'low_disk':
        monkeypatch.setattr(quotas, 'has_sufficient_upload_disk_space', lambda *_args, **_kwargs: (False, 0, 1000))
    target, args, kwargs = slides.submitted.pop()
    target(*args, **kwargs)
    parent = batch._get_batch(batch_id, runtime=slides.runtime)
    rows = batch._list_rows(batch_id, runtime=slides.runtime)
    assert parent['status'] == 'partial'
    assert [row['status'] for row in rows] == ['error', 'complete']
    assert rows[0]['failed_stage'] == 'slide_conversion'
    assert len(slides.saved_packs) == len(slides.uploads) == 1
    assert slides.saved_packs[0]['batch_row_id'] == 'row-2'
    assert slides.uploads[0][1] == b'%PDF-1.7 synthetic PDF'
    assert slides.refunds == [f'batch-row:{batch_id}:row-1:primary']
    assert len(slides.store.docs('credit_refunds')) == 1
    assert slides.store.docs('users')['slide-owner']['credits' if scheme == 2 else 'slides_credits'] == 99
    assert slides.store.docs('users')['slide-owner']['total_processed'] == 1
    assert parent['credits_charged'] == 2 and parent['credits_refunded'] == 1
    assert not list(slides.root.iterdir())
    snapshot = deepcopy(slides.store.documents)
    target(*args, **kwargs)
    batch.get_batch_status(batch_id, runtime=slides.runtime)
    assert slides.store.documents == snapshot
    assert len(slides.refunds) == 1


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
@pytest.mark.parametrize('scheme', [1, 2], ids=['legacy', 'unified'])
@pytest.mark.parametrize('settlement', ['refunded', 'pending', 'exempt'])
def test_low_disk_message_matches_committed_refund(slides, monkeypatch, strategy, scheme, settlement):
    _use_credit_scheme(slides, scheme, exempt=settlement == 'exempt')
    monkeypatch.setattr(slides.runtime, 'save_job_log', lambda *args, **_kwargs: slides.job_logs.append(deepcopy(args)))
    response = slides.post(strategy)
    assert response.status_code == 200
    batch_id = response.get_json()['batch_id']
    monkeypatch.setattr(quotas, 'has_sufficient_upload_disk_space', lambda *_args, **_kwargs: (False, 0, 1000))
    if settlement == 'pending':
        slides.store.fail_writes.add(('users', 'slide-owner'))
    target, args, kwargs = slides.submitted.pop()
    target(*args, **kwargs)
    row = batch._get_row(batch_id, 'row-1', runtime=slides.runtime)
    expected = {
        'refunded': 'The credits for this row were refunded.',
        'pending': 'The refund for this row is still pending.',
        'exempt': 'No credits were charged for this row.',
    }[settlement]
    assert row['error'] == f'PowerPoint conversion stopped because server storage is low. {expected} Please try again later.'
    state = batch.get_batch_status(batch_id, runtime=slides.runtime)
    assert state['rows'][0]['status_message'] == row['error']
    assert 'Google Gemini' not in state['error_message']
    cost = 1 if scheme == 1 or strategy == 'deferred' else 2
    balance = slides.store.docs('users')['slide-owner']['credits' if scheme == 2 else 'slides_credits']
    assert balance == 100 - (0 if settlement == 'exempt' else cost * (2 if settlement == 'pending' else 1))
    assert bool(row.get('credit_refund_pending')) is (settlement == 'pending')
    refunds = list(slides.store.docs('credit_refunds').values())
    assert len(refunds) == (0 if settlement == 'pending' else 1)
    assert sum(item['amount'] for item in refunds) == (cost if settlement == 'refunded' else 0)
    if settlement == 'pending':
        slides.store.fail_writes.clear()
        later = slides.runtime.time.time() + 181
        monkeypatch.setattr(slides.runtime, 'time', SimpleNamespace(time=lambda: later))
        repaired = batch.get_batch_status(batch_id, runtime=slides.runtime)
        assert 'The credits for this row were refunded.' in repaired['rows'][0]['status_message']
        assert repaired['credits_refund_pending'] == 0
        assert slides.store.docs('users')['slide-owner']['credits' if scheme == 2 else 'slides_credits'] == 100 - cost
        assert len(slides.store.docs('credit_refunds')) == 1


@pytest.mark.parametrize('strategy', ['deferred', 'instant'])
def test_heartbeat_interval_failure_uses_safe_fallback_and_keeps_worker_alive(monkeypatch, caplog, strategy):
    harness = BatchHarness(monkeypatch, strategy)
    renewed = threading.Event()
    original = batch._heartbeat_batch

    def broken_interval(**_kwargs):
        raise RuntimeError('Synthetic interval configuration failure')

    def heartbeat(*args, **kwargs):
        result = original(*args, **kwargs)
        if threading.current_thread().name == 'lp-batch-heartbeat':
            renewed.set()
        return result

    monkeypatch.setattr(batch, '_batch_heartbeat_interval_seconds', broken_interval)
    monkeypatch.setattr(batch, 'BATCH_HEARTBEAT_FALLBACK_SECONDS', 0.01, raising=False)
    monkeypatch.setattr(batch, '_heartbeat_batch', heartbeat)
    with harness.blocked('upload'):
        assert renewed.wait(1), 'Interval failure stopped the periodic heartbeat'
    assert harness.stored_batch()['status'] == 'complete'
    assert 'interval' in caplog.text.lower()
    assert harness.refunds == []


@pytest.mark.parametrize('stop_at', ['create', 'poll'])
@pytest.mark.parametrize('cancel_outcome', ['held', 'failure'])
def test_stopped_provider_batch_cancels_without_blocking_or_changing_terminal_state(monkeypatch, tmp_path, caplog, stop_at, cancel_outcome):
    run_stage = batch._run_batch_stage
    harness = BatchHarness(monkeypatch, 'deferred')
    monkeypatch.setattr(batch, '_run_batch_stage', run_stage)
    monkeypatch.setattr(batch.ai_provider, 'run_with_provider_retry', lambda _label, callback, **_kwargs: callback())
    harness.runtime.os = os
    harness.runtime.UPLOAD_FOLDER = str(tmp_path)
    cancel_started, release_cancel, cancel_finished, worker_finished = (threading.Event() for _ in range(4))
    calls, errors, stopped, cancel_threads = [], [], {}, []

    def create(**_kwargs):
        if stop_at == 'create':
            stopped['batch'] = harness.stop_externally()
        return SimpleNamespace(name='synthetic-provider-job', state=SimpleNamespace(name='JOB_STATE_PENDING'))

    def get(**_kwargs):
        stopped['batch'] = harness.stop_externally()
        return SimpleNamespace(name='synthetic-provider-job', state=SimpleNamespace(name='JOB_STATE_RUNNING'))

    def cancel(*, name):
        cancel_threads.append(threading.current_thread())
        calls.append(name)
        cancel_started.set()
        try:
            if cancel_outcome == 'failure':
                raise RuntimeError('Synthetic cancellation failure')
            assert release_cancel.wait(3)
        finally:
            cancel_finished.set()

    harness.runtime.client = SimpleNamespace(
        files=SimpleNamespace(upload=lambda **_kwargs: SimpleNamespace(name='synthetic-input')),
        batches=SimpleNamespace(create=create, get=get, cancel=cancel),
    )

    def work():
        try:
            harness.worker(harness.batch_id, runtime=harness.runtime)
        except BaseException as error:
            errors.append(error)
        finally:
            worker_finished.set()

    thread = threading.Thread(target=work, daemon=True)
    thread.start()
    try:
        assert cancel_started.wait(1), 'Stopped provider batch was not cancelled'
        assert worker_finished.wait(1), 'Provider cancellation blocked worker completion'
        assert harness.stored_batch() == stopped['batch']
        assert harness.refunds == harness.persisted == harness.job_logs == []
        assert calls == ['synthetic-provider-job']
    finally:
        release_cancel.set()
        thread.join(3)
        if cancel_started.is_set():
            assert cancel_finished.wait(1)
        for cancel_thread in cancel_threads:
            cancel_thread.join(1)
            assert not cancel_thread.is_alive()
    assert not thread.is_alive() and not errors
    if cancel_outcome == 'failure':
        assert 'cancel' in caplog.text.lower()
    assert not list(tmp_path.iterdir())
