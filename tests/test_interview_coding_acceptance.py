from copy import deepcopy
from concurrent.futures import ThreadPoolExecutor
from functools import wraps
from threading import Barrier, RLock
from types import SimpleNamespace

import pytest

from lecture_processor.services import interview_coding_service as service


@pytest.mark.parametrize('cursor', [-1, 999999, True, '0', None])
def test_invalid_acceptance_cursor_fails_without_writes(coding, cursor):
    coding.fail_accept = True
    coding.accept()
    run = coding.run_ref.get().to_dict()
    run['acceptance_plan']['next_write'] = cursor
    coding.run_ref.set(run)
    before = deepcopy(coding.documents)
    attempts = 0
    def bounded_writes(_operations):
        nonlocal attempts
        attempts += 1
        if attempts > 4:
            raise RuntimeError('Acceptance cursor did not make progress')
    coding.before_commit = bounded_writes
    response, status = coding.accept()
    assert status == 409 and response['error']
    assert coding.documents == before


def test_reserved_provider_ids_do_not_become_firestore_field_names(coding):
    coding.run_ref.update({
        'proposed_codes': [{'temp_id': '__parent__', 'name': 'Parent'}, {'temp_id': '__child__', 'name': 'Child', 'parent_temp_id': '__parent__'}],
        'proposed_quotations': [{'start_offset': 0, 'end_offset': 5, 'text': 'Hello', 'code_refs': ['__child__']}],
    })
    def validate_fields(operations):
        def check(value):
            if isinstance(value, dict):
                for key, item in value.items():
                    if key.startswith('__') and key.endswith('__'):
                        raise RuntimeError('Reserved Firestore field name')
                    check(item)
            elif isinstance(value, list):
                for item in value:
                    check(item)
        for _ref, payload, _merge in operations:
            check(payload)
    coding.before_commit = validate_fields
    assert coding.accept() == {'ok': True, 'state': {'ready': True}}
    codes = coding.docs('interview_codes')
    parent = next(key for key, code in codes.items() if code['name'] == 'Parent')
    child = next(key for key, code in codes.items() if code['name'] == 'Child')
    assert codes[child]['parent_code_id'] == parent
    assert next(iter(coding.docs('interview_quotations').values()))['code_ids'] == [child]


def test_oversized_acceptance_plan_does_not_change_draft(coding):
    coding.run_ref.update({'proposed_codes': [{'temp_id': 'c1', 'name': 'Guidance', 'description': 'x' * 800_000}]})
    before = deepcopy(coding.documents)
    response, status = coding.accept()
    assert status == 409 and response['error']
    assert coding.documents == before


def test_existing_version_one_acceptance_plan_can_resume(coding):
    coding.fail_accept = True
    coding.accept()
    run = coding.run_ref.get().to_dict()
    plan = run['acceptance_plan']
    run['acceptance_plan'] = {**plan, 'version': 1, 'code_id_by_ref': {'c1': next(iter(plan['code_id_by_ref'].values()))}}
    coding.run_ref.set(run)
    assert coding.accept() == {'ok': True, 'state': {'ready': True}}
    assert len(coding.docs('interview_codes')) == 1
    assert len(coding.docs('interview_quotations')) == 1


class Snapshot:
    def __init__(self, reference):
        self.reference = reference
        self.id = reference.id
        self.payload = deepcopy(reference.state.documents.get(reference.path))
        self.exists = self.payload is not None

    def to_dict(self):
        return deepcopy(self.payload)


class Reference:
    def __init__(self, state, collection, document_id):
        self.state, self.collection, self.id = state, collection, document_id
        self.path = (collection, document_id)

    def get(self, transaction=None):
        if transaction is not None:
            assert not transaction.operations, 'Transaction reads must precede writes'
        return Snapshot(self)

    def set(self, payload, merge=False):
        Batch(self.state).set(self, payload, merge=merge).commit()

    def update(self, payload):
        self.set(payload, merge=True)

    def delete(self):
        self.state.documents.pop(self.path, None)


