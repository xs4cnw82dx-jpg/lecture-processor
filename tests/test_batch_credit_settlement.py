from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from threading import Event

import pytest

from tests.test_processing_credit_admission import runtime_fixture, stage_batch
from lecture_processor.domains.ai import batch_orchestrator as batch
from lecture_processor.domains.ai import instant_batch_orchestrator as instant
from lecture_processor.domains.billing import job_charges


def charged_row(monkeypatch, *, extras=False, overnight=False):
    runtime, store = runtime_fixture()
    runtime.cleanup_files = lambda *_: None
    monkeypatch.setattr(batch.study_audio, 'cleanup_failed_job_audio', lambda *_args, **_kwargs: False)
    monkeypatch.setattr(batch, '_cleanup_empty_batch_folder', lambda *_args, **_kwargs: None)
    monkeypatch.setattr(batch, '_send_batch_completion_email_if_needed', lambda *_args, **_kwargs: None)
    stage_batch(runtime, 'batch', 1)
    components = {'primary': {'action': 'interview_transcription' if extras else 'lecture_notes', 'units': 1}}
    if extras:
        components['extras'] = {'action': 'interview_extra', 'units': 2}
    job_charges.admit_batch_row('owner', 'batch', '0', 'interview' if extras else 'lecture-notes',
                              components, overnight=overnight, runtime=runtime)
    job_charges.finish_batch_admission('owner', 'batch', runtime=runtime)
    parent = batch._get_batch('batch', runtime=runtime)
    row = batch._get_row('batch', '0', runtime=runtime)
    row.update(row_job_id='row-job', interview_features_cost=2 if extras else 0, ordinal=0)
    return runtime, store, parent, row


