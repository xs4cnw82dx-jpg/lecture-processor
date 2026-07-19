from datetime import date, timedelta

import pytest

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.planner import study_plan
from tests.runtime_test_support import get_test_core


core = get_test_core()

pytestmark = pytest.mark.usefixtures('disable_sentry')


class _Snapshot:
    def __init__(self, payload=None, doc_id=''):
        self._payload = dict(payload or {})
        self.id = doc_id
        self.exists = payload is not None

    def to_dict(self):
        return dict(self._payload)


@pytest.fixture
def study_plan_runtime(monkeypatch):
    uid = 'study-plan-user'
    pack_id = 'pack_questions'
    pack = {
        'uid': uid,
        'study_pack_id': pack_id,
        'title': 'Question-only pack',
        'flashcards_count': 0,
        'test_questions_count': 12,
        'folder_id': '',
        'created_at': 1,
    }
    monkeypatch.setattr(core, 'db', None)
    monkeypatch.setattr(core, 'PUBLIC_BASE_URL', 'https://lectureprocessor.test')
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda _email, runtime=None: True)
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': uid, 'email': 'student@example.com'})
    monkeypatch.setattr(account_lifecycle, 'ensure_account_allows_writes', lambda _uid, runtime=None: (True, ''))
    monkeypatch.setattr(core.study_repo, 'list_study_pack_summaries_by_uid', lambda _db, _uid, _limit, after_doc=None: [_Snapshot(pack, pack_id)] if after_doc is None else [])
    monkeypatch.setattr(core.study_repo, 'get_study_pack_summary_doc', lambda _db, requested: _Snapshot(pack, requested) if requested == pack_id else _Snapshot())
    monkeypatch.setattr(core.study_repo, 'list_study_folders_by_uid', lambda _db, _uid: [])
    monkeypatch.setattr(core, 'get_study_card_state_doc', lambda _uid, _pack_id: type('Ref', (), {'get': lambda self: _Snapshot({'state': {}})})())
    monkeypatch.setattr(core, 'get_study_progress_doc', lambda _uid: type('Ref', (), {'get': lambda self: _Snapshot()})())
    monkeypatch.setattr(core.study_repo, 'list_study_card_states_by_uid', lambda _db, _uid, _limit: [])
    core.planner_repo.clear_memory_state()
    yield {'uid': uid, 'pack_id': pack_id, 'pack': pack}
    core.planner_repo.clear_memory_state()


def _headers():
    return {'Authorization': 'Bearer test'}


def _preview_body(pack_id, exam_date=None):
    deadline = exam_date or (date.today() + timedelta(days=10)).isoformat()
    return {
        'goal': {'title': 'Question final', 'exam_date': deadline, 'pack_ids': [pack_id]},
        'preferences': {
            'timezone': 'UTC',
            'availability': [{'weekday': weekday, 'start': '18:00', 'end': '20:00'} for weekday in range(7)],
            'default_session_minutes': 45,
        },
    }


def test_study_plan_endpoints_require_auth(client):
    assert client.get('/api/study-plan').status_code == 401
    assert client.get('/api/study-plan/membership').status_code == 401
    assert client.get('/api/study-plan/library').status_code == 401
    assert client.put('/api/study-plan/preferences', json={}).status_code == 401
    assert client.post('/api/study-plan/goals', json={}).status_code == 401
    assert client.post('/api/study-plan/preview', json={}).status_code == 401
    assert client.post('/api/study-plan/apply', json={}).status_code == 401
    assert client.put('/api/study-plan/items/session_test', json={}).status_code == 401
    assert client.put('/api/study-activity/sessions/activity_test', json={}).status_code == 401
    assert client.post('/api/study-plan/calendar-feeds', json={}).status_code == 401


