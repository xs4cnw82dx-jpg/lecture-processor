from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from functools import wraps
import logging
import json
from threading import Event, RLock
from types import SimpleNamespace

import pytest

from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.domains.runtime_jobs import execution, recovery
from lecture_processor.domains.study import interview_coding_runs
from lecture_processor.domains.account import lifecycle
from lecture_processor.repositories import runtime_jobs_repo, study_repo, users_repo
from lecture_processor.services import interview_coding_service as service, job_state_service, upload_runtime_service


class Increment:
    def __init__(self, value):
        self.value = value


class Snapshot:
    def __init__(self, ref):
        self.reference, self.id = ref, ref.id
        self.payload = deepcopy(ref.state.documents.get(ref.path))
        self.exists = self.payload is not None

    def to_dict(self):
        return deepcopy(self.payload)


class Reference:
    def __init__(self, state, collection, document_id):
        self.state, self.id, self.path = state, document_id, (collection, document_id)

    def get(self, transaction=None):
        if transaction is not None:
            assert not transaction.operations, 'Read after transaction write'
        return Snapshot(self)

    def set(self, payload, merge=False):
        transaction = Transaction(self.state)
        transaction.set(self, payload, merge)
        transaction.commit()

    def update(self, payload):
        self.set(payload, merge=True)


class Query:
    def __init__(self, state, collection, filters=(), limit=None):
        self.state, self.collection, self.filters, self.maximum = state, collection, filters, limit

    def document(self, key=None):
        if key is None:
            self.state.serial += 1
            key = f'run-{self.state.serial}'
        return Reference(self.state, self.collection, key)

    def where(self, *args, filter=None):
        condition = (filter.field_path, filter.op_string, filter.value) if filter is not None else args
        return Query(self.state, self.collection, (*self.filters, condition), self.maximum)

    def limit(self, limit):
        return Query(self.state, self.collection, self.filters, limit)

    def stream(self, transaction=None):
        if transaction is not None:
            assert not transaction.operations

        def matches(data, condition):
            field, operator, value = condition
            actual = data.get(field)
            if operator == '==':
                return actual == value
            if operator == 'in':
                return actual in value
            if operator == '>':
                return actual is not None and actual > value
            raise AssertionError(f'Unsupported query operator: {operator}')

        docs = []
        for (collection, key), data in list(self.state.documents.items()):
            if collection != self.collection:
                continue
            if all(matches(data, condition) for condition in self.filters):
                docs.append(self.document(key).get())
        return iter(docs[:self.maximum])


class Transaction:
    def __init__(self, state):
        self.state, self.operations = state, []

    def set(self, ref, payload, merge=False):
        self.operations.append((ref, deepcopy(payload), merge))

    def update(self, ref, payload):
        self.set(ref, payload, True)

    def commit(self):
        if self.state.before_commit:
            self.state.before_commit(self.operations)
        for ref, payload, merge in self.operations:
            target = self.state.documents.setdefault(ref.path, {}) if merge else {}
            for key, value in payload.items():
                target[key] = target.get(key, 0) + value.value if isinstance(value, Increment) else deepcopy(value)
            self.state.documents[ref.path] = target
        if self.state.after_commit:
            self.state.after_commit(self.operations)


