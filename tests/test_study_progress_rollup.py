"""Progress rollups stay complete and transactional across edits and deletion."""
from copy import deepcopy
from functools import wraps
import logging
from types import SimpleNamespace

import pytest
from flask import Flask, jsonify

from lecture_processor.repositories import study_repo
from lecture_processor.services import study_api_support, study_library_service
from lecture_processor.services import study_progress_service as service


class Snapshot:
    def __init__(self, ref, data):
        self.reference = ref
        self.id = ref.path.rsplit('/', 1)[-1]
        self.exists = data is not None
        self.data = deepcopy(data)

    def to_dict(self):
        return deepcopy(self.data)


def merge_fields(previous, update):
    result = deepcopy(previous)
    for key, value in update.items():
        result[key] = merge_fields(result.get(key, {}), value) if isinstance(value, dict) and value else deepcopy(value)
    return result


class Ref:
    def __init__(self, db, path):
        self.db, self.path = db, path
        self._document_path = path

    def get(self, transaction=None, field_paths=None):
        if transaction is not None:
            assert not transaction.operations, 'Firestore reads must precede writes'
        data = self.db.data.get(self.path)
        if data is not None and field_paths:
            data = {key: data[key] for key in field_paths if key in data}
        return Snapshot(self, data)

    def set(self, data, merge=False):
        previous = self.db.data.get(self.path, {})
        if merge is True:
            data = merge_fields(previous, data)
        elif merge:
            data = {**deepcopy(previous), **{key: deepcopy(data[key]) for key in merge}}
        self.db.data[self.path] = deepcopy(data)
        self.db.revision += 1

    def delete(self):
        self.db.data.pop(self.path, None)
        self.db.revision += 1


class Query:
    def __init__(self, db, root):
        self.db, self.root, self.filters, self.cap = db, root, [], None

    def document(self, doc_id):
        return Ref(self.db, self.root + '/' + doc_id)

    def where(self, *, filter):
        self.filters.append((filter.field_path, filter.value))
        return self

    def limit(self, limit):
        self.cap = limit
        return self

    def stream(self, transaction=None):
        if transaction is not None:
            assert not transaction.operations
        self.db.scans += 1
        refs = [Ref(self.db, key) for key, value in self.db.data.items()
                if key.startswith(self.root + '/') and all(value.get(field) == expected for field, expected in self.filters)]
        return [ref.get(transaction=transaction) for ref in refs[:self.cap]]


class Transaction:
    def __init__(self, db):
        self.db, self.operations = db, []

    def set(self, ref, payload, merge=False):
        self.operations.append(('set', ref, deepcopy(payload), merge))

    def delete(self, ref):
        self.operations.append(('delete', ref))


class Database:
    def __init__(self):
        self.data = {}
        self.revision = 0
        self.scans = 0
        self.before_commit = None
        self.fail_commit = False
        self.retries = 0
        self.get_all_calls = []

    def collection(self, name):
        return Query(self, name)

    def get_all(self, refs, **kwargs):
        self.get_all_calls.append(len(refs))
        return [ref.get(**kwargs) for ref in reversed(refs)]

    def transaction(self):
        return Transaction(self)

    def transactional(self, function):
        @wraps(function)
        def execute(transaction):
            for _attempt in range(3):
                revision = self.revision
                transaction.operations = []
                result = function(transaction)
                hook, self.before_commit = self.before_commit, None
                if hook:
                    hook()
                if self.revision != revision:
                    self.retries += 1
                    continue
                if self.fail_commit:
                    raise RuntimeError('simulated commit failure')
                for operation in transaction.operations:
                    if operation[0] == 'set':
                        operation[1].set(operation[2], merge=operation[3])
                    else:
                        operation[1].delete()
                return result
            raise RuntimeError('too many transaction conflicts')
        return execute