def test_question_only_unfiled_pack_bootstrap_preview_and_idempotent_apply(client, study_plan_runtime):
    bootstrap = client.get('/api/study-plan', headers=_headers())

    assert bootstrap.status_code == 200
    payload = bootstrap.get_json()
    assert payload['study_packs'][0]['folder_id'] == ''
    assert payload['study_packs'][0]['workload']['questions_remaining'] == 12
    assert payload['study_packs'][0]['workload']['total_minutes'] == 28

    preview = client.post('/api/study-plan/preview', json=_preview_body(study_plan_runtime['pack_id']), headers=_headers())
    assert preview.status_code == 200
    proposal = preview.get_json()['proposal']
    assert proposal['sessions']
    assert proposal['summary']['shortage_minutes'] == 0
    assert proposal['sessions'][0]['planned_outcomes']['questions'] > 0

    apply_response = client.post(
        '/api/study-plan/apply',
        json={'proposal_id': proposal['proposal_id'], 'idempotency_key': 'idem_question_plan'},
        headers=_headers(),
    )
    replay = client.post(
        '/api/study-plan/apply',
        json={'proposal_id': proposal['proposal_id'], 'idempotency_key': 'idem_question_plan'},
        headers=_headers(),
    )
    conflict = client.post(
        '/api/study-plan/apply',
        json={'proposal_id': proposal['proposal_id'], 'idempotency_key': 'idem_different_key'},
        headers=_headers(),
    )

    assert apply_response.status_code == 200
    assert apply_response.get_json()['replayed'] is False
    assert replay.status_code == 200
    assert replay.get_json()['replayed'] is True
    assert replay.get_json()['session_ids'] == apply_response.get_json()['session_ids']
    assert conflict.status_code == 409
    membership = client.get('/api/study-plan/membership', headers=_headers()).get_json()
    assert membership['pack_ids'] == [study_plan_runtime['pack_id']]


def test_study_plan_library_pages_are_bounded_and_cursor_owned(client, study_plan_runtime, monkeypatch):
    packs = [
        {**study_plan_runtime['pack'], 'study_pack_id': f'pack_page_{index}', 'title': f'Pack {index}', 'created_at': 10 - index}
        for index in range(4)
    ]
    docs = [_Snapshot(pack, pack['study_pack_id']) for pack in packs]

    def list_page(_db, _uid, limit, after_doc=None):
        start = 0
        if after_doc is not None:
            start = next(index for index, doc in enumerate(docs) if doc.id == after_doc.id) + 1
        return docs[start:start + limit]

    monkeypatch.setattr(core.study_repo, 'list_study_pack_summaries_by_uid', list_page)
    monkeypatch.setattr(
        core.study_repo,
        'get_study_pack_doc',
        lambda _db, pack_id: next((doc for doc in docs if doc.id == pack_id), _Snapshot()),
    )

    first = client.get('/api/study-plan/library?limit=2', headers=_headers())
    assert first.status_code == 200
    assert [item['study_pack_id'] for item in first.get_json()['study_packs']] == ['pack_page_0', 'pack_page_1']
    assert first.get_json()['next_cursor'] == 'pack_page_1'

    second = client.get('/api/study-plan/library?limit=2&cursor=pack_page_1', headers=_headers())
    assert second.status_code == 200
    assert [item['study_pack_id'] for item in second.get_json()['study_packs']] == ['pack_page_2', 'pack_page_3']
    assert second.get_json()['next_cursor'] == ''
    assert client.get('/api/study-plan/library?cursor=pack_from_other_user', headers=_headers()).status_code == 400