class Batch:
    def __init__(self, state):
        self.state, self.operations = state, []

    def set(self, reference, payload, merge=False):
        self.operations.append((reference, deepcopy(payload), merge))
        return self

    def update(self, reference, payload):
        return self.set(reference, payload, merge=True)

    def commit(self):
        if self.state.fail_accept and any(payload.get('status') == 'accepted' for _, payload, _ in self.operations):
            self.state.fail_accept = False
            raise RuntimeError('Synthetic acceptance commit failure')
        if self.state.before_commit:
            self.state.before_commit(self.operations)
        assert len(self.operations) <= 500
        self.state.batch_sizes.append(len(self.operations))
        for ref, payload, merge in self.operations:
            if not merge:
                self.state.documents[ref.path] = {}
            self.state.documents.setdefault(ref.path, {}).update(deepcopy(payload))
        if self.state.after_commit:
            self.state.after_commit(self.operations)


@pytest.fixture
def coding(monkeypatch):
    state = SimpleNamespace(documents={}, now=1000.0, fail_accept=False, before_commit=None, after_commit=None, batch_sizes=[], serial=0, uid='owner', transcript='Hello world')
    lock = RLock()

    def reference(collection, document_id=None):
        if document_id is None:
            state.serial += 1
            document_id = f'random-{state.serial}'
        return Reference(state, collection, document_id)

    def list_docs(collection, uid):
        return [reference(collection, key).get() for kind, key in state.documents
                if kind == collection and state.documents[(kind, key)].get('uid') == uid]

    def transactional(callback):
        @wraps(callback)
        def run(transaction):
            with lock:
                result = callback(transaction)
                transaction.commit()
                return result
        return run

    study = SimpleNamespace(
        create_interview_code_doc_ref=lambda _db: reference('interview_codes'),
        interview_code_doc_ref=lambda _db, key: reference('interview_codes', key),
        list_interview_codes_by_uid=lambda _db, uid: list_docs('interview_codes', uid),
        create_interview_quotation_doc_ref=lambda _db: reference('interview_quotations'),
        interview_quotation_doc_ref=lambda _db, key: reference('interview_quotations', key),
        get_interview_ai_coding_run_doc=lambda _db, key: reference('interview_ai_coding_runs', key).get(),
    )
    state.runtime = SimpleNamespace(
        db=SimpleNamespace(transaction=lambda: Batch(state), batch=lambda: Batch(state),
                           collection=lambda collection: SimpleNamespace(document=lambda key=None: reference(collection, key))),
        firestore=SimpleNamespace(transactional=transactional), repositories=SimpleNamespace(study=study),
        time=SimpleNamespace(time=lambda: state.now), jsonify=lambda payload: payload,
        logger=SimpleNamespace(exception=lambda *_args, **_kwargs: None),
    )
    state.run_ref = reference('interview_ai_coding_runs', 'run-1')
    state.documents[('users', 'owner')] = {'uid': 'owner', 'account_status': 'active'}
    state.documents[('study_packs', 'pack-1')] = {'uid': 'owner', 'mode': 'interview'}
    state.run_ref.set({
        'uid': 'owner', 'pack_id': 'pack-1', 'status': 'draft',
        'proposed_codes': [{'temp_id': 'c1', 'name': 'Guidance', 'color': 'teal'}],
        'proposed_quotations': [{'start_offset': 0, 'end_offset': 5, 'text': 'Hello', 'code_refs': ['c1']}],
    })
    monkeypatch.setattr(service.study_api_support, 'require_user', lambda *_args: ({'uid': state.uid}, None, None))
    monkeypatch.setattr(service.study_api_support, 'account_write_guard', lambda *_args: None)
    monkeypatch.setattr(service, '_require_interview_pack', lambda *_args: ({'uid': 'owner'}, state.transcript, None, None))
    monkeypatch.setattr(service, '_coding_state_payload', lambda *_args: {'ready': True})
    state.accept = lambda: service.accept_ai_coding_run(state.runtime, None, 'pack-1', 'run-1')
    state.reject = lambda: service.reject_ai_coding_run(state.runtime, None, 'pack-1', 'run-1')
    state.docs = lambda collection: {key: value for (kind, key), value in state.documents.items() if kind == collection}
    return state