@pytest.fixture
def setup(monkeypatch):
    db = Database()
    runtime = SimpleNamespace(
        db=db, repositories=SimpleNamespace(study=study_repo),
        firestore=SimpleNamespace(transactional=db.transactional),
        time=SimpleNamespace(time=lambda: 12345), logger=logging.getLogger(__name__),
        jsonify=jsonify, MAX_PROGRESS_PACKS_PER_SYNC=1,
        get_study_progress_doc=lambda uid: study_repo.study_progress_doc_ref(db, uid),
        get_study_card_state_doc=lambda uid, pack_id: study_repo.study_card_state_doc_ref(db, uid, pack_id),
    )
    monkeypatch.setattr(study_api_support, 'require_user', lambda *_: ({'uid': 'owner'}, None, None))
    monkeypatch.setattr(study_api_support, 'account_write_guard', lambda *_: None)
    removed_audio = []
    monkeypatch.setattr(study_library_service.study_audio, 'remove_pack_audio_file', lambda pack, runtime=None: removed_audio.append(pack))
    with Flask(__name__).app_context():
        yield runtime, db, removed_audio


def seed_pack(db, pack_id, due_dates, owner='owner'):
    db.data['study_packs/' + pack_id] = {'uid': owner, 'title': pack_id}
    db.data[f'study_card_states/{owner}__{pack_id}'] = {
        'uid': owner, 'pack_id': pack_id,
        'state': {f'fc_{index}': {'seen': 1, 'next_review_date': due, 'last_review_date': '2000-01-01'} for index, due in enumerate(due_dates)},
    }


def update(runtime, body):
    return service.update_study_progress(runtime, SimpleNamespace(get_json=lambda **_: body))


def summary(runtime):
    return service.get_study_progress_summary(runtime, None)


def assert_ok(response):
    assert not isinstance(response, tuple), response[0].get_json() if isinstance(response, tuple) else ''
    assert response.status_code == 200
    return response.get_json()


def test_first_partial_sync_rebuilds_all_owned_packs_without_the_sync_limit(setup):
    runtime, db, _ = setup
    seed_pack(db, 'a', ['2000-01-01'])
    seed_pack(db, 'b', ['2000-01-01', '2000-01-01'])
    seed_pack(db, 'c', [''])
    seed_pack(db, 'foreign', ['2000-01-01'], owner='someone-else')
    seed_pack(db, 'deleted', ['2000-01-01'])
    del db.data['study_packs/deleted']

    assert_ok(update(runtime, {'card_states': {'a': {'fc_0': {'seen': 2, 'next_review_date': '2099-01-01', 'last_review_date': '2026-01-01'}}}}))

    assert assert_ok(summary(runtime))['due_today'] == 3
    progress = db.data['study_progress/owner']
    assert progress[service.CARD_STATE_DUE_ROLLUP_VERSION_KEY] == service.CARD_STATE_DUE_ROLLUP_VERSION
    assert progress[service.CARD_STATE_DUE_ROLLUP_KEY] == {'2000-01-01': 2, '0001-01-01': 1, '2099-01-01': 1}


@pytest.mark.parametrize('old_total', [0, 1, 99])
def test_old_inaccurate_totals_and_stale_compact_summaries_are_repaired_once(setup, old_total):
    runtime, db, _ = setup
    seed_pack(db, 'a', ['2000-01-01', '2099-01-01'])
    db.data['study_card_states/owner__a']['summary'] = {'due_by_date': {'2000-01-01': 99}}
    db.data['study_progress/owner'] = {service.CARD_STATE_DUE_ROLLUP_KEY: {'2000-01-01': old_total}, 'daily_goal': 34}

    assert assert_ok(summary(runtime)) == {'daily_goal': 34, 'current_streak': 0, 'today_progress': 0, 'due_today': 1}
    scans = db.scans
    assert assert_ok(summary(runtime))['due_today'] == 1
    assert db.scans == scans, 'A repaired summary must keep the one-document fast path'


def test_due_dates_are_replaced_instead_of_preserving_old_nested_keys(setup):
    runtime, db, _ = setup
    seed_pack(db, 'a', ['2000-01-01'])
    assert_ok(summary(runtime))
    assert_ok(update(runtime, {'card_states': {'a': {'fc_0': {'seen': 2, 'next_review_date': '2099-01-01', 'last_review_date': '2026-01-01'}}}}))
    assert db.data['study_progress/owner'][service.CARD_STATE_DUE_ROLLUP_KEY] == {'2099-01-01': 1}
    assert db.data['study_card_states/owner__a']['summary'] == {'due_by_date': {'2099-01-01': 1}}
    assert assert_ok(summary(runtime))['due_today'] == 0