def test_revision_conflicts_and_failed_session_move_can_be_reverted(client, study_plan_runtime):
    bootstrap = client.get('/api/study-plan', headers=_headers()).get_json()
    revision = bootstrap['preferences']['revision']
    first = client.put(
        '/api/study-plan/preferences',
        json={'revision': revision, 'timezone': 'Europe/Amsterdam', 'availability': []},
        headers=_headers(),
    )
    stale = client.put(
        '/api/study-plan/preferences',
        json={'revision': revision, 'timezone': 'UTC', 'availability': []},
        headers=_headers(),
    )
    assert first.status_code == 200
    assert stale.status_code == 409
    assert stale.get_json()['code'] == 'revision_conflict'

    created = client.put(
        '/api/study-plan/items/manual_revision',
        json={'title': 'Manual review', 'date': date.today().isoformat(), 'time': '19:00', 'duration': 45},
        headers=_headers(),
    )
    assert created.status_code == 201
    session = created.get_json()['session']
    moved = client.put(
        '/api/study-plan/items/manual_revision',
        json={'revision': session['revision'], 'title': session['title'], 'date': session['date'], 'time': '20:00', 'duration': 45},
        headers=_headers(),
    )
    stale_move = client.put(
        '/api/study-plan/items/manual_revision',
        json={'revision': session['revision'], 'title': session['title'], 'date': session['date'], 'time': '21:00', 'duration': 45},
        headers=_headers(),
    )
    assert moved.status_code == 200
    assert stale_move.status_code == 409


def test_legacy_folder_migration_retry_is_idempotent(client, study_plan_runtime, monkeypatch):
    study_plan_runtime['pack']['folder_id'] = 'folder_legacy'
    study_plan_runtime['pack']['folder_name'] = 'Legacy folder'
    monkeypatch.setattr(
        core.study_repo,
        'list_study_folders_by_uid',
        lambda _db, _uid: [_Snapshot({
            'uid': study_plan_runtime['uid'],
            'name': 'Legacy folder',
            'exam_date': (date.today() + timedelta(days=20)).isoformat(),
        }, 'folder_legacy')],
    )

    first = client.get('/api/study-plan', headers=_headers())
    assert first.status_code == 200
    first_goals = first.get_json()['goals']
    assert len(first_goals) == 1
    assert first_goals[0]['migrated_from_folder_id'] == 'folder_legacy'

    preferences = core.planner_repo.get_study_plan_preferences(None, study_plan_runtime['uid']).to_dict()
    preferences['migration_v1_complete'] = False
    core.planner_repo.set_study_plan_preferences(None, study_plan_runtime['uid'], preferences, merge=False)
    retried = client.get('/api/study-plan', headers=_headers())

    assert retried.status_code == 200
    assert len(retried.get_json()['goals']) == 1


def test_activity_checkpoint_completes_linked_session_and_aggregates_questions(client, study_plan_runtime):
    session = client.put(
        '/api/study-plan/items/session_activity',
        json={
            'title': 'Practice questions',
            'date': date.today().isoformat(),
            'time': '19:00',
            'duration': 45,
            'pack_id': study_plan_runtime['pack_id'],
            'planned_outcomes': {'questions': 10},
        },
        headers=_headers(),
    ).get_json()['session']

    checkpoint = client.put(
        '/api/study-activity/sessions/activity_questions',
        json={
            'pack_id': study_plan_runtime['pack_id'],
            'plan_item_id': session['id'],
            'mode': 'test',
            'started_at': core.time.time() - 300,
            'ended_at': core.time.time(),
            'metrics': {'minutes': 5, 'questions_answered': 4, 'correct': 3, 'incorrect': 1},
        },
        headers=_headers(),
    )
    assert checkpoint.status_code == 200
    activity = checkpoint.get_json()['activity']
    assert activity['questions_completed'] == 4
    assert activity['accuracy_percent'] == 75
    stored = core.planner_repo.get_planner_session(None, study_plan_runtime['uid'], session['id']).to_dict()
    assert stored['status'] == 'completed'


def test_activity_and_resource_ids_reject_invalid_input(client, study_plan_runtime):
    invalid_timestamp = client.put(
        '/api/study-activity/sessions/activity_invalid_time',
        json={
            'pack_id': study_plan_runtime['pack_id'],
            'started_at': 'not-a-timestamp',
            'metrics': {'minutes': 1},
        },
        headers=_headers(),
    )

    assert invalid_timestamp.status_code == 400
    assert client.put('/api/study-plan/items/bad.id', json={}, headers=_headers()).status_code == 400
    assert client.patch('/api/study-plan/goals/bad.id', json={}, headers=_headers()).status_code == 400
    assert client.delete('/api/study-plan/calendar-feeds/bad.id', headers=_headers()).status_code == 400


