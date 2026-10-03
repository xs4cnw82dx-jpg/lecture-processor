"""Behavioral regressions for daily commitments, persistence and cancellation."""
from datetime import datetime, timezone

import pytest

from lecture_processor.domains.planner import study_plan
from tests.test_study_plan_api import core, study_plan_runtime, _headers, _preview_body  # noqa: F401


def preferences(start='17:00', duration=45):
    return {'timezone': 'Europe/Amsterdam', 'cadence': 'daily', 'daily_start': start,
            'availability_preset': 'daily', 'default_session_minutes': duration,
            'availability': [{'weekday': day, 'start': start, 'end': '20:00'} for day in range(7)]}


def generate(*, duration=45, start='17:00', occupied=None, cards=165):
    return study_plan.generate_schedule(
        goal={'goal_id': 'goal_daily', 'exam_date': '2026-10-31'},
        pack_workloads=[{'pack_id': 'pack_daily', 'title': 'Anatomy', 'cards_remaining': cards}],
        preferences=preferences(start, duration), start_date='2026-10-03',
        occupied=occupied, proposal_id='proposal_daily', now=datetime(2026, 10, 3, 10, tzinfo=timezone.utc),
    )


@pytest.mark.parametrize('duration', [15, 30, 45, 60, 90])
def test_daily_full_sessions_keep_time_duration_and_review_after_coverage(duration):
    result = generate(duration=duration)
    sessions = result['sessions']
    assert len(sessions) == 28
    assert len({item['date'] for item in sessions}) == 28
    assert all(item['time'] == '17:00' and item['duration'] == duration for item in sessions)
    assert sum(item['planned_outcomes']['flashcards'] for item in sessions) == 165
    assert result['shortage_minutes'] == 0
    assert sessions[-1]['study_intent'] == 'review'
    assert sessions[-1]['revision_minutes'] == duration
    assert sessions[-1]['coverage_minutes'] == 0
    assert sessions[0]['starts_at_utc'] == '2026-10-03T15:00:00Z'
    assert sessions[-1]['starts_at_utc'] == '2026-10-30T16:00:00Z'


def test_daily_low_workload_is_full_session_with_explicit_revision():
    result = generate(cards=3)
    assert result['sessions'][0]['duration'] == 45
    assert result['sessions'][0]['study_intent'] == 'mixed'
    assert result['sessions'][0]['planned_outcomes']['flashcards'] == 3
    assert result['sessions'][0]['revision_minutes'] == 40
    assert all(item['planned_outcomes']['flashcards'] == 0 for item in result['sessions'][1:])


def test_daily_preserves_locked_days_removal_exceptions_and_conflicts():
    occupied = [
        {'id': 'session_locked', 'date': '2026-10-04', 'time': '16:00', 'duration': 30, 'goal_id': 'goal_daily', 'pack_id': 'pack_daily', 'locked': True, 'status': 'planned', 'planned_outcomes': {'flashcards': 10}},
        {'id': 'session_removed', 'date': '2026-10-05', 'time': '17:00', 'duration': 45, 'goal_id': 'goal_daily', 'status': 'cancelled', 'cancellation_reason': 'user_removed'},
        {'id': 'session_other', 'date': '2026-10-06', 'time': '17:15', 'duration': 30, 'goal_id': 'goal_other', 'status': 'planned'},
    ]
    result = generate(occupied=occupied)
    assert len(result['sessions']) == 25
    assert [item['date'] for item in result['retained_sessions']] == ['2026-10-04']
    assert result['excluded_dates'] == ['2026-10-05']
    assert result['conflicts'] == [{'date': '2026-10-06', 'time': '17:00', 'session_ids': ['session_other']}]
    assert sum(item['planned_outcomes']['flashcards'] for item in result['sessions']) == 155


def test_daily_shortage_does_not_add_unrequested_sessions():
    result = generate(cards=5000)
    assert len(result['sessions']) == 28
    assert result['shortage_minutes'] > 0
    assert all(item['duration'] == 45 for item in result['sessions'])


def test_workload_spacing_uses_full_year_instead_of_first_200_slots():
    pref = preferences()
    pref['cadence'] = 'workload'
    result = study_plan.generate_schedule(goal={'goal_id': 'goal_daily', 'exam_date': '2027-10-03'},
        pack_workloads=[{'pack_id': 'pack_daily', 'cards_remaining': 165}], preferences=pref, start_date='2026-10-03')
    assert result['sessions'][-1]['date'] == '2027-10-02'


@pytest.fixture
def october_clock(monkeypatch):
    monkeypatch.setattr(core.time, 'time', lambda: datetime(2026, 10, 3, 10, tzinfo=timezone.utc).timestamp())