def test_retry_after_failed_accept_does_not_duplicate_quotations(coding):
    coding.fail_accept = True
    try:
        coding.accept()
    except RuntimeError:
        pass
    result = coding.accept()
    assert result == {'ok': True, 'state': {'ready': True}}
    assert len(coding.docs('interview_quotations')) == 1
    assert len(coding.docs('interview_codes')) == 1
    assert coding.run_ref.get().to_dict()['accepted_quotation_count'] == 1
    assert coding.run_ref.get().to_dict()['accepted_code_count'] == 1


def test_accepted_replay_does_not_recreate_deleted_accepted_data(coding):
    coding.accept()
    for key in list(coding.documents):
        if key[0] in {'interview_codes', 'interview_quotations'}:
            del coding.documents[key]
    assert coding.accept() == {'ok': True, 'state': {'ready': True}}
    assert coding.docs('interview_codes') == {}
    assert coding.docs('interview_quotations') == {}


def test_reject_cannot_change_an_accepting_run(coding):
    coding.run_ref.update({'status': 'accepting'})
    response, status = coding.reject()
    assert status == 409
    assert response['error']
    assert coding.run_ref.get().to_dict()['status'] == 'accepting'


def test_run_owner_is_checked_before_acceptance(coding):
    coding.uid = 'someone-else'
    before = deepcopy(coding.documents)
    _response, status = coding.accept()
    assert status == 403
    assert coding.documents == before


def test_large_acceptance_resumes_after_partial_commit_with_frozen_mapping(coding):
    coding.transcript = 'Hello ' * 620
    coding.run_ref.update({'proposed_quotations': [
        {'start_offset': index * 6, 'end_offset': index * 6 + 5, 'text': 'Hello', 'code_refs': ['c1']}
        for index in range(620)
    ]})
    coding.fail_accept = True
    result = coding.accept()
    assert result[1] == 503
    assert 0 < len(coding.docs('interview_quotations')) < 620
    code_id = next(iter(coding.docs('interview_codes')))
    coding.documents[('interview_codes', code_id)]['name'] = 'Edited while accepting'
    saved_quote = next(iter(coding.docs('interview_quotations')))
    del coding.documents[('interview_quotations', saved_quote)]
    coding.transcript = 'Changed after the plan was saved'

    assert coding.accept() == {'ok': True, 'state': {'ready': True}}
    run = coding.run_ref.get().to_dict()
    assert run['status'] == 'accepted'
    assert run['accepted_code_count'] == 1
    assert run['accepted_quotation_count'] == 620
    assert len(coding.docs('interview_quotations')) == 619
    assert saved_quote not in coding.docs('interview_quotations')
    assert coding.docs('interview_codes')[code_id]['name'] == 'Edited while accepting'
    assert all(quote['code_ids'] == [code_id] and quote['text'] == 'Hello'
               for quote in coding.docs('interview_quotations').values())
    assert max(coding.batch_sizes) <= 401


def synchronize_route_reads(monkeypatch):
    barrier = Barrier(2)
    original = service._owned_run_doc

    def read(*args):
        result = original(*args)
        barrier.wait(timeout=5)
        return result

    monkeypatch.setattr(service, '_owned_run_doc', read)


def test_concurrent_acceptance_creates_one_copy_of_each_document(coding, monkeypatch):
    synchronize_route_reads(monkeypatch)
    with ThreadPoolExecutor(max_workers=2) as executor:
        first = executor.submit(coding.accept)
        second = executor.submit(coding.accept)
        assert first.result(timeout=5) == {'ok': True, 'state': {'ready': True}}
        assert second.result(timeout=5) == {'ok': True, 'state': {'ready': True}}
    assert len(coding.docs('interview_codes')) == 1
    assert len(coding.docs('interview_quotations')) == 1


def test_acceptance_reuses_existing_codes_and_keeps_parent_relationships(coding):
    coding.documents[('interview_codes', 'existing')] = {'uid': 'owner', 'name': 'Existing code', 'color': 'teal'}
    coding.run_ref.update({'proposed_codes': [
        {'temp_id': 'c1', 'name': 'Child', 'parent_temp_id': 'parent'},
        {'temp_id': 'parent', 'name': 'Existing code'},
    ]})
    coding.accept()
    new_code = next(code for key, code in coding.docs('interview_codes').items() if key != 'existing')
    assert new_code['parent_code_id'] == 'existing'
    assert coding.run_ref.get().to_dict()['accepted_code_count'] == 1