@pytest.fixture
def coding(monkeypatch):
    state = SimpleNamespace(documents={}, serial=0, now=1000.0, before_commit=None, after_commit=None,
                            queued=[], provider_calls=0, uid='owner', transcript='Hello world')
    lock = RLock()

    def transactional(callback):
        @wraps(callback)
        def execute(transaction, *args, **kwargs):
            with lock:
                result = callback(transaction, *args, **kwargs)
                transaction.commit()
                return result
        return execute

    def generate(*_args, **_kwargs):
        state.provider_calls += 1
        return SimpleNamespace(text='{"codes":[{"temp_id":"c1","name":"Guidance"}],"quotations":[]}')

    def submit(target, *args, **kwargs):
        state.queued.append((target, args, kwargs))

    state.db = SimpleNamespace(collection=lambda name: Query(state, name), transaction=lambda: Transaction(state))
    state.runtime = SimpleNamespace(
        db=state.db, firestore=SimpleNamespace(transactional=transactional, Increment=Increment),
        repositories=SimpleNamespace(study=study_repo, runtime_jobs=runtime_jobs_repo, users=users_repo), users_repo=users_repo, runtime_jobs_repo=runtime_jobs_repo,
        batch_repo=SimpleNamespace(list_batch_jobs_by_uid_and_statuses=lambda *_args, **_kwargs: []),
        time=SimpleNamespace(time=lambda: state.now), jsonify=lambda payload: payload,
        logger=logging.getLogger('test-coding'), client=object(), jobs={}, JOBS_LOCK=RLock(),
        job_state_service=job_state_service, RUNTIME_JOBS_COLLECTION='runtime_jobs',
        RUNTIME_JOB_PERSISTED_FIELDS=PERSISTED_RUNTIME_JOB_FIELDS, JOB_TTL_SECONDS=1800,
        RUNTIME_JOB_RECOVERY_ENABLED=True, RUNTIME_JOB_RECOVERY_BATCH_LIMIT=100,
        MAX_ACTIVE_JOBS_PER_USER=2, PROMPT_INTERVIEW_CODING='Synthetic prompt', is_admin_user=lambda _token: False,
        submit_background_job=submit, save_job_log=lambda *_args: None,
    )
    state.documents[('users', 'owner')] = {'uid': 'owner', 'account_status': 'active', 'slides_credits': 10}
    state.documents[('study_packs', 'pack-1')] = {'uid': 'owner', 'mode': 'interview', 'title': 'Interview'}
    state.runtime.get_or_create_user = lambda *_args: deepcopy(state.documents[('users', 'owner')])
    monkeypatch.setattr(service.study_api_support, 'require_user', lambda *_args: ({'uid': state.uid}, None, None))
    monkeypatch.setattr(service.study_api_support, 'account_write_guard', lambda *_args: None)
    monkeypatch.setattr(service, '_require_interview_pack', lambda *_args: (deepcopy(state.documents.get(('study_packs', 'pack-1'), {})), state.transcript, None, None))
    monkeypatch.setattr(service.ai_provider, 'generate_with_policy', generate)
    monkeypatch.setattr(service.ai_provider, 'extract_token_usage', lambda *_args, **_kwargs: {})
    state.start = lambda: service.start_ai_coding_run(state.runtime, None, 'pack-1')
    state.docs = lambda collection: {key: value for (kind, key), value in state.documents.items() if kind == collection}
    def work():
        target, args, kwargs = state.queued.pop(0)
        return target(*args, **kwargs)

    state.work = work
    return state


def test_start_is_background_and_durably_charged_once(coding):
    payload, status = coding.start()
    assert status == 202
    assert payload['run']['status'] == 'queued'
    assert coding.provider_calls == 0
    assert len(coding.queued) == 1
    run_id = payload['run']['run_id']
    assert coding.docs('runtime_jobs')[run_id]['status'] == 'queued'
    assert coding.docs('users')['owner']['slides_credits'] == 9
    replay, replay_status = coding.start()
    assert replay_status == 202 and replay['run']['run_id'] == run_id
    assert len(coding.queued) == 1
    assert coding.docs('users')['owner']['slides_credits'] == 9


def test_concurrent_start_reuses_one_run_and_charge(coding):
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(lambda _: coding.start(), range(2)))
    assert len(coding.docs('interview_ai_coding_runs')) == 1
    assert coding.docs('users')['owner']['slides_credits'] == 9
    assert len(coding.queued) == 1
    assert {result[1] for result in results} == {202}


def test_existing_draft_is_reused_without_charge(coding):
    coding.documents[('interview_ai_coding_runs', 'legacy')] = {
        'uid': 'owner', 'pack_id': 'pack-1', 'status': 'draft', 'created_at': 1,
        'proposed_codes': [{'temp_id': 'c1', 'name': 'Existing draft'}],
    }
    result = coding.start()
    payload = result[0] if isinstance(result, tuple) else result
    assert payload['run']['run_id'] == 'legacy'
    assert coding.docs('users')['owner']['slides_credits'] == 10
    assert coding.provider_calls == 0


