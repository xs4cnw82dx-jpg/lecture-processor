"""Save recovery and deletion must preserve existing study work."""
from datetime import datetime, timezone

import pytest
from google.api_core.exceptions import DeadlineExceeded, FailedPrecondition

from tests.test_study_plan_daily import apply, preview, october_clock  # noqa: F401
from tests.test_study_plan_api import core, study_plan_runtime, _headers  # noqa: F401


def test_missing_index_is_actionable_and_same_preview_can_retry(client, study_plan_runtime, october_clock, monkeypatch):
    proposal = preview(client, study_plan_runtime['pack_id'])
    original = core.planner_repo.commit_study_plan
    def fail(*args, **kwargs):
        raise FailedPrecondition('Synthetic index unavailable')
    monkeypatch.setattr(core.planner_repo, 'commit_study_plan', fail)
    response = apply(client, proposal)
    assert response.status_code == 503
    assert response.get_json()['code'] == 'planner_unavailable'
    assert not core.planner_repo.list_study_goals_by_uid(None, study_plan_runtime['uid'])
    monkeypatch.setattr(core.planner_repo, 'commit_study_plan', original)
    assert apply(client, proposal).status_code == 200


def test_committed_lost_response_replays_after_new_preview_and_expiry(client, study_plan_runtime, october_clock, monkeypatch):
    proposal = preview(client, study_plan_runtime['pack_id'])
    original = core.planner_repo.commit_study_plan
    def lose_response(*args, **kwargs):
        original(*args, **kwargs)
        raise DeadlineExceeded('Synthetic response lost after commit')
    monkeypatch.setattr(core.planner_repo, 'commit_study_plan', lose_response)
    response = apply(client, proposal)
    assert response.status_code == 503
    assert response.get_json()['code'] == 'save_unconfirmed'
    uid = study_plan_runtime['uid']
    saved_ids = {item['id'] for item in core.planner_repo.list_planner_sessions_by_uid(None, uid, 400)}
    newer = preview(client, study_plan_runtime['pack_id'])
    monkeypatch.setattr(core.planner_repo, 'commit_study_plan', original)
    monkeypatch.setattr(core.time, 'time', lambda: datetime(2026, 10, 5, 10, tzinfo=timezone.utc).timestamp())
    replay = apply(client, proposal)
    assert replay.status_code == 200
    assert replay.get_json()['replayed'] is True
    assert set(replay.get_json()['session_ids']) == saved_ids
    assert len(core.planner_repo.list_study_goals_by_uid(None, uid)) == 1
    assert {item['id'] for item in core.planner_repo.list_planner_sessions_by_uid(None, uid, 400)} == saved_ids
    assert core.planner_repo.get_study_plan_proposal(None, uid).to_dict()['proposal_id'] == newer['proposal_id']
    assert apply(client, proposal, 'different_request').status_code == 409


def test_older_preview_receipt_does_not_replace_newer_preview(client, study_plan_runtime, october_clock):
    first = preview(client, study_plan_runtime['pack_id'])
    newer = preview(client, study_plan_runtime['pack_id'])
    assert apply(client, first).status_code == 200
    uid = study_plan_runtime['uid']
    assert core.planner_repo.get_study_plan_proposal(None, uid).to_dict()['proposal_id'] == newer['proposal_id']
    assert apply(client, first).get_json()['replayed'] is True
    assert apply(client, newer, 'newer_request').status_code == 409


def test_delete_goal_is_atomic_and_preserves_completed_active_and_manual_work(client, study_plan_runtime, october_clock):
    accepted = apply(client, preview(client, study_plan_runtime['pack_id'])).get_json()
    uid, goal = study_plan_runtime['uid'], accepted['goal']
    sessions = core.planner_repo.list_planner_sessions_by_uid(None, uid, 400)
    changes = [{'status': 'completed'}, {'active_run_id': 'saved_run'}, {'origin': 'manual'}]
    protected = []
    for item, change in zip(sessions, changes):
        item.update(change)
        core.planner_repo.set_planner_session(None, uid, item['id'], item, merge=False)
        protected.append(item)
    path = '/api/study-plan/goals/' + goal['goal_id']
    stale = client.delete(path, headers=_headers(), json={'revision': goal['revision'] - 1})
    assert stale.status_code == 409
    assert core.planner_repo.get_study_goal(None, uid, goal['goal_id']).to_dict()['status'] == 'active'
    deleted = client.delete(path, headers=_headers(), json={'revision': goal['revision']})
    assert deleted.status_code == 200
    assert deleted.get_json()['goal']['status'] == 'archived'
    for item in protected:
        assert core.planner_repo.get_planner_session(None, uid, item['id']).to_dict() == item
    unprotected = [item for item in core.planner_repo.list_planner_sessions_by_uid(None, uid, 400) if item['id'] not in {record['id'] for record in protected}]
    assert all(item['status'] == 'cancelled' for item in unprotected)
    assert client.delete(path, headers=_headers(), json={'revision': goal['revision']}).status_code == 200
    assert client.post('/api/study-plan/preview', headers=_headers(), json={'goal': goal}).status_code == 409


def test_oversized_goal_archive_never_partially_removes_sessions():
    repo = core.planner_repo
    repo.clear_memory_state()
    uid, goal_id = 'oversized-owner', 'oversized-goal'
    goal = {'uid': uid, 'goal_id': goal_id, 'revision': 1, 'status': 'active'}
    repo.set_study_goal(None, uid, goal_id, goal, merge=False)
    for index in range(496):
        repo.set_planner_session(None, uid, f'session_{index}', {'id': f'session_{index}', 'uid': uid,
            'goal_id': goal_id, 'date': '2026-10-05', 'origin': 'automatic', 'status': 'planned', 'revision': 1}, merge=False)
    with pytest.raises(ValueError, match='too many'):
        repo.archive_study_goal(None, uid, goal_id, expected_revision=1, today='2026-10-03', now_ts=1)
    assert repo.get_study_goal(None, uid, goal_id).to_dict() == goal
    assert all(item['status'] == 'planned' for item in repo.list_planner_sessions_by_uid(None, uid, 1000))
    repo.clear_memory_state()
