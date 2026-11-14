"""Goal edits retain revision protection through the final database write."""

from copy import deepcopy
from types import SimpleNamespace

from flask import Flask, jsonify
from google.cloud import firestore
import pytest

from lecture_processor.domains.planner import study_plan
from lecture_processor.repositories import planner_repo
from lecture_processor.services import study_plan_service as service


@pytest.fixture
def goal_runtime(monkeypatch):
    planner_repo.clear_memory_state()
    goal, error = study_plan.sanitize_goal(
        {'title': 'Original goal', 'exam_date': '2030-11-20', 'pack_ids': ['pack']},
        goal_id='goal', now_ts=1000,
    )
    assert not error
    goal.update(uid='owner', revision=1)
    planner_repo.set_study_goal(None, 'owner', 'goal', goal, merge=False)
    runtime = SimpleNamespace(
        db=None, jsonify=jsonify, time=SimpleNamespace(time=lambda: 1001),
        repositories=SimpleNamespace(planner=planner_repo),
    )
    monkeypatch.setattr(service, '_require_user', lambda *_: ({'uid': 'owner'}, None, 0))
    monkeypatch.setattr(service, '_write_guard', lambda *_: None)
    monkeypatch.setattr(service, '_owned_pack_ids', lambda _runtime, _uid, ids: set(ids))
    with Flask(__name__).app_context():
        yield runtime
    planner_repo.clear_memory_state()


def update_goal(runtime, body):
    request = SimpleNamespace(get_json=lambda **_: deepcopy(body))
    result = service.update_goal(runtime, request, 'goal')
    response, status = result if isinstance(result, tuple) else (result, result.status_code)
    return status, response.get_json()


def stored_goal():
    return planner_repo.get_study_goal(None, 'owner', 'goal').to_dict()


def after_initial_read(monkeypatch, callback):
    """Run another operation after validation has captured the first revision."""
    def check_packs(_runtime, _uid, ids):
        monkeypatch.setattr(service, '_owned_pack_ids', lambda _app, _owner, keys: set(keys))
        callback()
        return set(ids)
    monkeypatch.setattr(service, '_owned_pack_ids', check_packs)


@pytest.mark.parametrize('include_revision', [True, False])
def test_overlapping_goal_edits_keep_the_first_committed_change(goal_runtime, monkeypatch, include_revision):
    second = []
    after_initial_read(monkeypatch, lambda: second.append(update_goal(
        goal_runtime, {'revision': 1, 'exam_date': '2030-11-21'},
    )))
    payload = {'title': 'Overlapping title'}
    if include_revision:
        payload['revision'] = 1

    status, response = update_goal(goal_runtime, payload)

    assert second[0][0] == 200
    assert status == 409
    assert response['code'] == 'revision_conflict'
    assert stored_goal()['title'] == 'Original goal'
    assert stored_goal()['exam_date'] == '2030-11-21'
    assert stored_goal()['revision'] == 2


def test_pending_edit_cannot_reactivate_an_archived_goal(goal_runtime, monkeypatch):
    planner_repo.set_planner_session(None, 'owner', 'scheduled', {
        'id': 'scheduled', 'goal_id': 'goal', 'date': '2030-11-19',
        'origin': 'automatic', 'status': 'planned', 'revision': 1,
    })
    after_initial_read(monkeypatch, lambda: planner_repo.archive_study_goal(
        None, 'owner', 'goal', expected_revision=1, today='2030-11-14', now_ts=1001,
    ))

    status, response = update_goal(goal_runtime, {'revision': 1, 'title': 'Overlapping title'})

    assert status == 409
    assert response['code'] == 'revision_conflict'
    assert stored_goal()['status'] == 'archived'
    assert stored_goal()['revision'] == 2
    session = planner_repo.get_planner_session(None, 'owner', 'scheduled').to_dict()
    assert session['status'] == 'cancelled'
    assert session['cancellation_reason'] == 'goal_deleted'


def test_pending_edit_cannot_recreate_a_deleted_goal(goal_runtime, monkeypatch):
    after_initial_read(monkeypatch, planner_repo.clear_memory_state)

    status, response = update_goal(goal_runtime, {'revision': 1, 'title': 'Overlapping title'})

    assert status == 409
    assert response['code'] == 'revision_conflict'
    assert not planner_repo.get_study_goal(None, 'owner', 'goal').exists