def start(coding):
    response, status = coding.start()
    assert status == 202
    return response['run']['run_id']


def test_worker_completes_draft_and_repeated_start_reuses_it(coding):
    run_id = start(coding)
    coding.work()
    run = coding.docs('interview_ai_coding_runs')[run_id]
    assert run['status'] == 'draft' and run['proposed_codes'][0]['name'] == 'Guidance'
    assert coding.docs('runtime_jobs')[run_id]['status'] == 'complete'
    assert lifecycle.count_active_jobs_for_user('owner', runtime=coding.runtime) == 0
    payload, status = coding.start()
    assert status == 200 and payload['run']['run_id'] == run_id and payload['reused'] is True
    assert coding.docs('users')['owner']['slides_credits'] == 9
    assert coding.provider_calls == 1 and not coding.queued


def test_claim_commit_failure_does_not_debit_or_dispatch(coding):
    def fail(operations):
        if any(payload.get('status') == 'queued' for _ref, payload, _merge in operations):
            raise RuntimeError('Synthetic commit rejection')
    coding.before_commit = fail
    _payload, status = coding.start()
    assert status == 503
    assert coding.docs('users')['owner']['slides_credits'] == 10
    assert not coding.docs('interview_ai_coding_runs') and not coding.docs('runtime_jobs') and not coding.queued


def test_lost_claim_ack_reuses_committed_debit_and_run(coding):
    def lose_ack(operations):
        if any(payload.get('status') == 'queued' for _ref, payload, _merge in operations):
            coding.after_commit = None
            raise RuntimeError('Synthetic lost commit acknowledgement')
    coding.after_commit = lose_ack
    run_id = start(coding)
    assert coding.start()[0]['run']['run_id'] == run_id
    assert len(coding.queued) == 1 and len(coding.docs('interview_ai_coding_runs')) == 1
    assert coding.docs('users')['owner']['slides_credits'] == 9


def test_dispatch_rejection_refunds_the_same_durable_run(coding):
    coding.runtime.submit_background_job = lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError('Queue full'))
    payload, _status = coding.start()
    assert payload['run']['status'] == 'failed' and payload['run']['credit_refunded'] is True
    assert coding.docs('users')['owner']['slides_credits'] == 10
    assert len(coding.docs('credit_refunds')) == 1


def test_worker_error_is_private_and_refund_is_idempotent(coding, monkeypatch, caplog):
    run_id = start(coding)
    monkeypatch.setattr(service.ai_provider, 'generate_with_policy', lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError('Synthetic provider detail 12345')))
    coding.work()
    run = coding.docs('interview_ai_coding_runs')[run_id]
    assert run['status'] == 'failed' and run['credit_refunded'] is True
    assert run['error'] == interview_coding_runs.ERROR_MESSAGE
    assert run['error_code'] == 'interview_coding_failed'
    assert 'Synthetic provider detail 12345' in caplog.text
    assert 'Synthetic provider detail' not in str(service._run_response(coding.runtime, 'pack-1', run_id))
    assert interview_coding_runs.fail_run(coding.runtime, run_id) is False
    assert coding.docs('users')['owner']['slides_credits'] == 10
    assert len(coding.docs('credit_refunds')) == 1


def test_restart_between_debit_and_dispatch_recovers_once(coding):
    run_id, created = interview_coding_runs.claim_run(coding.runtime, 'owner', 'pack-1', 1)
    assert created and not coding.queued
    coding.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=coding.runtime) == 1
    assert recovery.recover_stale_runtime_jobs(runtime=coding.runtime) == 0
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'failed'
    assert coding.docs('users')['owner']['slides_credits'] == 10
    assert len(coding.docs('credit_refunds')) == 1