def preview(client, pack_id, **overrides):
    body = _preview_body(pack_id, '2026-10-31')
    body['preferences'] = preferences()
    body.update(overrides)
    response = client.post('/api/study-plan/preview', json=body, headers=_headers())
    assert response.status_code == 200, response.get_json()
    return response.get_json()['proposal']


def apply(client, proposal, key='idempotency_daily'):
    return client.post('/api/study-plan/apply', json={'proposal_id': proposal['proposal_id'], 'idempotency_key': key}, headers=_headers())


def test_daily_preview_apply_reload_remove_and_undo(client, study_plan_runtime, october_clock):
    pack_id, uid = study_plan_runtime['pack_id'], study_plan_runtime['uid']
    proposal = preview(client, pack_id)
    assert len(proposal['sessions']) == 28
    accepted = apply(client, proposal)
    assert accepted.status_code == 200, accepted.get_json()
    bootstrap = client.get('/api/study-plan?from=2026-10-03&to=2026-10-31', headers=_headers()).get_json()
    assert len([item for item in bootstrap['sessions'] if item['status'] == 'planned']) == 28
    assert bootstrap['goals'][0]['schedule_preferences']['cadence'] == 'daily'
    assert bootstrap['preferences']['daily_start'] == '17:00'
    session = bootstrap['sessions'][0]
    removed = client.put('/api/study-plan/items/' + session['id'], json={'revision': session['revision'], 'status': 'cancelled'}, headers=_headers())
    assert removed.status_code == 200
    assert removed.get_json()['session']['cancellation_reason'] == 'user_removed'
    goal = bootstrap['goals'][0]
    next_proposal = preview(client, pack_id, goal=goal)
    assert next_proposal['excluded_dates'] == ['2026-10-03']
    assert len(next_proposal['sessions']) == 27
    assert apply(client, next_proposal, 'idempotency_next').status_code == 200
    tombstone = core.planner_repo.get_planner_session(None, uid, session['id']).to_dict()
    assert tombstone['status'] == 'cancelled'
    restored = client.put('/api/study-plan/items/' + session['id'], json={'revision': tombstone['revision'], 'status': 'planned'}, headers=_headers())
    assert restored.status_code == 200
    assert restored.get_json()['session']['cancellation_reason'] == ''


def test_stale_preview_cannot_overwrite_new_manual_session(client, study_plan_runtime, october_clock):
    proposal = preview(client, study_plan_runtime['pack_id'])
    saved = client.put('/api/study-plan/items/manual_conflict', json={'title': 'Manual', 'date': '2026-10-04', 'time': '17:00', 'duration': 45}, headers=_headers())
    assert saved.status_code == 201
    rejected = apply(client, proposal)
    assert rejected.status_code == 409
    assert rejected.get_json()['code'] == 'revision_conflict'


def test_conflicting_daily_preview_cannot_be_accepted(client, study_plan_runtime, october_clock):
    # The manual session uses the account's original UTC zone; the new plan uses Amsterdam.
    client.put('/api/study-plan/items/manual_conflict', json={'title': 'Manual', 'date': '2026-10-04', 'time': '15:00', 'duration': 45}, headers=_headers())
    proposal = preview(client, study_plan_runtime['pack_id'])
    assert proposal['can_apply'] is False
    assert len(proposal['conflicts']) == 1
    assert apply(client, proposal).status_code == 409


def test_shortening_deadline_cancels_sessions_beyond_new_deadline(client, study_plan_runtime, october_clock):
    proposal = preview(client, study_plan_runtime['pack_id'])
    accepted = apply(client, proposal).get_json()
    goal = accepted['goal']
    goal['exam_date'] = '2026-10-10'
    shortened = preview(client, study_plan_runtime['pack_id'], goal=goal)
    assert apply(client, shortened, 'idempotency_short').status_code == 200
    sessions = core.planner_repo.list_planner_sessions_by_uid(None, study_plan_runtime['uid'], 400)
    planned = [item for item in sessions if item['status'] == 'planned']
    assert len(planned) == 7
    assert max(item['date'] for item in planned) == '2026-10-09'


def test_invalid_and_too_short_custom_windows_are_rejected(client, study_plan_runtime, october_clock):
    body = _preview_body(study_plan_runtime['pack_id'], '2026-10-31')
    body['preferences']['availability'] = [{'weekday': 0, 'start': '17:00', 'end': '17:30'}]
    response = client.post('/api/study-plan/preview', json=body, headers=_headers())
    assert response.status_code == 400
    assert 'full session' in response.get_json()['error']


def test_nonexistent_dst_clock_is_an_explicit_conflict_not_a_shifted_session():
    result = study_plan.generate_schedule(goal={'goal_id': 'goal_daily', 'exam_date': '2026-03-31'},
        pack_workloads=[{'pack_id': 'pack_daily', 'cards_remaining': 3}], preferences=preferences('02:30'),
        start_date='2026-03-28')
    assert [item['date'] for item in result['sessions']] == ['2026-03-28', '2026-03-30']
    assert result['conflicts'] == [{'date': '2026-03-29', 'time': '02:30', 'session_ids': [], 'reason': 'daylight_saving_time'}]


