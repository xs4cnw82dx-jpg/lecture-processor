"""Exercise the Firestore transaction branch without any external database."""
from types import SimpleNamespace

import pytest
from google.cloud import firestore

from lecture_processor.repositories import planner_repo


class Database:
    def __init__(self, rows):
        self.rows = rows
        self.pending = []
        self.commits = 0

    def collection(self, name):
        db = self

        class Collection:
            def document(self, key):
                path = name + '/' + key

                def get(transaction=None):
                    assert not db.pending, 'All transaction reads must precede writes'
                    return SimpleNamespace(exists=path in db.rows, to_dict=lambda: db.rows.get(path))

                return SimpleNamespace(path=path, get=get)

            def where(self, *args, **kwargs):
                return self

            def limit(self, _limit):
                return self

            def snapshots(self):
                return [SimpleNamespace(id=path.split('/')[-1], to_dict=lambda item=item: item)
                        for path, item in db.rows.items() if path.startswith(name + '/')]

        return Collection()

    def transaction(self):
        db = self

        class Transaction:
            def get(self, query):
                assert not db.pending
                return query.snapshots()

            def set(self, ref, value):
                db.pending.append((ref.path, value))

        return Transaction()


def fixture_data():
    proposal = {'proposal_id': 'proposal_atomic', 'goal': {}, 'base_goal_revision': 2,
                'base_preferences_revision': 3, 'base_session_versions': {'session_old': 1}, 'applied_at': 123}
    rows = {
        'study_plan_proposals/user': {'proposal_id': 'proposal_atomic', 'applied_at': 0},
        'study_goals/goal_atomic': {'revision': 2},
        'study_plan_preferences/user': {'revision': 3},
        'planner_sessions/user__session_old': {'id': 'session_old', 'revision': 1},
    }
    return proposal, rows


def run_commit(db, proposal):
    planner_repo.commit_study_plan(db, 'user', proposal=proposal,
        goal={'goal_id': 'goal_atomic', 'revision': 3}, preferences={'revision': 4},
        sessions=[{'id': 'session_new', 'revision': 1}],
        cancellations=[{'id': 'session_old', 'revision': 2, 'status': 'cancelled'}],
        start_date='2026-10-03')


def test_firestore_apply_reads_schedule_before_any_atomic_writes(monkeypatch):
    monkeypatch.setattr(firestore, 'transactional', lambda function: function)
    proposal, rows = fixture_data()
    db = Database(rows)
    run_commit(db, proposal)
    assert len(db.pending) == 5
    assert {path for path, value in db.pending} == {
        'study_goals/goal_atomic', 'study_plan_preferences/user', 'study_plan_proposals/user',
        'planner_sessions/user__session_old', 'planner_sessions/user__session_new',
    }


@pytest.mark.parametrize('change', ['changed_session', 'new_session', 'changed_goal', 'accepted_proposal'])
def test_firestore_apply_rejects_concurrent_changes_without_writes(monkeypatch, change):
    monkeypatch.setattr(firestore, 'transactional', lambda function: function)
    proposal, rows = fixture_data()
    if change == 'changed_session':
        rows['planner_sessions/user__session_old']['revision'] = 2
    elif change == 'new_session':
        rows['planner_sessions/user__session_manual'] = {'id': 'session_manual', 'revision': 1}
    elif change == 'changed_goal':
        rows['study_goals/goal_atomic']['revision'] = 3
    else:
        rows['study_plan_proposals/user']['applied_at'] = 42
    db = Database(rows)
    with pytest.raises(planner_repo.PlannerRevisionConflict):
        run_commit(db, proposal)
    assert db.pending == []


def test_reset_transaction_cancels_orphans_and_preserves_history_and_other_accounts(monkeypatch):
    monkeypatch.setattr(firestore, 'transactional', lambda function: function)
    rows = {
        'study_goals/goal': {'uid': 'owner', 'goal_id': 'goal', 'status': 'active'},
        'study_goals/foreign': {'uid': 'other', 'goal_id': 'foreign', 'status': 'active'},
        'study_plan_preferences/owner': {'uid': 'owner', 'revision': 4, 'timezone': 'Europe/Amsterdam'},
    }
    for ident, status in [('orphan', 'planned'), ('done', 'completed'), ('skipped', 'skipped'), ('legacy', None), ('running', 'planned')]:
        rows['planner_sessions/owner__' + ident] = {'uid': 'owner', 'id': ident, 'goal_id': 'missing', 'date': '2000-01-01'}
        if status:
            rows['planner_sessions/owner__' + ident]['status'] = status
    rows['planner_sessions/other__foreign'] = {'uid': 'other', 'id': 'foreign', 'status': 'planned'}
    rows['planner_sessions/owner__running']['active_run_id'] = 'saved_run'
    db = Database(rows)
    checked = []
    result = planner_repo.reset_study_plan(db, 'owner', now_ts=100, idempotency_key='request_one', require_account=lambda **_: checked.append(True))
    assert checked == [True]
    assert result == {'goals_archived': 1, 'sessions_cancelled': 3}
    writes = dict(db.pending)
    assert not any('other__' in key or key.endswith('/foreign') or key.endswith('__done') or key.endswith('__skipped') for key in writes)
    assert writes['planner_sessions/owner__running']['active_run_id'] == 'saved_run'
    assert writes['planner_sessions/owner__legacy']['status'] == 'cancelled'
    assert writes['study_plan_preferences/owner']['revision'] == 5
    assert writes['study_plan_preferences/owner']['timezone'] == 'Europe/Amsterdam'
    db.rows.update(writes)
    db.pending.clear()
    db.rows['study_goals/new_goal'] = {'uid': 'owner', 'goal_id': 'new_goal', 'status': 'active'}
    replay = planner_repo.reset_study_plan(db, 'owner', now_ts=101, idempotency_key='request_one')
    assert replay['replayed'] is True
    assert db.pending == []


def test_reset_over_write_limit_rejects_without_partial_changes(monkeypatch):
    monkeypatch.setattr(firestore, 'transactional', lambda function: function)
    db = Database({f'planner_sessions/owner__s{index}': {'uid': 'owner', 'id': f's{index}', 'status': 'planned'} for index in range(498)})
    with pytest.raises(ValueError, match='too large'):
        planner_repo.reset_study_plan(db, 'owner', now_ts=100, idempotency_key='request')
    assert db.pending == []


def test_reset_account_guard_rejects_before_writes(monkeypatch):
    monkeypatch.setattr(firestore, 'transactional', lambda function: function)
    db = Database({})
    def reject(**_):
        raise RuntimeError('account deleted')
    with pytest.raises(RuntimeError, match='account deleted'):
        planner_repo.reset_study_plan(db, 'owner', now_ts=100, idempotency_key='request', require_account=reject)
    assert db.pending == []