def test_failed_refund_stays_recoverable_after_restart(coding, monkeypatch):
    run_id = start(coding)
    refund = interview_coding_runs.job_charges.refund_component
    monkeypatch.setattr(interview_coding_runs.job_charges, 'refund_component', lambda *_args, **_kwargs: False)
    assert interview_coding_runs.fail_run(coding.runtime, run_id) is False
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'refund_pending'
    assert coding.docs('runtime_jobs')[run_id]['status'] == 'processing'
    assert coding.docs('users')['owner']['slides_credits'] == 9
    coding.runtime.jobs.clear()
    coding.now += 181
    monkeypatch.setattr(interview_coding_runs.job_charges, 'refund_component', refund)
    assert recovery.recover_stale_runtime_jobs(runtime=coding.runtime) == 1
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'failed'
    assert coding.docs('users')['owner']['slides_credits'] == 10


def test_lost_completion_ack_never_refunds_a_successful_draft(coding):
    run_id = start(coding)
    def lose_ack(operations):
        if any(payload.get('status') == 'draft' for _ref, payload, _merge in operations):
            coding.after_commit = None
            raise RuntimeError('Synthetic lost draft acknowledgement')
    coding.after_commit = lose_ack
    coding.work()
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'draft'
    assert coding.docs('runtime_jobs')[run_id]['status'] == 'complete'
    assert coding.docs('users')['owner']['slides_credits'] == 9
    assert not coding.docs('credit_refunds')


def test_recovery_winner_discards_late_provider_completion(coding, monkeypatch):
    run_id = start(coding)
    entered, release = Event(), Event()
    original = service.ai_provider.generate_with_policy
    def held(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(service.ai_provider, 'generate_with_policy', held)
    with ThreadPoolExecutor(max_workers=1) as executor:
        worker = executor.submit(coding.work)
        try:
            assert entered.wait(5)
            coding.now += 181
            assert recovery.recover_stale_runtime_jobs(runtime=coding.runtime) == 1
        finally:
            release.set()
        worker.result(timeout=5)
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'failed'
    assert coding.docs('users')['owner']['slides_credits'] == 10
    assert not coding.docs('interview_ai_coding_runs')[run_id]['proposed_codes']


@pytest.mark.parametrize('status', ['draft', 'accepting', 'accepted', 'rejected'])
def test_completed_canonical_run_protects_against_old_runtime_snapshot(coding, status):
    run_id = start(coding)
    coding.work()
    coding.documents[('interview_ai_coding_runs', run_id)]['status'] = status
    coding.documents[('runtime_jobs', run_id)]['status'] = 'processing'
    coding.now += 181
    recovery.recover_stale_runtime_jobs(runtime=coding.runtime)
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == status
    assert coding.docs('runtime_jobs')[run_id]['status'] == 'complete'
    assert coding.docs('users')['owner']['slides_credits'] == 9
    assert not coding.docs('credit_refunds')


def test_execution_registry_protects_live_provider_work(coding, monkeypatch):
    run_id = start(coding)
    entered, release = Event(), Event()
    original = service.ai_provider.generate_with_policy
    def held(*args, **kwargs):
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(service.ai_provider, 'generate_with_policy', held)
    target, args, kwargs = coding.queued.pop()
    with ThreadPoolExecutor(max_workers=1) as dispatcher:
        future = execution.submit_job(dispatcher, target, *args, execution_runtime=coding.runtime, **kwargs)
        try:
            assert entered.wait(5)
            assert execution.is_job_active(run_id, runtime=coding.runtime)
            coding.now += 181
            assert recovery.recover_stale_runtime_jobs(runtime=coding.runtime) == 0
        finally:
            release.set()
        future.result(timeout=5)
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'draft'
    assert coding.docs('users')['owner']['slides_credits'] == 9


def test_runtime_mirror_counts_once_and_limit_precedes_charge(coding):
    start(coding)
    assert lifecycle.count_active_jobs_for_user('owner', runtime=coding.runtime) == 1
    coding.runtime.MAX_ACTIVE_JOBS_PER_USER = 1
    coding.documents[('study_packs', 'pack-2')] = {'uid': 'owner', 'mode': 'interview'}
    with pytest.raises(interview_coding_runs.RunError) as caught:
        interview_coding_runs.claim_run(coding.runtime, 'owner', 'pack-2', 1)
    assert caught.value.status == 429
    assert len(coding.docs('interview_ai_coding_runs')) == 1
    assert coding.docs('users')['owner']['slides_credits'] == 9


@pytest.mark.parametrize('status', ['queued', 'processing', 'refund_pending', 'draft', 'accepting'])
def test_reusable_runs_do_not_need_provider_availability_or_credits(coding, status):
    coding.documents[('interview_ai_coding_runs', 'legacy')] = {
        'uid': 'owner', 'pack_id': 'pack-1', 'status': status, 'created_at': 1, 'credit_cost': 1,
    }
    coding.runtime.client = None
    coding.documents[('users', 'owner')]['slides_credits'] = 0
    response, _status = coding.start()
    assert response['run']['run_id'] == 'legacy' and response['reused'] is True
    assert not coding.queued and coding.docs('users')['owner']['slides_credits'] == 0


def test_legacy_active_run_gets_recovery_record_without_second_charge(coding):
    coding.documents[('interview_ai_coding_runs', 'legacy')] = {
        'uid': 'owner', 'pack_id': 'pack-1', 'status': 'processing', 'created_at': 1, 'credit_cost': 1,
    }
    coding.documents[('users', 'owner')]['slides_credits'] = 9
    response, status = coding.start()
    assert status == 202 and response['run']['run_id'] == 'legacy'
    assert coding.docs('users')['owner']['slides_credits'] == 9
    assert recovery.recover_stale_runtime_jobs(runtime=coding.runtime) == 0
    coding.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=coding.runtime) == 1
    assert coding.docs('users')['owner']['slides_credits'] == 10


