from datetime import date

from lecture_processor.services import study_run_service
from tests.test_study_plan_api import core, study_plan_runtime, _headers  # noqa: F401


def create_session(client, fixture, outcomes=None):
    fixture['pack'].update({
        'flashcards': [{'front': 'Muscle A', 'back': 'Answer A', 'image_ids': ['a' * 64]}, {'front': 'Muscle B', 'back': 'Answer B'}],
        'flashcards_count': 2,
        'test_questions': [{'question': 'Q1', 'options': ['A', 'B'], 'answer': 'A'}],
        'test_questions_count': 1,
    })
    response = client.put('/api/study-plan/items/session_run', headers=_headers(), json={
        'title': 'Anatomy review', 'pack_id': fixture['pack_id'], 'date': date.today().isoformat(),
        'time': '17:00', 'duration': 45,
        'planned_outcomes': outcomes or {'flashcards': 2, 'questions': 1},
    })
    assert response.status_code == 201
    return response.get_json()['session']


def start(client):
    response = client.post('/api/study-plan/items/session_run/run', headers=_headers(), json={})
    assert response.status_code == 200, response.get_json()
    return response.get_json()['run']


def checkpoint(client, run, answers=None, active_seconds=0):
    # This represents elapsed study time without sleeping in tests.
    run['started_at'] -= 3600
    core.planner_repo.set_study_activity(None, run['uid'], run['activity_id'], run, merge=False)
    payload = dict(run, checkpoint_revision=run['checkpoint_revision'] + 1, active_seconds=active_seconds,
                   slot_seconds=active_seconds, answers=answers or {})
    response = client.put('/api/study-plan/runs/' + run['activity_id'], headers=_headers(), json=payload)
    assert response.status_code == 200, response.get_json()
    return response.get_json()['run']


def test_empty_and_partial_runs_cannot_complete_and_close_does_not_credit(client, study_plan_runtime):
    session = create_session(client, study_plan_runtime)
    run = start(client)
    session = core.planner_repo.get_planner_session(None, study_plan_runtime['uid'], session['id']).to_dict()
    assert len(run['queue']) == 3
    for answers in ({}, {'fc_0': {'correct': True}}):
        run = checkpoint(client, run, answers, 60 if answers else 0)
        result = client.post('/api/study-plan/items/session_run/completion', headers=_headers(),
                             json={'source': 'tracked', 'revision': session['revision']})
        assert result.status_code == 400
    saved = core.planner_repo.get_planner_session(None, study_plan_runtime['uid'], session['id']).to_dict()
    assert saved['status'] == 'planned'
    assert client.put('/api/study-plan/items/session_run', headers=_headers(), json={'status': 'completed'}).status_code == 400
    assert client.put('/api/planner/sessions/session_run', headers=_headers(), json={'status': 'completed'}).status_code == 400


def test_complete_replay_reopen_keeps_answers_and_rejects_stale_checkpoint(client, study_plan_runtime):
    session = create_session(client, study_plan_runtime)
    run = start(client)
    session = core.planner_repo.get_planner_session(None, study_plan_runtime['uid'], session['id']).to_dict()
    answers = {item['id']: {'correct': True} for item in run['queue']}
    run = checkpoint(client, run, answers, 180)
    payload = {'source': 'tracked', 'revision': session['revision']}
    completed = client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json=payload)
    assert completed.status_code == 200
    session = completed.get_json()['session']
    assert session['completion']['reason'] == 'targets_met'
    replay = client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json=payload)
    assert replay.get_json()['replayed'] is True
    assert replay.get_json()['session']['revision'] == session['revision']
    reopened = client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json={'action': 'reopen', 'revision': session['revision']})
    assert reopened.get_json()['session']['status'] == 'planned'
    resumed = start(client)
    assert resumed['answers'] == run['answers']
    assert resumed['active_seconds'] == 180
    assert resumed['activity_id'] == run['activity_id']
    stale = dict(run, checkpoint_revision=99)
    assert client.put('/api/study-plan/runs/' + run['activity_id'], headers=_headers(), json=stale).status_code == 409