def test_reject_and_accept_claim_cannot_both_win(coding):
    assert coding.reject()['ok'] is True
    _response, status = coding.accept()
    assert status == 400
    assert coding.docs('interview_codes') == {}
    assert coding.docs('interview_quotations') == {}


def test_concurrent_accept_and_reject_have_one_winner(coding, monkeypatch):
    synchronize_route_reads(monkeypatch)
    with ThreadPoolExecutor(max_workers=2) as executor:
        accept = executor.submit(coding.accept)
        reject = executor.submit(coding.reject)
        results = [accept.result(timeout=5), reject.result(timeout=5)]
    statuses = sorted(result[1] if isinstance(result, tuple) else 200 for result in results)
    assert statuses in ([200, 400], [200, 409])
    status = coding.run_ref.get().to_dict()['status']
    assert status in {'accepted', 'rejected'}
    assert len(coding.docs('interview_quotations')) == (1 if status == 'accepted' else 0)


@pytest.mark.parametrize('change, expected_status', [
    ('missing_pack', 404), ('foreign_pack', 403), ('missing_user', 409), ('deleting_user', 409), ('tombstone', 409),
])
def test_acceptance_claim_rechecks_pack_and_account_inside_transaction(coding, change, expected_status):
    if change == 'missing_pack':
        del coding.documents[('study_packs', 'pack-1')]
    elif change == 'foreign_pack':
        coding.documents[('study_packs', 'pack-1')]['uid'] = 'another-owner'
    elif change == 'missing_user':
        del coding.documents[('users', 'owner')]
    elif change == 'deleting_user':
        coding.documents[('users', 'owner')]['account_status'] = 'deleting'
    else:
        coding.documents[('account_deletions', 'owner')] = {'status': 'requested'}
    _response, status = coding.accept()
    assert status == expected_status
    assert coding.run_ref.get().to_dict()['status'] == 'draft'
    assert coding.docs('interview_codes') == {}
    assert coding.docs('interview_quotations') == {}


@pytest.mark.parametrize('change, expected_status', [('missing_pack', 404), ('deleting_user', 409), ('tombstone', 409)])
def test_partial_acceptance_stops_new_writes_after_deletion_starts(coding, change, expected_status):
    coding.transcript = 'Hello ' * 620
    coding.run_ref.update({'proposed_quotations': [
        {'start_offset': index * 6, 'end_offset': index * 6 + 5, 'text': 'Hello', 'code_refs': ['c1']}
        for index in range(620)
    ]})
    coding.fail_accept = True
    assert coding.accept()[1] == 503
    before = deepcopy(coding.docs('interview_quotations'))
    if change == 'missing_pack':
        del coding.documents[('study_packs', 'pack-1')]
    elif change == 'deleting_user':
        coding.documents[('users', 'owner')]['account_status'] = 'deleting'
    else:
        coding.documents[('account_deletions', 'owner')] = {'status': 'requested'}
    _response, status = coding.accept()
    assert status == expected_status
    assert coding.docs('interview_quotations') == before
    assert coding.run_ref.get().to_dict()['status'] == 'accepting'


def test_deletion_between_chunks_stops_the_running_request(coding):
    coding.transcript = 'Hello ' * 620
    coding.run_ref.update({'proposed_quotations': [
        {'start_offset': index * 6, 'end_offset': index * 6 + 5, 'text': 'Hello', 'code_refs': ['c1']}
        for index in range(620)
    ]})

    def start_deletion(operations):
        if any(ref.collection == 'interview_quotations' for ref, _, _ in operations):
            coding.documents[('account_deletions', 'owner')] = {'status': 'requested'}

    coding.after_commit = start_deletion
    _response, status = coding.accept()
    assert status == 409
    assert 0 < len(coding.docs('interview_quotations')) < 620
    assert coding.run_ref.get().to_dict()['status'] == 'accepting'