def test_coding_jobs_count_toward_admission_without_appearing_on_processing_page(coding):
    start(coding)
    coding.runtime.verify_firebase_token = lambda _request: {'uid': 'owner'}
    assert upload_runtime_service.get_active_runtime_jobs(coding.runtime, None) == {'jobs': []}
    coding.runtime.jobs.clear()
    assert upload_runtime_service.get_active_runtime_jobs(coding.runtime, None) == {'jobs': []}
    assert lifecycle.count_active_jobs_for_user('owner', runtime=coding.runtime) == 1


@pytest.mark.parametrize('change, status', [('foreign_pack', 403), ('missing_pack', 404), ('deleting', 409), ('deleted', 409), ('tombstone', 409)])
def test_atomic_claim_rechecks_owner_and_account(coding, change, status):
    if change == 'foreign_pack':
        coding.documents[('study_packs', 'pack-1')]['uid'] = 'other'
    elif change == 'missing_pack':
        del coding.documents[('study_packs', 'pack-1')]
    elif change == 'tombstone':
        coding.documents[('account_deletions', 'owner')] = {'status': 'requested'}
    else:
        coding.documents[('users', 'owner')]['account_status'] = change
    with pytest.raises(interview_coding_runs.RunError) as caught:
        interview_coding_runs.claim_run(coding.runtime, 'owner', 'pack-1', 1)
    assert caught.value.status == status
    assert coding.docs('users')['owner']['slides_credits'] == 10
    assert not coding.docs('interview_ai_coding_runs') and not coding.queued


def test_unlimited_run_records_no_debit_and_never_grants_refund(coding):
    coding.documents[('users', 'owner')]['unlimited_credits'] = {'slides': True}
    run_id = start(coding)
    assert coding.docs('interview_ai_coding_runs')[run_id]['credit_charged'] == 0
    coding.documents[('users', 'owner')]['unlimited_credits'] = {'slides': False}
    interview_coding_runs.fail_run(coding.runtime, run_id)
    assert coding.docs('users')['owner']['slides_credits'] == 10
    refunds = list(coding.docs('credit_refunds').values())
    assert len(refunds) == 1 and refunds[0]['amount'] == 0
    charges = list(coding.docs('credit_charges').values())
    assert len(charges) == 1
    assert charges[0]['charged_credits'] == charges[0]['refunded_credits'] == 0