def test_private_calendar_feed_hash_rotation_revocation_and_ics(client, study_plan_runtime):
    goal_response = client.post(
        '/api/study-plan/goals',
        json={
            'title': 'Calendar exam',
            'exam_date': (date.today() + timedelta(days=14)).isoformat(),
            'pack_ids': [study_plan_runtime['pack_id']],
        },
        headers=_headers(),
    )
    assert goal_response.status_code == 201
    session = client.put(
        '/api/study-plan/items/calendar_session',
        json={
            'title': 'Questions, cards; review',
            'date': (date.today() + timedelta(days=1)).isoformat(),
            'time': '18:00',
            'duration': 45,
            'pack_id': study_plan_runtime['pack_id'],
        },
        headers=_headers(),
    ).get_json()['session']

    created = client.post(
        '/api/study-plan/calendar-feeds',
        json={'name': 'My phone', 'reminder_offset_minutes': 10},
        headers=_headers(),
    )
    assert created.status_code == 201
    created_payload = created.get_json()
    feed = created_payload['feed']
    old_url = created_payload['subscription_url'].replace('https://lectureprocessor.test', '')
    stored = core.planner_repo.get_calendar_feed(None, feed['feed_id']).to_dict()
    assert 'secret_hash' in stored
    assert stored['secret_hash'] not in created_payload['subscription_url']

    calendar = client.get(old_url)
    assert calendar.status_code == 200
    body = calendar.get_data(as_text=True)
    assert 'BEGIN:VCALENDAR' in body
    assert f'UID:{session["id"]}@lectureprocessor.com' in body
    assert r'Questions\, cards\; review' in body
    assert 'BEGIN:VALARM' in body
    assert 'Exam: Calendar exam' in body

    moved = client.put(
        f'/api/study-plan/items/{session["id"]}',
        json={
            'revision': session['revision'],
            'title': session['title'],
            'date': session['date'],
            'time': '19:00',
            'duration': session['duration'],
            'pack_id': session['pack_id'],
        },
        headers=_headers(),
    ).get_json()['session']
    updated_calendar = client.get(old_url).get_data(as_text=True)
    assert f'UID:{session["id"]}@lectureprocessor.com' in updated_calendar
    assert 'SEQUENCE:2' in updated_calendar
    assert 'T190000Z' in updated_calendar

    skipped = client.put(
        f'/api/study-plan/items/{session["id"]}',
        json={
            'revision': moved['revision'],
            'title': moved['title'],
            'date': moved['date'],
            'time': moved['time'],
            'duration': moved['duration'],
            'pack_id': moved['pack_id'],
            'status': 'skipped',
        },
        headers=_headers(),
    )
    assert skipped.status_code == 200
    assert 'STATUS:CANCELLED' in client.get(old_url).get_data(as_text=True)

    rotated = client.post(f'/api/study-plan/calendar-feeds/{feed["feed_id"]}/rotate', json={}, headers=_headers())
    assert rotated.status_code == 200
    new_url = rotated.get_json()['subscription_url'].replace('https://lectureprocessor.test', '')
    assert client.get(old_url).status_code == 404
    assert client.get(new_url).status_code == 200

    bootstrap = client.get('/api/study-plan', headers=_headers()).get_json()
    assert 'subscription_url' not in bootstrap['calendar_feeds'][0]
    for index in range(2, 6):
        assert client.post(
            '/api/study-plan/calendar-feeds',
            json={'name': f'Device {index}'},
            headers=_headers(),
        ).status_code == 201
    assert client.post('/api/study-plan/calendar-feeds', json={'name': 'Too many'}, headers=_headers()).status_code == 409

    revoked = client.delete(f'/api/study-plan/calendar-feeds/{feed["feed_id"]}', headers=_headers())
    assert revoked.status_code == 200
    assert client.get(new_url).status_code == 410
    assert client.get('/calendar/feed/not-a-valid-token.ics').status_code == 404