def test_pack_delete_subtracts_due_cards_without_a_second_client_request(setup):
    runtime, db, audio = setup
    seed_pack(db, 'a', ['2000-01-01', '2099-01-01'])
    seed_pack(db, 'b', ['2000-01-01'])
    db.data['study_pack_sources/a'] = {'slides': 'private source'}
    db.data['study_shares/shared-a'] = {'owner_uid': 'owner', 'entity_type': 'pack', 'entity_id': 'a'}
    assert_ok(summary(runtime))

    assert_ok(study_library_service.delete_study_pack(runtime, None, 'a'))

    assert assert_ok(summary(runtime))['due_today'] == 1
    assert all(key not in db.data for key in ('study_packs/a', 'study_card_states/owner__a', 'study_pack_sources/a', 'study_shares/shared-a'))
    assert len(audio) == 1


def test_failed_delete_commit_preserves_pack_progress_and_audio(setup):
    runtime, db, audio = setup
    seed_pack(db, 'a', ['2000-01-01'])
    assert_ok(summary(runtime))
    before = deepcopy(db.data)
    db.fail_commit = True

    response, status = study_library_service.delete_study_pack(runtime, None, 'a')

    assert status == 500
    assert response.get_json()['error'] == 'Could not delete study pack'
    assert db.data == before
    assert audio == []


def test_progress_update_cannot_resurrect_a_pack_deleted_during_its_transaction(setup):
    runtime, db, _ = setup
    seed_pack(db, 'a', ['2000-01-01'])
    assert_ok(summary(runtime))
    db.before_commit = lambda: assert_ok(study_library_service.delete_study_pack(runtime, None, 'a'))

    response, status = update(runtime, {'card_states': {'a': {'fc_0': {'seen': 2, 'next_review_date': '2099-01-01'}}}})

    assert status == 404
    assert response.get_json()['error'] == 'Study pack not found'
    assert db.retries == 1
    assert 'study_card_states/owner__a' not in db.data
    assert assert_ok(summary(runtime))['due_today'] == 0


def test_repair_retries_if_a_card_review_commits_while_it_is_rebuilding(setup):
    runtime, db, _ = setup
    seed_pack(db, 'a', ['2000-01-01'])
    db.before_commit = lambda: assert_ok(update(runtime, {'card_states': {'a': {'fc_0': {'seen': 2, 'next_review_date': '2099-01-01', 'last_review_date': '2026-01-01'}}}}))

    assert assert_ok(summary(runtime))['due_today'] == 0
    assert db.retries == 1
    assert db.data['study_progress/owner'][service.CARD_STATE_DUE_ROLLUP_KEY] == {'2099-01-01': 1}


@pytest.mark.parametrize('operation', ['repair', 'metadata', 'review', 'delete'])
@pytest.mark.parametrize('deletion_status', ['purging', 'deleted'])
def test_progress_transactions_cannot_write_after_account_deletion(setup, operation, deletion_status):
    runtime, db, audio = setup
    seed_pack(db, 'a', ['2000-01-01'])
    if operation != 'repair':
        assert_ok(summary(runtime))
    after_deletion = {}

    def delete_account():
        if deletion_status == 'deleted':
            db.data.clear()
        db.collection('account_deletions').document('owner').set({'status': deletion_status})
        after_deletion.update(deepcopy(db.data))

    db.before_commit = delete_account
    if operation == 'repair':
        response, status = summary(runtime)
    elif operation == 'metadata':
        response, status = update(runtime, {'daily_goal': 42})
    elif operation == 'review':
        response, status = update(runtime, {'card_states': {'a': {'fc_0': {'seen': 2}}}})
    else:
        response, status = study_library_service.delete_study_pack(runtime, None, 'a')

    assert status == 409
    assert response.get_json()['status'] == 'account_deletion_in_progress'
    assert db.retries == 1
    assert db.data == after_deletion
    assert audio == []