def test_owned_status_checks_run_owner_before_recovery(coding, monkeypatch):
    run_id = start(coding)
    coding.uid = 'other'
    monkeypatch.setattr(service.study_api_support, 'get_owned_study_pack', lambda *_args: ({}, None, None))
    attempts = []
    monkeypatch.setattr(recovery, 'recover_runtime_job_if_stale', lambda *_args, **_kwargs: attempts.append(True))
    payload, status = service.get_ai_coding_run(coding.runtime, None, 'pack-1', run_id)
    assert status == 403 and payload['error'] == 'Forbidden' and not attempts


def test_owned_status_recovers_orphan_and_honors_disabled_recovery(coding, monkeypatch):
    run_id = start(coding)
    coding.now += 181
    monkeypatch.setattr(service.study_api_support, 'get_owned_study_pack', lambda *_args: ({}, None, None))
    coding.runtime.RUNTIME_JOB_RECOVERY_ENABLED = False
    assert service.get_ai_coding_run(coding.runtime, None, 'pack-1', run_id)['run']['status'] == 'queued'
    assert coding.docs('users')['owner']['slides_credits'] == 9
    coding.runtime.RUNTIME_JOB_RECOVERY_ENABLED = True
    result = service.get_ai_coding_run(coding.runtime, None, 'pack-1', run_id)
    assert result['run']['status'] == 'failed' and result['run']['credit_refunded'] is True
    assert coding.docs('users')['owner']['slides_credits'] == 10


def test_concurrent_refund_attempts_use_one_credit_ledger(coding, monkeypatch):
    run_id = start(coding)
    entered, release = Event(), Event()
    original = interview_coding_runs.job_charges.refund_component
    calls = []
    def held(*args, **kwargs):
        calls.append(args[3])
        if len(calls) == 1:
            entered.set()
            assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(interview_coding_runs.job_charges, 'refund_component', held)
    with ThreadPoolExecutor(max_workers=1) as executor:
        first = executor.submit(interview_coding_runs.fail_run, coding.runtime, run_id)
        try:
            assert entered.wait(5)
            assert interview_coding_runs.fail_run(coding.runtime, run_id) is True
        finally:
            release.set()
        first.result(timeout=5)
    assert calls == [f'interview-coding-run:{run_id}:credits'] * 2
    assert coding.docs('users')['owner']['slides_credits'] == 10
    assert len(coding.docs('credit_refunds')) == 1


def test_oversized_result_fails_without_publishing_draft_and_refunds(coding, monkeypatch):
    run_id = start(coding)
    monkeypatch.setattr(service.interview_coding, 'sanitize_ai_coding_payload', lambda *_args, **_kwargs: {
        'codes': [{'temp_id': 'large', 'name': 'Large', 'description': 'x' * 800_000}], 'quotations': [],
    })
    coding.work()
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'failed'
    assert coding.docs('users')['owner']['slides_credits'] == 10


def test_pack_deleted_during_provider_work_prevents_draft_write(coding, monkeypatch):
    run_id = start(coding)
    original = service.ai_provider.generate_with_policy
    def remove_pack(*args, **kwargs):
        del coding.documents[('study_packs', 'pack-1')]
        return original(*args, **kwargs)
    monkeypatch.setattr(service.ai_provider, 'generate_with_policy', remove_pack)
    coding.work()
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'failed'
    assert not coding.docs('study_packs')
    assert coding.docs('users')['owner']['slides_credits'] == 10