def test_offline_log_actual_minutes_no_mastery_and_undo(client, study_plan_runtime):
    session = create_session(client, study_plan_runtime)
    body = {'source': 'offline', 'revision': session['revision'], 'idempotency_key': 'test_log'}
    for minutes in (0, -1, 1.5, True, 1441, ''):
        assert client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json=dict(body, minutes=minutes)).status_code == 400
    completed = client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json=dict(body, minutes=12)).get_json()['session']
    assert client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json=dict(body, minutes=12)).get_json()['replayed'] is True
    progress = client.get('/api/study-plan', headers=_headers()).get_json()['progress']
    assert progress['completed_minutes'] == 12
    assert progress['offline_minutes'] == 12
    assert progress['cards_reviewed'] == progress['questions_answered'] == 0
    result = client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json={'action': 'reopen', 'revision': completed['revision']})
    assert result.status_code == 200
    progress = client.get('/api/study-plan', headers=_headers()).get_json()['progress']
    assert progress['completed_minutes'] == 0
    assert client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json=dict(body, minutes=12)).status_code == 409


def test_changed_pack_remaps_answered_picture_card_and_rebuilds_unfinished(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    run = checkpoint(client, start(client), {'fc_0': {'correct': True}}, 60)
    original = study_plan_runtime['pack']['flashcards'][0]
    study_plan_runtime['pack']['flashcards'] = [{'front': 'Replacement', 'back': 'New answer'}, original]
    resumed = start(client)
    assert resumed['content_updated'] is True
    assert resumed['answers'] == {'fc_1': {'type': 'fc', 'correct': True}}
    assert resumed['active_seconds'] == 60
    assert resumed['metrics']['cards_reviewed'] == 1
    assert resumed['queue'][0]['id'] == 'fc_1'
    assert resumed['queue'][0]['content_key'] == run['queue'][0]['content_key']


def test_removed_answer_preserves_credited_work_and_limits_replacement_queue(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    checkpoint(client, start(client), {'fc_0': {'correct': True}}, 60)
    study_plan_runtime['pack']['flashcards'] = [study_plan_runtime['pack']['flashcards'][1]]
    resumed = start(client)
    assert len(resumed['retired_answers']) == 1
    assert resumed['metrics']['cards_reviewed'] == 1
    assert len([item for item in resumed['queue'] if item['type'] == 'fc']) == 1


def test_cancelled_sessions_cannot_be_completed_by_activity_retries(client, study_plan_runtime):
    session = create_session(client, study_plan_runtime)
    run = start(client)
    session = core.planner_repo.get_planner_session(None, study_plan_runtime['uid'], session['id']).to_dict()
    deleted = client.put('/api/study-plan/items/session_run', headers=_headers(), json={'status': 'cancelled', 'revision': session['revision']})
    assert deleted.status_code == 200
    assert client.put('/api/study-plan/runs/' + run['activity_id'], headers=_headers(), json=dict(run, checkpoint_revision=1)).status_code == 409
    assert client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json={'source': 'tracked', 'revision': deleted.get_json()['session']['revision']}).status_code == 409


def test_run_ownership_queue_validation_and_elapsed_timer_validation(client, study_plan_runtime, monkeypatch):
    create_session(client, study_plan_runtime)
    run = start(client)
    invalid = dict(run, checkpoint_revision=1, answers={'fc_999': {'correct': True}})
    assert client.put('/api/study-plan/runs/' + run['activity_id'], headers=_headers(), json=invalid).status_code == 400
    invalid = dict(run, checkpoint_revision=1, active_seconds=500, slot_seconds=500)
    assert client.put('/api/study-plan/runs/' + run['activity_id'], headers=_headers(), json=invalid).status_code == 400
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'other-user', 'email': 'student@example.com'})
    assert client.post('/api/study-plan/items/session_run/run', headers=_headers(), json={}).status_code == 404
    assert client.put('/api/study-plan/runs/' + run['activity_id'], headers=_headers(), json=dict(run, checkpoint_revision=1)).status_code == 404


def test_due_retry_new_revision_order_keeps_original_indexes():
    pack = {'flashcards': [{'front': str(index)} for index in range(4)]}
    state = {'fc_0': {'seen': 1, 'next_review_date': '2099-01-01'},
             'fc_2': {'seen': 1, 'next_review_date': '2026-01-01'},
             'fc_3': {'seen': 1, 'last_action': 'retry'}}
    queue = study_run_service.build_queue(pack, state, {'duration': 45, 'planned_outcomes': {'flashcards': 3}}, '2026-10-03')
    assert [item['id'] for item in queue] == ['fc_3', 'fc_2', 'fc_1']