def test_nontransactional_repair_also_checks_account_deletion(setup):
    runtime, db, _ = setup
    runtime.firestore = None
    seed_pack(db, 'a', ['2000-01-01'])
    db.data['account_deletions/owner'] = {'status': 'deleted'}
    before = deepcopy(db.data)

    response, status = summary(runtime)

    assert status == 409
    assert response.get_json()['status'] == 'account_deletion_in_progress'
    assert db.data == before


def test_repair_fails_closed_when_account_state_cannot_be_read(setup, monkeypatch):
    runtime, db, _ = setup
    seed_pack(db, 'a', ['2000-01-01'])
    original_get = Ref.get

    def unavailable_get(ref, **kwargs):
        if ref.path == 'account_deletions/owner':
            raise RuntimeError('Account state temporarily unavailable')
        return original_get(ref, **kwargs)

    monkeypatch.setattr(Ref, 'get', unavailable_get)
    before = deepcopy(db.data)
    response, status = summary(runtime)
    assert status == 409
    assert response.get_json()['status'] == 'account_deletion_in_progress'
    assert db.data == before


def test_due_cards_are_complete_owned_actionable_and_exclude_new_future_or_removed_cards(setup):
    runtime, db, _ = setup
    for pack_id in ('a', 'b', 'archived', 'foreign', 'deleted'):
        seed_pack(db, pack_id, ['2000-01-01', '2999-01-01', ''])
        db.data['study_packs/' + pack_id]['flashcards'] = [{'front': 'Due card'}, {'front': 'Future card'}, {'front': 'Unscheduled reviewed card'}, {'front': 'New card'}]
    db.data['study_packs/foreign']['uid'] = 'someone-else'
    db.data['study_packs/archived']['archived'] = True
    del db.data['study_packs/deleted']
    db.data['study_card_states/owner__a']['state']['fc_99'] = {'seen': 1, 'next_review_date': '2000-01-01'}
    db.data['study_card_states/owner__a']['state']['q_0'] = {'seen': 1, 'next_review_date': '2000-01-01'}
    result = assert_ok(service.get_due_study_cards(runtime, None))
    assert result['due_count'] == 4
    assert {pack['study_pack_id'] for pack in result['packs']} == {'a', 'b'}
    assert all({card['id'] for card in pack['cards']} == {'fc_0', 'fc_2'} for pack in result['packs'])
    assert all(card['front'] != 'Future card' for pack in result['packs'] for card in pack['cards'])


def test_active_plan_due_scope_filters_recommendations_without_mutating_global_history(setup):
    runtime, db, _ = setup
    from lecture_processor.repositories import planner_repo
    runtime.repositories.planner = planner_repo
    for pack_id in ['active', 'outside', 'archived', 'foreign']:
        seed_pack(db, pack_id, ['2000-01-01'], owner='other' if pack_id == 'foreign' else 'owner')
        db.data['study_packs/' + pack_id]['flashcards'] = [{'front': pack_id, 'back': 'answer'}]
    db.data['study_goals/one'] = {'uid': 'owner', 'status': 'active', 'pack_ids': ['active', 'foreign']}
    db.data['study_goals/two'] = {'uid': 'owner', 'status': 'archived', 'pack_ids': ['archived']}
    db.data['study_goals/foreign'] = {'uid': 'other', 'status': 'active', 'pack_ids': ['outside']}
    original = deepcopy(db.data)
    scoped = service.load_due_study_cards(runtime, 'owner', active_plan=True)
    assert scoped['due_count'] == 1
    assert [item['study_pack_id'] for item in scoped['packs']] == ['active']
    assert service.load_due_study_cards(runtime, 'owner')['due_count'] == 3
    assert db.data == original
    scoped_summary = assert_ok(service.get_study_progress_summary(runtime, SimpleNamespace(args={'scope': 'active_plan'})))
    assert scoped_summary['due_today'] == scoped['due_count']
    assert db.data == original
    db.data['study_goals/one']['status'] = 'archived'
    reads_before = list(db.get_all_calls)
    assert service.load_due_study_cards(runtime, 'owner', active_plan=True)['due_count'] == 0
    assert db.get_all_calls == reads_before
    assert service.load_due_study_cards(runtime, 'owner')['due_count'] == 3