@pytest.mark.parametrize('quote_count, expected_status, remaining', [(10, 'draft', 9), (100, 'failed', 10)])
def test_generation_budgets_expanded_acceptance_plan_before_publishing(coding, monkeypatch, quote_count, expected_status, remaining):
    coding.transcript = 'Hello ' * quote_count
    proposals = {
        'codes': [{'temp_id': f'c{index}', 'name': f'Code {index}'} for index in range(200)],
        'quotations': [
            {'start_offset': index * 6, 'end_offset': index * 6 + 5, 'text': 'Hello',
             'code_refs': [f'c{code}' for code in range(200)]}
            for index in range(quote_count)
        ],
    }
    assert len(json.dumps(proposals).encode()) < interview_coding_runs.MAX_RUN_PAYLOAD_BYTES
    monkeypatch.setattr(service.interview_coding, 'sanitize_ai_coding_payload', lambda *_args, **_kwargs: proposals)
    run_id = start(coding)
    coding.work()
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == expected_status
    assert coding.docs('users')['owner']['slides_credits'] == remaining
    if expected_status == 'draft':
        from lecture_processor.domains.study import interview_coding_acceptance
        interview_coding_acceptance.accept_run(coding.runtime, interview_coding_runs.run_ref(coding.runtime, run_id),
                                               'owner', 'pack-1', coding.transcript, [])
        assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'accepted'
        assert len(coding.docs('interview_codes')) == 200
        assert len(coding.docs('interview_quotations')) == quote_count


def test_lost_refund_ack_retries_ledger_without_second_credit(coding):
    run_id = start(coding)
    def lose_ack(operations):
        if any(ref.path[0] == 'credit_refunds' for ref, _payload, _merge in operations):
            coding.after_commit = None
            raise RuntimeError('Synthetic lost refund acknowledgement')
    coding.after_commit = lose_ack
    assert interview_coding_runs.fail_run(coding.runtime, run_id) is False
    assert coding.docs('users')['owner']['slides_credits'] == 10
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'refund_pending'
    coding.now += 181
    assert recovery.recover_stale_runtime_jobs(runtime=coding.runtime) == 1
    assert coding.docs('users')['owner']['slides_credits'] == 10
    assert len(coding.docs('credit_refunds')) == 1


def test_concurrent_coding_claims_for_different_packs_share_account_limit(coding):
    coding.runtime.MAX_ACTIVE_JOBS_PER_USER = 1
    coding.documents[('study_packs', 'pack-2')] = {'uid': 'owner', 'mode': 'interview'}
    def claim(pack_id):
        try:
            interview_coding_runs.claim_run(coding.runtime, 'owner', pack_id, 1)
            return 202
        except interview_coding_runs.RunError as error:
            return error.status
    with ThreadPoolExecutor(max_workers=2) as executor:
        results = list(executor.map(claim, ['pack-1', 'pack-2']))
    assert sorted(results) == [202, 429]
    assert coding.docs('users')['owner']['slides_credits'] == 9
    assert len(coding.docs('interview_ai_coding_runs')) == 1


@pytest.mark.parametrize('created_at', [1, 1000])
def test_owned_get_adopts_legacy_pending_run_without_start_request(coding, monkeypatch, created_at):
    coding.documents[('interview_ai_coding_runs', 'legacy')] = {
        'uid': 'owner', 'pack_id': 'pack-1', 'status': 'processing',
        'created_at': created_at, 'credit_cost': 1,
    }
    coding.documents[('users', 'owner')]['slides_credits'] = 9
    coding.documents[('study_packs', 'pack-1')]['interview_coding_run_id'] = 'different-current-run'
    monkeypatch.setattr(service.study_api_support, 'get_owned_study_pack', lambda *_args: ({}, None, None))
    response = service.get_ai_coding_run(coding.runtime, None, 'pack-1', 'legacy')
    assert response['run']['status'] == 'processing'
    assert coding.docs('runtime_jobs')['legacy']['job_scope'] == 'interview-coding'
    assert coding.docs('runtime_jobs')['legacy']['last_heartbeat_at'] == 1000
    assert coding.docs('study_packs')['pack-1']['interview_coding_run_id'] == 'different-current-run'
    assert coding.docs('users')['owner']['slides_credits'] == 9
    assert not coding.queued and coding.provider_calls == 0
    coding.now += 181
    response = service.get_ai_coding_run(coding.runtime, None, 'pack-1', 'legacy')
    assert response['run']['status'] == 'failed'
    assert coding.docs('users')['owner']['slides_credits'] == 10


