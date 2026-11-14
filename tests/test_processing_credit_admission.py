from copy import deepcopy
from threading import RLock
from types import SimpleNamespace

import pytest

from tests.credit_test_support import make_credit_runtime
from lecture_processor.domains.billing import job_charges, ledger, receipts
from lecture_processor.domains.runtime_jobs import recovery
from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.repositories import batch_repo, runtime_jobs_repo
from lecture_processor.services import job_state_service
from lecture_processor.services import upload_runtime_service
from lecture_processor.services import tools_transcription_service
from lecture_processor.services import tools_extraction_service
from lecture_processor.services import upload_batch_support
from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.ai import pipelines


def runtime_fixture(*, enabled=True, user=None):
    runtime, store = make_credit_runtime(
        users={'owner': user or {'uid': 'owner', 'credits_version': 2, 'credits': 100, 'total_processed': 0}},
        unified_enabled=enabled,
    )
    runtime.runtime_jobs_repo = runtime_jobs_repo
    runtime.batch_repo = batch_repo
    runtime.RUNTIME_JOBS_COLLECTION = 'runtime_jobs'
    runtime.RUNTIME_JOB_PERSISTED_FIELDS = PERSISTED_RUNTIME_JOB_FIELDS
    runtime.job_state_service = job_state_service
    runtime.jobs = {}
    runtime.JOBS_LOCK = RLock()
    runtime.RUNTIME_JOB_RECOVERY_ENABLED = True
    runtime.RUNTIME_JOB_RECOVERY_BATCH_LIMIT = 200
    runtime.os = SimpleNamespace(getenv=lambda *_: '', getpid=lambda: 7)
    runtime.save_job_log = lambda *_, **__: None
    return runtime, store


PRIMARY = {'primary': {'action': 'lecture_notes', 'units': 1}}


def test_runtime_debit_is_durable_before_full_job_initialization_and_recoverable_with_flag_off():
    runtime, store = runtime_fixture()
    receipt = job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    assert receipt['charged_credits'] == 8
    assert store.docs('users')['owner']['credits'] == 92
    assert store.docs('runtime_jobs')['job']['charged_credits'] == 8
    runtime.jobs.clear()  # A process ended before its service initialized/dispatched work.
    runtime.UNIFIED_CREDITS_ENABLED = False
    store.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert store.docs('users')['owner']['credits'] == 100
    assert store.docs('users')['owner']['total_processed'] == 0
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 0
    assert len(store.docs('credit_refunds')) == 1


def test_failed_durable_job_write_rolls_back_balance_and_journal():
    runtime, store = runtime_fixture()
    store.fail_writes.add(('runtime_jobs', 'job'))
    with pytest.raises(ledger.LedgerUnavailable):
        job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 100
    assert not store.docs('credit_charges')
    assert not runtime.jobs


def test_lost_admission_ack_uses_committed_receipt_without_a_second_debit():
    runtime, store = runtime_fixture()

    def lose_ack(_operations):
        store.after_commit = None
        raise RuntimeError('Synthetic lost acknowledgement')

    store.after_commit = lose_ack
    receipt = job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    assert receipt['charged_credits'] == 8
    assert store.docs('users')['owner']['credits'] == 92
    assert len(store.docs('credit_charges')) == 1


@pytest.mark.parametrize('enabled,version,expected_scheme,expected_cost', [
    (False, 1, 1, 1), (True, 1, 2, 8), (False, 2, 2, 8),
])
def test_admission_chooses_scheme_from_transaction_user(enabled, version, expected_scheme, expected_cost):
    user = {'uid': 'owner', 'lecture_credits_extended': 3, 'total_processed': 0}
    if version == 2:
        user.update(credits_version=2, credits=24, lecture_credits_extended=0)
    runtime, store = runtime_fixture(enabled=enabled, user=user)
    receipt = job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    assert receipt['credit_scheme'] == expected_scheme
    assert receipt['charged_credits'] == expected_cost
    current = store.docs('users')['owner']
    if expected_scheme == 1:
        assert current['lecture_credits_extended'] == 2 and 'credits_version' not in current
        assert job_charges.primary_credit_type(receipt) == 'lecture_credits_extended'
    else:
        assert current['credits'] == 16


