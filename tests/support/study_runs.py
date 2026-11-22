from datetime import date

from tests.runtime_test_support import get_test_core
from tests.support.study_plan_api import _headers


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
    core = get_test_core()
    # This represents elapsed study time without sleeping in tests.
    run['started_at'] -= 3600
    core.planner_repo.set_study_activity(None, run['uid'], run['activity_id'], run, merge=False)
    payload = dict(run, checkpoint_revision=run['checkpoint_revision'] + 1, active_seconds=active_seconds,
                   slot_seconds=active_seconds, answers=answers or {})
    response = client.put('/api/study-plan/runs/' + run['activity_id'], headers=_headers(), json=payload)
    assert response.status_code == 200, response.get_json()
    return response.get_json()['run']