def test_legacy_state_finds_newest_run_beyond_previous_history_limit(coding):
    for index in range(25):
        coding.documents[('interview_ai_coding_runs', f'history-{index}')] = {
            'uid': 'owner', 'pack_id': 'pack-1', 'status': 'accepted', 'created_at': index,
        }
    coding.documents[('interview_ai_coding_runs', 'newest')] = {
        'uid': 'owner', 'pack_id': 'pack-1', 'status': 'processing', 'created_at': 100,
    }
    state = service._coding_state_payload(coding.runtime, 'pack-1', coding.docs('study_packs')['pack-1'], coding.transcript, 'owner')
    assert state['latest_run']['run_id'] == 'newest'


def test_legacy_worker_can_finish_during_adoption_grace_without_refund(coding, monkeypatch):
    coding.documents[('interview_ai_coding_runs', 'legacy')] = {
        'uid': 'owner', 'pack_id': 'pack-1', 'status': 'processing', 'created_at': 1, 'credit_cost': 1,
    }
    coding.documents[('users', 'owner')]['slides_credits'] = 9
    monkeypatch.setattr(service.study_api_support, 'get_owned_study_pack', lambda *_args: ({}, None, None))
    assert service.get_ai_coding_run(coding.runtime, None, 'pack-1', 'legacy')['run']['status'] == 'processing'
    coding.now += 20
    coding.documents[('interview_ai_coding_runs', 'legacy')].update({'status': 'draft', 'proposed_codes': [{'name': 'Legacy result'}]})
    coding.now += 161
    recovery.recover_stale_runtime_jobs(runtime=coding.runtime)
    assert coding.docs('interview_ai_coding_runs')['legacy']['status'] == 'draft'
    assert coding.docs('runtime_jobs')['legacy']['status'] == 'complete'
    assert coding.docs('users')['owner']['slides_credits'] == 9
    assert not coding.docs('credit_refunds')


def test_disabled_recovery_does_not_adopt_legacy_run_on_get(coding, monkeypatch):
    coding.documents[('interview_ai_coding_runs', 'legacy')] = {
        'uid': 'owner', 'pack_id': 'pack-1', 'status': 'processing', 'created_at': 1, 'credit_cost': 1,
    }
    coding.runtime.RUNTIME_JOB_RECOVERY_ENABLED = False
    monkeypatch.setattr(service.study_api_support, 'get_owned_study_pack', lambda *_args: ({}, None, None))
    assert service.get_ai_coding_run(coding.runtime, None, 'pack-1', 'legacy')['run']['status'] == 'processing'
    assert not coding.docs('runtime_jobs')


@pytest.mark.parametrize('interruption', ['deleted_pack', 'recovered_run'])
def test_interruption_during_first_chunk_prevents_second_provider_call(coding, monkeypatch, interruption):
    run_id = start(coding)
    monkeypatch.setattr(service.interview_coding, 'split_segments_for_ai', lambda segments: [segments, segments])
    entered, release = Event(), Event()
    original = service.ai_provider.generate_with_policy
    calls = []
    def held(*args, **kwargs):
        calls.append(kwargs['operation_name'])
        entered.set()
        assert release.wait(5)
        return original(*args, **kwargs)
    monkeypatch.setattr(service.ai_provider, 'generate_with_policy', held)
    with ThreadPoolExecutor(max_workers=1) as executor:
        future = executor.submit(coding.work)
        try:
            assert entered.wait(5)
            if interruption == 'deleted_pack':
                del coding.documents[('study_packs', 'pack-1')]
            else:
                coding.now += 181
                assert recovery.recover_stale_runtime_jobs(runtime=coding.runtime) == 1
        finally:
            release.set()
        future.result(timeout=5)
    assert calls == ['interview_ai_coding_1']
    assert coding.docs('interview_ai_coding_runs')[run_id]['status'] == 'failed'
    assert coding.docs('users')['owner']['slides_credits'] == 10