def test_initialization_and_legacy_receipt_helpers_cannot_overwrite_committed_components():
    runtime, _store = runtime_fixture()
    original = job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    job = job_charges.set_admitted_job('job', {
        'user_id': 'owner', 'status': 'queued', 'billing_receipt': {'charged': {'lecture_credits_standard': 1}},
    }, runtime=runtime)
    receipts.ensure_job_billing_receipt(job, {'slides_credits': 9}, runtime=runtime)
    receipts.add_job_credit_refund(job, 'lecture_credits_standard', 1, runtime=runtime)
    assert job['billing_receipt'] == original
    copy = receipts.get_billing_receipt_snapshot(job, runtime=runtime)
    copy['components']['primary']['unit_cost'] = 999
    assert job['billing_receipt']['components']['primary']['unit_cost'] == 8


def stage_batch(runtime, batch_id, rows):
    runtime.batch_repo.batch_job_doc_ref(runtime.db, batch_id).set({
        'uid': 'owner', 'status': 'preparing', 'credit_admission_state': 'pending',
        'admitted_rows': 0, 'total_rows': rows, 'credits_charged': 0,
    })
    for index in range(rows):
        runtime.batch_repo.batch_row_doc_ref(runtime.db, batch_id, str(index)).set({
            'uid': 'owner', 'row_id': str(index), 'batch_id': batch_id, 'status': 'queued',
        })


def test_large_batch_admission_keeps_transactions_bounded_and_exact_half_price():
    runtime, store = runtime_fixture(user={'uid': 'owner', 'credits_version': 2, 'credits': 4000})
    stage_batch(runtime, 'batch', 499)
    writes = []
    store.before_commit = lambda operations: writes.append(len(operations))
    for index in range(499):
        receipt = job_charges.admit_batch_row('owner', 'batch', str(index), 'lecture-notes', PRIMARY,
                                             overnight=True, runtime=runtime)
        assert receipt['charged_credits'] == 4
    job_charges.finish_batch_admission('owner', 'batch', runtime=runtime)
    assert max(writes) <= 4
    assert store.docs('users')['owner']['credits'] == 4000 - 499 * 4
    parent = runtime.batch_repo.get_batch_job_doc(runtime.db, 'batch').to_dict()
    assert parent['status'] == 'queued' and parent['admitted_rows'] == 499


def test_replayed_batch_row_admission_never_increments_the_parent_twice():
    runtime, store = runtime_fixture()
    stage_batch(runtime, 'batch', 1)
    original = job_charges.admit_batch_row('owner', 'batch', '0', 'lecture-notes', PRIMARY,
                                          overnight=True, runtime=runtime)
    replayed = job_charges.admit_batch_row('owner', 'batch', '0', 'lecture-notes', PRIMARY,
                                          overnight=True, runtime=runtime)
    assert replayed == original
    job_charges.finish_batch_admission('owner', 'batch', runtime=runtime)
    parent = runtime.batch_repo.get_batch_job_doc(runtime.db, 'batch').to_dict()
    assert parent['admitted_rows'] == 1 and parent['credits_charged'] == 4
    assert store.docs('users')['owner']['credits'] == 96