@pytest.mark.parametrize('overnight', [False, True])
def test_terminal_batch_retries_actual_failed_refund(monkeypatch, overnight):
    runtime, store, parent, row = charged_row(monkeypatch, overnight=overnight)
    store.fail_writes.add(('users', 'owner'))
    row.update(status='error', error='Synthetic provider failure')
    batch._refund_failed_row(parent, row, runtime=runtime)
    assert row['credit_refund_pending'] is True
    batch._upsert_row('batch', '0', row, runtime=runtime)
    batch._finalize_batch_record('batch', parent, runtime=runtime)
    store.fail_writes.clear()
    store.now += 181
    batch.get_batch_status('batch', runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 100
    assert batch._get_batch('batch', runtime=runtime)['credits_refund_pending'] == 0


def test_partial_feature_failed_refund_is_durable_and_retried(monkeypatch):
    runtime, store, parent, row = charged_row(monkeypatch, extras=True)
    assert store.docs('users')['owner']['credits'] == 86
    store.fail_writes.add(('users', 'owner'))
    row.update(status='complete', study_pack_id='saved-pack')
    instant._refund_interview_feature_failures(parent, row, 1, runtime=runtime)
    batch._upsert_row('batch', '0', row, runtime=runtime)
    batch._finalize_batch_record('batch', parent, runtime=runtime)
    store.fail_writes.clear()
    store.now += 181
    batch.get_batch_status('batch', runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 88
    receipt = batch._get_row('batch', '0', runtime=runtime)['billing_receipt']
    assert receipt['components']['primary']['refunded_credits'] == 0
    assert receipt['components']['extras']['refunded_credits'] == 2


def test_pack_save_failure_logs_actual_refunded_scalar(monkeypatch):
    runtime, store, parent, row = charged_row(monkeypatch)
    logs = []
    runtime.save_job_log = lambda _job_id, payload, _finished: logs.append(deepcopy(payload))
    monkeypatch.setattr(batch.ai_pipelines, 'save_study_pack', lambda *_args, **_kwargs: False)
    row.update(status='complete', result='Synthetic notes')
    batch._finalize_row_job_log(parent, row, runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 100
    assert logs[0]['billing_receipt']['refunded_credits'] == 8
    assert logs[0]['refunded_credits'] == 8


def test_periodic_batch_retry_uses_the_original_receipt_after_lost_ack(monkeypatch):
    runtime, store, parent, row = charged_row(monkeypatch, extras=True, overnight=True)
    store.fail_writes.add(('users', 'owner'))
    row.update(status='complete', study_pack_id='saved-pack')
    instant._refund_interview_feature_failures(parent, row, 1, runtime=runtime)
    batch._upsert_row('batch', '0', row, runtime=runtime)
    batch._finalize_batch_record('batch', parent, runtime=runtime)
    store.fail_writes.clear()
    log_options = []
    runtime.save_job_log = lambda *_args, **kwargs: log_options.append(kwargs)
    original_finished = batch._get_batch('batch', runtime=runtime)['finished_at']

    def lose_refund_ack(operations):
        if any(reference.path[0] == 'credit_refunds' for _operation, reference, _payload, _merge in operations):
            store.after_commit = None
            raise RuntimeError('Synthetic lost acknowledgement')

    store.after_commit = lose_refund_ack
    store.now += 181
    assert batch.recover_stale_batches(runtime=runtime) == 1
    assert store.docs('users')['owner']['credits'] == 94  # 5 primary + one successful extra.
    store.now += 181
    assert batch.recover_stale_batches(runtime=runtime) == 1
    assert batch.recover_stale_batches(runtime=runtime) == 0
    assert store.docs('users')['owner']['credits'] == 94
    assert len(store.docs('credit_refunds')) == 1
    current = batch._get_row('batch', '0', runtime=runtime)
    assert current['billing_receipt']['components']['primary']['refunded_credits'] == 0
    assert current['billing_receipt']['components']['extras']['refunded_credits'] == 1
    assert batch._get_batch('batch', runtime=runtime)['finished_at'] == original_finished
    assert log_options == [{'record_metrics': False}, {'record_metrics': False}]


def test_transactional_batch_claim_blocks_overlapping_refund_retry(monkeypatch):
    runtime, store, parent, row = charged_row(monkeypatch)
    store.fail_writes.add(('users', 'owner'))
    row.update(status='error')
    batch._refund_failed_row(parent, row, runtime=runtime)
    batch._upsert_row('batch', '0', row, runtime=runtime)
    parent = batch._finalize_batch_record('batch', parent, runtime=runtime)
    store.fail_writes.clear()
    began, release = Event(), Event()
    actual_refund = job_charges.refund_component
    calls = []

    def refund(*args, **kwargs):
        calls.append(args[3])
        began.set()
        assert release.wait(timeout=2)
        return actual_refund(*args, **kwargs)

    monkeypatch.setattr(job_charges, 'refund_component', refund)
    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(batch._retry_batch_refunds, parent, runtime=runtime)
        try:
            assert began.wait(timeout=2)
            batch._retry_batch_refunds(parent, runtime=runtime)
            assert calls == ['batch-row:batch:0:primary']
        finally:
            release.set()
        first.result(timeout=2)
    assert store.docs('users')['owner']['credits'] == 100
    assert len(store.docs('credit_refunds')) == 1


def test_retry_repairs_a_stale_parent_pending_flag_after_another_process_settled(monkeypatch):
    runtime, store, parent, row = charged_row(monkeypatch)
    row.update(status='error')
    batch._refund_failed_row(parent, row, runtime=runtime)
    batch._upsert_row('batch', '0', row, runtime=runtime)
    parent = batch._finalize_batch_record('batch', parent, runtime=runtime)
    runtime.batch_repo.update_batch_job_fields(runtime.db, 'batch', {
        'credit_refund_retry_pending': True, 'credits_refund_pending': 8, 'credits_refunded': 0,
    })
    batch.get_batch_status('batch', runtime=runtime)
    current = batch._get_batch('batch', runtime=runtime)
    assert current['credit_refund_retry_pending'] is False
    assert current['credits_refund_pending'] == 0 and current['credits_refunded'] == 8
    assert store.docs('users')['owner']['credits'] == 100