def test_unchanged_replan_reuses_session_ids_without_duplicate_tombstones(client, study_plan_runtime, october_clock):
    first = preview(client, study_plan_runtime['pack_id'])
    accepted = apply(client, first).get_json()
    second = preview(client, study_plan_runtime['pack_id'], goal=accepted['goal'])
    reapplied = apply(client, second, 'idempotency_reused').get_json()
    assert reapplied['session_ids'] == accepted['session_ids']
    rows = core.planner_repo.list_planner_sessions_by_uid(None, study_plan_runtime['uid'], 400)
    assert len(rows) == 28
    assert all(item['status'] == 'planned' and item['revision'] == 1 for item in rows)


def test_running_session_is_kept_and_run_started_after_preview_invalidates_it(client, study_plan_runtime, october_clock):
    first = preview(client, study_plan_runtime['pack_id'])
    accepted = apply(client, first).get_json()
    uid = study_plan_runtime['uid']
    session_id = accepted['session_ids'][0]
    running = core.planner_repo.get_planner_session(None, uid, session_id).to_dict()
    running['active_run_id'] = 'run_started'
    core.planner_repo.set_planner_session(None, uid, session_id, running, merge=False)
    second = preview(client, study_plan_runtime['pack_id'], goal=accepted['goal'])
    assert second['retained_sessions'][0]['id'] == session_id
    assert len(second['sessions']) == 27
    second_accepted = apply(client, second, 'idempotency_running')
    assert second_accepted.status_code == 200
    assert core.planner_repo.get_planner_session(None, uid, session_id).to_dict()['status'] == 'planned'
    third = preview(client, study_plan_runtime['pack_id'], goal=second_accepted.get_json()['goal'])
    running['active_run_id'] = 'run_changed'
    core.planner_repo.set_planner_session(None, uid, session_id, running, merge=False)
    rejected = apply(client, third, 'idempotency_conflicting_run')
    assert rejected.status_code == 409


@pytest.mark.parametrize('endpoint', ['/api/study-plan/items/', '/api/planner/sessions/'])
@pytest.mark.parametrize('changes', [{'pack_id': ''}, {'duration': 60}, {'planned_outcomes': {'flashcards': 999}}, {'revision_minutes': 99}])
def test_started_run_rejects_material_and_budget_changes(client, study_plan_runtime, october_clock, endpoint, changes):
    accepted = apply(client, preview(client, study_plan_runtime['pack_id'])).get_json()
    uid, session_id = study_plan_runtime['uid'], accepted['session_ids'][0]
    session = core.planner_repo.get_planner_session(None, uid, session_id).to_dict()
    session['active_run_id'] = 'paused_run'
    core.planner_repo.set_planner_session(None, uid, session_id, session, merge=False)
    response = client.put(endpoint + session_id, json={**changes, 'active_run_id': ''}, headers=_headers())
    assert response.status_code == 400, response.get_json()
    assert 'Restart the study run' in response.get_json()['error']
    assert core.planner_repo.get_planner_session(None, uid, session_id).to_dict() == session
    moved = client.put(endpoint + session_id, json={'date': '2026-10-04', 'time': '21:00'}, headers=_headers())
    assert moved.status_code == 200, moved.get_json()
    assert moved.get_json()['session']['active_run_id'] == 'paused_run'
    assert moved.get_json()['session']['duration'] == session['duration']
    removed = client.put(endpoint + session_id, json={'status': 'cancelled'}, headers=_headers())
    assert removed.status_code == 200, removed.get_json()
    assert removed.get_json()['session']['status'] == 'cancelled'


def test_restart_unlocks_session_material_and_duration(client, study_plan_runtime, october_clock):
    accepted = apply(client, preview(client, study_plan_runtime['pack_id'])).get_json()
    uid, session_id = study_plan_runtime['uid'], accepted['session_ids'][0]
    session = core.planner_repo.get_planner_session(None, uid, session_id).to_dict()
    session['active_run_id'] = 'paused_run'
    core.planner_repo.set_planner_session(None, uid, session_id, session, merge=False)
    restarted = client.post('/api/study-plan/items/' + session_id + '/completion', json={'action': 'reopen', 'revision': session['revision']}, headers=_headers())
    assert restarted.status_code == 200, restarted.get_json()
    changed = client.put('/api/study-plan/items/' + session_id, json={'pack_id': '', 'duration': 60}, headers=_headers())
    assert changed.status_code == 200, changed.get_json()
    assert changed.get_json()['session']['active_run_id'] == ''