def test_sequential_stale_revision_returns_the_current_goal(goal_runtime):
    assert update_goal(goal_runtime, {'revision': 1, 'title': 'Saved title'})[0] == 200

    status, response = update_goal(goal_runtime, {'revision': 1, 'exam_date': '2030-11-21'})

    assert status == 409
    assert response['code'] == 'revision_conflict'
    assert response['goal']['revision'] == 2
    assert response['goal']['title'] == 'Saved title'
    assert stored_goal()['exam_date'] == '2030-11-20'


def test_revision_remains_optional_for_an_uncontested_edit(goal_runtime):
    status, response = update_goal(goal_runtime, {'title': 'Legacy client title'})

    assert status == 200
    assert response['goal']['revision'] == 2
    assert stored_goal()['title'] == 'Legacy client title'
    assert stored_goal()['exam_date'] == '2030-11-20'


def test_another_account_cannot_read_or_edit_the_goal(goal_runtime, monkeypatch):
    monkeypatch.setattr(service, '_require_user', lambda *_: ({'uid': 'other'}, None, 0))

    status, response = update_goal(goal_runtime, {'revision': 1, 'title': 'Foreign title'})

    assert status == 404
    assert 'goal' not in response
    assert stored_goal()['title'] == 'Original goal'


def test_account_write_guard_blocks_the_edit_before_goal_access(goal_runtime, monkeypatch):
    monkeypatch.setattr(service, '_write_guard', lambda *_: (
        jsonify({'error': 'Account is unavailable.', 'status': 'account_deletion_in_progress'}), 409,
    ))
    original = stored_goal()
    def unexpected_read(*_args, **_kwargs):
        raise AssertionError('Blocked account must not access a goal')
    with monkeypatch.context() as patch:
        patch.setattr(planner_repo, 'get_study_goal', unexpected_read)
        status, response = update_goal(goal_runtime, {'revision': 1, 'title': 'Blocked title'})

    assert status == 409
    assert response['status'] == 'account_deletion_in_progress'
    assert stored_goal() == original


def test_unowned_pack_validation_still_precedes_goal_write(goal_runtime, monkeypatch):
    monkeypatch.setattr(service, '_owned_pack_ids', lambda *_: set())

    status, _response = update_goal(goal_runtime, {'revision': 1, 'pack_ids': ['foreign-pack']})

    assert status == 400
    assert stored_goal()['pack_ids'] == ['pack']
    assert stored_goal()['revision'] == 1


class GoalDatabase:
    """Exercise the production transaction branch without an external database."""
    def __init__(self, current):
        self.current = deepcopy(current)
        self.pending = []
        self.commits = 0

    def collection(self, name):
        assert name == 'study_goals'
        def document(goal_id):
            assert goal_id == 'goal'
            def get(transaction=None):
                assert transaction is self
                assert not self.pending, 'Read the goal before staging writes'
                snapshot = deepcopy(self.current)
                return SimpleNamespace(exists=snapshot is not None, to_dict=lambda: snapshot)
            return SimpleNamespace(get=get)
        return SimpleNamespace(document=document)

    def transaction(self):
        return self

    def set(self, _ref, payload):
        self.pending.append(deepcopy(payload))

    def commit(self):
        assert len(self.pending) == 1
        self.current = self.pending.pop()
        self.commits += 1


@pytest.fixture
def firestore_transactions(monkeypatch):
    def transactional(function):
        def execute(transaction):
            result = function(transaction)
            transaction.commit()
            return result
        return execute
    monkeypatch.setattr(firestore, 'transactional', transactional)


@pytest.mark.parametrize('current', [
    None,
    {'uid': 'owner', 'revision': 2, 'title': 'Newer goal'},
    {'uid': 'other', 'revision': 1, 'title': 'Other account'},
])
def test_transactional_goal_guard_rejects_missing_changed_or_foreign_goal(firestore_transactions, current):
    db = GoalDatabase(current)

    with pytest.raises(planner_repo.PlannerRevisionConflict):
        planner_repo.set_study_goal_if_revision(
            db, 'owner', 'goal', {'uid': 'owner', 'revision': 2, 'title': 'New title'}, 1,
        )

    assert db.current == current
    assert db.pending == []
    assert db.commits == 0


def test_transactional_goal_guard_commits_the_matching_owned_revision(firestore_transactions):
    db = GoalDatabase({'uid': 'owner', 'revision': 1, 'title': 'Original goal'})
    payload = {'uid': 'owner', 'revision': 2, 'title': 'New title'}

    planner_repo.set_study_goal_if_revision(db, 'owner', 'goal', payload, 1)

    assert db.current == payload
    assert db.commits == 1