def test_mixed_revision_uses_one_focus_budget_including_pomodoro_breaks():
    pack = {'flashcards': [{'front': str(index)} for index in range(50)],
            'test_questions': [{'question': str(index)} for index in range(50)]}
    session = {'duration': 45, 'timer_mode': 'pomodoro', 'planned_outcomes': {'flashcards': 4}, 'revision_minutes': 41, 'study_intent': 'mixed'}
    queue = study_run_service.build_queue(pack, {}, session, '2026-10-03')
    assert sum(item['estimated_seconds'] for item in queue) == 40 * 60
    assert any(item['type'] == 'q' for item in queue)
    manual = study_run_service.build_queue(pack, {}, {'duration': 45}, '2026-10-03')
    assert sum(item['estimated_seconds'] for item in manual) == 45 * 60


def test_live_content_change_rejects_stale_checkpoint_and_finish(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    run = start(client)
    study_plan_runtime['pack']['flashcards'][0]['front'] = 'Changed elsewhere'
    assert client.put('/api/study-plan/runs/' + run['activity_id'], headers=_headers(), json=dict(run, checkpoint_revision=1)).status_code == 409
    session = core.planner_repo.get_planner_session(None, study_plan_runtime['uid'], 'session_run').to_dict()
    assert client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json={'source': 'tracked', 'revision': session['revision']}).status_code == 409


def test_stale_tab_cannot_silently_drop_a_new_answer(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    original = start(client)
    saved = checkpoint(client, original, {'fc_0': {'correct': True}})
    assert saved['checkpoint_revision'] == 1
    stale = dict(original, checkpoint_revision=1, answers={'q_0': {'correct': True}})
    assert client.put('/api/study-plan/runs/' + original['activity_id'], headers=_headers(), json=stale).status_code == 409
    assert client.put('/api/study-plan/runs/' + original['activity_id'], headers=_headers(), json=dict(stale, retry_done=3)).status_code == 400


def test_time_completion_requires_full_focus_budget_not_just_one_answer(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    run = start(client)
    run['started_at'] -= 4000
    core.planner_repo.set_study_activity(None, run['uid'], run['activity_id'], run, merge=False)
    sparse = dict(run, checkpoint_revision=1, active_seconds=1, slot_seconds=2700, answers={'fc_0': {'correct': True}})
    assert client.put('/api/study-plan/runs/' + run['activity_id'], headers=_headers(), json=sparse).status_code == 200
    session = core.planner_repo.get_planner_session(None, run['uid'], 'session_run').to_dict()
    assert client.post('/api/study-plan/items/session_run/completion', headers=_headers(), json={'source': 'tracked', 'revision': session['revision']}).status_code == 400


def test_mode_choice_filters_targets_and_preserves_resume_timer(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    response = client.post('/api/study-plan/items/session_run/run', headers=_headers(),
                           json={'study_mode': 'flashcards', 'timer_mode': 'pomodoro'})
    assert response.status_code == 200
    run = response.get_json()['run']
    assert {item['type'] for item in run['queue']} == {'fc'}
    response = client.post('/api/study-plan/items/session_run/run', headers=_headers(), json={'study_mode': 'test'})
    assert response.status_code == 200
    run = response.get_json()['run']
    assert run['timer_mode'] == 'pomodoro'
    assert {item['type'] for item in run['queue']} == {'q'}
    run = checkpoint(client, run, {'q_0': {'correct': True}}, 20)
    blocked = client.post('/api/study-plan/items/session_run/run', headers=_headers(), json={'study_mode': 'flashcards'})
    assert blocked.status_code == 409
    resumed = start(client)
    assert resumed['study_mode'] == 'test'
    assert resumed['answers'] == run['answers']


def test_notes_mode_survives_content_rebuild_and_rejects_unavailable_mode(client, study_plan_runtime):
    create_session(client, study_plan_runtime)
    study_plan_runtime['pack']['notes_markdown'] = '# Anatomy notes'
    response = client.post('/api/study-plan/items/session_run/run', headers=_headers(), json={'study_mode': 'notes'})
    assert response.status_code == 200
    assert [item['type'] for item in response.get_json()['run']['queue']] == ['notes']
    study_plan_runtime['pack']['notes_markdown'] += '\nChanged text'
    resumed = start(client)
    assert [item['type'] for item in resumed['queue']] == ['notes']
    invalid = client.post('/api/study-plan/items/session_run/run', headers=_headers(), json={'study_mode': 'write'})
    assert invalid.status_code == 400