def test_interrupted_batch_closes_admission_before_refunding_charged_rows():
    runtime, store = runtime_fixture()
    stage_batch(runtime, 'batch', 2)
    job_charges.admit_batch_row('owner', 'batch', '0', 'lecture-notes', PRIMARY, overnight=True, runtime=runtime)
    job_charges.close_batch_admission('batch', runtime=runtime)
    with pytest.raises(ledger.LedgerConflict):
        job_charges.admit_batch_row('owner', 'batch', '1', 'lecture-notes', PRIMARY, overnight=True, runtime=runtime)
    row = runtime.batch_repo.get_batch_row_doc(runtime.db, 'batch', '0').to_dict()
    assert job_charges.refund_component(row, 'primary', 1, 'batch-row:batch:0:primary', processed_count=1, runtime=runtime)
    assert job_charges.refund_component(row, 'primary', 1, 'batch-row:batch:0:primary', processed_count=1, runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 100
    assert len(store.docs('credit_charges')) == 1


def test_partial_extra_refund_uses_original_price_and_is_cumulative():
    runtime, store = runtime_fixture()
    components = {'primary': {'action': 'interview_transcription', 'units': 1},
                  'extras': {'action': 'interview_extra', 'units': 3}}
    job_charges.admit_runtime_job('owner', 'job', 'interview', components, runtime=runtime)
    job = deepcopy(runtime.jobs['job'])
    assert store.docs('users')['owner']['credits'] == 84
    runtime.UNIFIED_CREDITS_ENABLED = False
    assert job_charges.refund_component(job, 'extras', 1, 'runtime-job:job:extras', runtime=runtime)
    assert job_charges.refund_component(job, 'extras', 2, 'runtime-job:job:extras', runtime=runtime)
    assert job_charges.refund_component(job, 'extras', 2, 'runtime-job:job:extras', runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 88
    assert job['billing_receipt']['components']['primary']['refunded_credits'] == 0


def test_missing_v2_receipt_never_falls_back_to_a_legacy_refund():
    runtime, store = runtime_fixture()
    assert not job_charges.refund_component({'user_id': 'owner', 'credit_scheme': 2}, 'primary', 1,
                                           'runtime-job:missing:primary', legacy_credit_type='lecture_credits_standard',
                                           legacy_charged_units=1, processed_count=1, runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 100
    assert not store.docs('credit_refunds')


def test_initialization_cannot_reopen_a_refunded_job_from_a_stale_memory_snapshot():
    runtime, store = runtime_fixture()
    job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    stale = deepcopy(runtime.jobs['job'])
    store.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    runtime.jobs['job'] = stale
    with pytest.raises(ledger.LedgerConflict):
        job_charges.set_admitted_job('job', {'user_id': 'owner', 'status': 'queued'}, runtime=runtime)
    assert store.docs('runtime_jobs')['job']['status'] == 'error'
    assert store.docs('users')['owner']['credits'] == 100


def test_lost_row_ack_after_recovery_closed_admission_cannot_return_an_active_row():
    runtime, store = runtime_fixture()
    stage_batch(runtime, 'batch', 2)

    def recover_after_commit(_operations):
        store.after_commit = None
        job_charges.close_batch_admission('batch', runtime=runtime)
        row = runtime.batch_repo.get_batch_row_doc(runtime.db, 'batch', '0').to_dict()
        assert job_charges.refund_component(row, 'primary', 1, 'batch-row:batch:0:primary', processed_count=1, runtime=runtime)
        raise RuntimeError('Synthetic lost acknowledgement')

    store.after_commit = recover_after_commit
    with pytest.raises(ledger.LedgerUnavailable):
        job_charges.admit_batch_row('owner', 'batch', '0', 'lecture-notes', PRIMARY, overnight=True, runtime=runtime)
    with pytest.raises(ledger.LedgerConflict):
        job_charges.finish_batch_admission('owner', 'batch', runtime=runtime)
    assert store.docs('users')['owner']['credits'] == 100


def test_legacy_public_status_and_batch_receipts_keep_the_original_shape(monkeypatch):
    runtime, _store = runtime_fixture(enabled=False, user={'uid': 'owner', 'lecture_credits_standard': 2})
    internal = job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    internal['updated_at'] = 1000.0
    runtime.jobs['job']['billing_receipt'] = deepcopy(internal)
    runtime.verify_firebase_token = lambda _request: {'uid': 'owner'}
    runtime.jsonify = lambda value: value
    expected = {'charged': {'lecture_credits_standard': 1}, 'refunded': {}, 'updated_at': 1000.0}
    assert upload_runtime_service.get_status(runtime, object(), 'job')['billing_receipt'] == expected
    row = {'row_id': 'row', 'status': 'complete', 'billing_receipt': deepcopy(internal)}
    batch = {'batch_id': 'batch', 'status': 'complete', 'total_rows': 1, 'completed_rows': 1}
    monkeypatch.setattr(batch_orchestrator, '_get_batch', lambda *_args, **_kwargs: batch)
    monkeypatch.setattr(batch_orchestrator, '_repair_batch_state_if_needed', lambda *_args, **_kwargs: (batch, [row]))
    response = batch_orchestrator.get_batch_status('batch', runtime=runtime)
    assert response['rows'][0]['billing_receipt'] == expected
    assert runtime.jobs['job']['billing_receipt']['components'] == internal['components']
    assert row['billing_receipt']['charge_ref'] == internal['charge_ref']


@pytest.mark.parametrize('scheme,amount,expected', [(2, 8, True), (2, 0, False), (1, 8, False), (None, 8, False)])
def test_scalar_refund_history_is_only_recognized_for_the_unified_scheme(scheme, amount, expected):
    assert receipts.job_has_refunds({'credit_scheme': scheme, 'refunded_credits': amount}) is expected


@pytest.mark.parametrize('enabled,user,needed,available', [
    (False, {'credits_version': 2, 'credits': 7}, 8, 7),
    (True, {'lecture_credits_standard': 0, 'slides_credits': 3}, 8, 6),
    (False, {'credits_version': 2, 'credits': 8}, None, None),
    (True, {'lecture_credits_standard': 1}, None, None),
])
def test_action_preflight_uses_the_same_version_and_quote_as_admission(enabled, user, needed, available):
    runtime, _store = runtime_fixture(enabled=enabled, user={'uid': 'owner', **user})
    error, status = job_charges.credit_preflight_error(
        user, PRIMARY, legacy_checks=[('lecture', 1, 'Original lecture message.')], runtime=runtime,
    )
    if needed is None:
        assert (error, status) == (None, 0)
    else:
        assert status == 402 and error['needed'] == needed and error['available'] == available


def test_legacy_preflight_preserves_message_and_unified_bad_balance_fails_closed():
    runtime, _store = runtime_fixture(enabled=False)
    assert job_charges.credit_preflight_error(
        {}, PRIMARY, legacy_checks=[('lecture', 1, 'Original lecture message.')], runtime=runtime,
    ) == ({'error': 'Original lecture message.'}, 402)
    error, status = job_charges.credit_preflight_error(
        {'credits_version': 2, 'credits': 'broken'}, PRIMARY, runtime=runtime,
    )
    assert status == 503 and error['error_code'] == 'credit_service_unavailable'


@pytest.mark.parametrize('unlimited,expected_refund', [(False, 10), (True, 0)])
def test_transcription_failure_persists_the_actual_receipt_refund(unlimited, expected_refund):
    runtime, store = runtime_fixture(user={
        'uid': 'owner', 'credits_version': 2, 'credits': 100,
        'unlimited_credits': {'interview': unlimited},
    })
    job_charges.admit_runtime_job('owner', 'job', 'general-transcription', {
        'primary': {'action': 'tools_transcription', 'units': 1},
    }, runtime=runtime)
    runtime.convert_audio_to_mp3_with_ytdlp = lambda _path: (_ for _ in ()).throw(RuntimeError('Synthetic conversion failure'))
    runtime.cleanup_files = lambda *_args: None
    runtime.PROCESSING_PUBLIC_ERROR_MESSAGE = 'Processing could not finish. Please try again.'
    tools_transcription_service._run_general_transcription_job(runtime, 'job', '/synthetic/audio.wav')
    persisted = store.docs('runtime_jobs')['job']
    assert persisted['refunded_credits'] == expected_refund
    assert persisted['billing_receipt']['components']['primary']['refunded_credits'] == expected_refund
    assert persisted['credit_refunded'] is (expected_refund > 0)
    assert store.docs('users')['owner']['credits'] == 100
    assert store.docs('users')['owner']['total_processed'] == 0


def test_dispatched_callback_cannot_start_an_initialized_job_recovered_before_execution():
    runtime, store = runtime_fixture()
    job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    job_charges.set_admitted_job('job', {'user_id': 'owner', 'status': 'queued'}, runtime=runtime)
    stale = deepcopy(runtime.jobs['job'])
    store.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    runtime.jobs['job'] = stale
    assert job_charges.begin_runtime_job('job', runtime=runtime) is False
    assert store.docs('runtime_jobs')['job']['status'] == 'error'
    assert store.docs('users')['owner']['credits'] == 100


def test_admitted_worker_starts_once_and_logs_recorded_amounts():
    runtime, _store = runtime_fixture()
    job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    assert job_charges.begin_runtime_job('job', runtime=runtime) is True
    assert job_charges.begin_runtime_job('job', runtime=runtime) is False
    assert job_charges.runtime_receipt_fields('job', runtime=runtime)['charged_credits'] == 8
    assert job_charges.refund_runtime_component('job', 'primary', 1, runtime=runtime)
    fields = job_charges.runtime_receipt_fields('job', runtime=runtime)
    assert fields['refunded_credits'] == 8 and fields['credit_refunded'] is True


def test_failed_runtime_refund_is_retried_after_restart_without_refunding_unmarked_errors():
    runtime, store = runtime_fixture()
    log_options = []
    runtime.save_job_log = lambda *_args, **kwargs: log_options.append(kwargs)
    job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    store.documents[('runtime_jobs', 'unmarked')] = {
        'status': 'error', 'user_id': 'owner', 'credit_deducted': 'lecture_credits_standard',
        'updated_at': 1, 'billing_receipt': {'charged': {'lecture_credits_standard': 1}},
    }
    store.fail_writes.add(('users', 'owner'))
    store.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert store.docs('users')['owner']['credits'] == 92
    runtime.jobs.clear()
    store.fail_writes.clear()
    store.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert store.docs('users')['owner']['credits'] == 100
    assert store.docs('runtime_jobs')['job']['credit_refund_pending'] is False
    assert store.docs('runtime_jobs')['unmarked'].get('credit_refunded') is None
    store.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 0
    assert len(store.docs('credit_refunds')) == 1
    assert log_options == [{}, {'record_metrics': False}]


def test_completed_job_retries_only_pending_extras_after_lost_refund_ack():
    runtime, store = runtime_fixture()
    components = {'primary': {'action': 'interview_transcription', 'units': 1},
                  'extras': {'action': 'interview_extra', 'units': 2}}
    job_charges.admit_runtime_job('owner', 'job', 'interview', components, runtime=runtime)
    job = runtime.jobs['job']
    job.update(status='complete', finished_at=store.now, extra_slides_refund_pending=1,
               extra_slides_refunded=0, interview_features_cost=2)
    runtime_jobs_repo.set_doc(runtime.db, 'runtime_jobs', 'job', job, merge=True)
    runtime.jobs.clear()
    store.now += 181

    def lose_refund_ack(operations):
        if any(reference.path[0] == 'credit_refunds' for _operation, reference, _payload, _merge in operations):
            store.after_commit = None
            raise RuntimeError('Synthetic refund acknowledgement lost')

    store.after_commit = lose_refund_ack
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    store.now += 181
    recovery.recover_stale_runtime_jobs(runtime=runtime)
    current = store.docs('runtime_jobs')['job']
    assert current['status'] == 'complete'
    assert current['billing_receipt']['components']['primary']['refunded_credits'] == 0
    assert current['billing_receipt']['components']['extras']['refunded_credits'] == 2
    assert current['extra_slides_refund_pending'] == 0
    assert store.docs('users')['owner']['credits'] == 88
    assert store.docs('users')['owner']['total_processed'] == 1
    assert len(store.docs('credit_refunds')) == 1


def test_known_legacy_pending_receipt_retries_in_old_units_after_account_conversion():
    runtime, store = runtime_fixture(enabled=False)
    store.documents[('runtime_jobs', 'job')] = {
        'status': 'error', 'user_id': 'owner', 'credit_deducted': 'lecture_credits_standard',
        'credit_refund_pending': True, 'updated_at': 1,
        'billing_receipt': {'charged': {'lecture_credits_standard': 1}, 'refunded': {}},
    }
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert store.docs('users')['owner']['credits'] == 108
    assert next(iter(store.docs('credit_refunds').values()))['amount'] == 1
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 0


def test_setup_error_never_deletes_the_only_durable_admission_when_status_update_fails(monkeypatch):
    runtime, store = runtime_fixture()
    job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', PRIMARY, runtime=runtime)
    runtime.jsonify = lambda value: value
    runtime.cleanup_files = lambda *_args: None
    store.fail_writes.add(('users', 'owner'))
    monkeypatch.setattr(upload_batch_support.runtime_jobs_store, 'update_job_fields', lambda *_args, **_kwargs: None)
    response, status = upload_batch_support.handle_runtime_job_setup_failure(
        runtime, job_id='job', uid='owner', cleanup_paths=[], credit_type='lecture_credits_standard',
    )
    assert status == 500 and response['status'] == 'setup_failed'
    assert store.docs('runtime_jobs')['job']['charge_ref'] == 'runtime-job:job'
    store.fail_writes.clear()
    runtime.jobs.clear()
    store.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert store.docs('users')['owner']['credits'] == 100


@pytest.mark.parametrize('handler', ['handle_runtime_job_queue_full', 'handle_runtime_job_setup_failure'])
def test_dispatch_failure_records_each_unsettled_component_for_retry(handler):
    runtime, store = runtime_fixture()
    components = {**PRIMARY, 'extras': {'action': 'interview_extra', 'units': 1}}
    job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', components, runtime=runtime)
    runtime.jsonify = lambda value: SimpleNamespace(payload=value, status_code=200, headers={})
    runtime.cleanup_files = lambda *_args: None
    runtime.get_background_queue_stats = lambda: {}
    store.fail_writes.add(('users', 'owner'))
    getattr(upload_batch_support, handler)(
        runtime, job_id='job', uid='owner', cleanup_paths=[],
        credit_type='lecture_credits_standard', extra_slides_credits=1,
    )
    current = store.docs('runtime_jobs')['job']
    assert current['status'] == 'error'
    assert current['credit_refund_pending'] is True
    assert current['extra_slides_refund_pending'] == 1
    store.fail_writes.clear()
    runtime.jobs.clear()
    store.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert store.docs('users')['owner']['credits'] == 100
    assert store.docs('users')['owner']['total_processed'] == 0


def test_successful_worker_refunds_clear_durable_primary_and_extras_markers():
    runtime, store = runtime_fixture()
    components = {**PRIMARY, 'extras': {'action': 'interview_extra', 'units': 1}}
    job_charges.admit_runtime_job('owner', 'job', 'lecture-notes', components, runtime=runtime)
    job = runtime.jobs['job']
    job.update(credit_refund_pending=True, credit_refund_error='pending', extra_slides_refund_pending=1,
               interview_features_cost=1)
    runtime_jobs_repo.set_doc(runtime.db, 'runtime_jobs', 'job', job, merge=True)
    assert pipelines._refund_primary_job_credit('job', job, 'owner', 'lecture_credits_standard', runtime=runtime)
    assert pipelines._refund_extra_slides('job', job, 'owner', 1, runtime=runtime)
    persisted = store.docs('runtime_jobs')['job']
    assert persisted['credit_refund_pending'] is False
    assert persisted['credit_refund_error'] == ''
    assert persisted['extra_slides_refund_pending'] == 0


def test_extraction_failure_records_pending_refund_and_preserves_receipt_in_history(monkeypatch):
    runtime, store = runtime_fixture()
    job_charges.admit_runtime_job('owner', 'job', 'tools', {
        'primary': {'action': 'tools_extraction', 'units': 1},
    }, runtime=runtime)
    runtime.cleanup_files = lambda *_args: None
    logs = []
    runtime.save_job_log = lambda _id, data, _time, **_kwargs: logs.append(deepcopy(data))
    monkeypatch.setattr(tools_extraction_service.tools_extraction_support, 'fetch_tools_url_text',
                        lambda _url: ('', 'Synthetic extraction failure', 'text/plain'))
    monkeypatch.setattr(tools_extraction_service.analytics_events, 'log_analytics_event', lambda *_args, **_kwargs: None)
    staged = tools_extraction_service._StagedToolInput(
        source_type='url', source_url='https://example.invalid/source', prompt_template_key='',
        prompt_source='custom', custom_prompt='', extension='', mime_type='text/html', staged_paths=(),
        normalized_input_name='source', normalized_input_names=(), upload_mime_type='', source_size_mb=0,
    )
    store.fail_writes.add(('users', 'owner'))
    tools_extraction_service._run_tools_extract_job(runtime, 'job', 'owner', '', staged, 'slides_credits', 0)
    current = store.docs('runtime_jobs')['job']
    assert current['credit_refund_pending'] is True
    assert logs[0]['charged_credits'] == 2 and logs[0]['billing_receipt']['charge_ref'] == 'runtime-job:job'
    store.fail_writes.clear()
    runtime.jobs.clear()
    store.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert store.docs('users')['owner']['credits'] == 100
