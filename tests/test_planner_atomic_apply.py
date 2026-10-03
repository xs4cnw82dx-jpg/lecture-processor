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
