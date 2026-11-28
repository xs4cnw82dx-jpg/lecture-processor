"""Report analytics: active-time quartiles, station totals, weekly activity and period filter."""
import time

from tests.test_elearning_api import _post_pilot_response, auth_headers, setup as studio_fixture

setup = studio_fixture
WEEK = 7 * 86400


def _step(step_id, title):
    return {'id': step_id, 'title': {'nl': title, 'en': title, 'de': ''}, 'blocks': []}


def _course(client):
    payload = {
        'title': 'Pijn begrijpen', 'defaultLanguage': 'nl', 'enabledLanguages': ['nl'],
        'modules': [
            {'id': 'mod_a', 'title': {'nl': 'Station A'}, 'domain': 'bio', 'estimatedMinutes': 5, 'visibleToLearners': True,
             'steps': [_step('s1', 'Vraag'), _step('s2', 'Uitleg')]},
            {'id': 'mod_b', 'title': {'nl': 'Station B'}, 'domain': 'social', 'estimatedMinutes': 3, 'visibleToLearners': True,
             'steps': [_step('s3', 'Plan')]},
        ],
    }
    created = client.post('/api/elearning/expeditions', json=payload, headers=auth_headers('owner'))
    assert created.status_code == 201, created.json
    course = created.json['expedition']
    shared = client.post(f"/api/elearning/expeditions/{course['id']}/sharing", headers=auth_headers('owner'),
                         json={'action': 'update_public', 'enabled': True, 'collectResponses': True})
    assert shared.status_code == 200
    return course['id'], '/api/elearning/public/' + shared.json['share']['token'] + '/responses'


def _sessions(client, url):
    for session, seconds, visited, completed in (
        ('lrn_timed_1', {'s1': 60, 's2': 120, 's3': 30}, ['s1', 's2', 's3'], True),
        ('lrn_timed_2', {'s1': 100, 's2': 200}, ['s1', 's2'], False),
        ('lrn_timed_3', {'s1': 20}, ['s1'], False),
        ('lrn_untimed', None, ['s1', 's2'], False),
    ):
        body = {'sessionId': session, 'visitedStepIds': visited, 'completed': completed}
        if seconds:
            body['stepSeconds'] = seconds
        assert _post_pilot_response(client, url, json=body).status_code == 200


def _report(client, course_id, query=''):
    response = client.get(f'/api/elearning/expeditions/{course_id}/responses{query}', headers=auth_headers('owner'))
    assert response.status_code == 200
    return response.json


def test_active_time_uses_only_measured_sessions_per_course_station_and_step(setup):
    client, _ = setup
    course_id, url = _course(client)
    _sessions(client, url)
    report = _report(client, course_id)
    assert report['summary']['totalSessions'] == 4
    assert report['summary']['timedSessions'] == 3
    assert report['summary']['activeSeconds'] == {'median': 210, 'p25': 115, 'p75': 255, 'count': 3}
    steps = {row['stepId']: row for row in report['funnel']}
    assert steps['s1']['time'] == {'median': 60, 'p25': 40, 'p75': 80, 'count': 3}
    assert steps['s2']['time'] == {'median': 160, 'p25': 140, 'p75': 180, 'count': 2}
    assert steps['s3']['time'] == {'median': 30, 'p25': 30, 'p75': 30, 'count': 1}
    assert [row['reached'] for row in report['funnel']] == [4, 3, 1]
    stations = {row['moduleId']: row for row in report['stations']}
    assert stations['mod_a']['time'] == {'median': 180, 'p25': 100, 'p75': 240, 'count': 3}
    assert stations['mod_b']['time']['median'] == 30 and stations['mod_b']['estimatedMinutes'] == 3


def test_a_course_without_measured_time_reports_none_instead_of_zero(setup):
    client, _ = setup
    course_id, url = _course(client)
    assert _post_pilot_response(client, url, json={'sessionId': 'lrn_only', 'visitedStepIds': ['s1']}).status_code == 200
    report = _report(client, course_id)
    assert report['summary']['timedSessions'] == 0 and report['summary']['activeSeconds'] is None
    assert all(row['time'] is None for row in report['funnel'])
    assert all(row['time'] is None for row in report['stations'])


def test_weekly_activity_fills_quiet_weeks_and_the_period_filter_drops_older_sessions(setup):
    client, db = setup
    course_id, url = _course(client)
    _sessions(client, url)
    older = next(path for path in db.data if path.endswith('__lrn_timed_3'))
    db.data[older]['started_at'] = time.time() - 3 * WEEK
    weekly = _report(client, course_id)['weekly']
    assert [week['started'] for week in weekly] == [1, 0, 0, 3]
    assert [week['completed'] for week in weekly] == [0, 0, 0, 1]
    assert all(week['week'] < later['week'] for week, later in zip(weekly, weekly[1:]))
    recent = _report(client, course_id, '?days=7')
    assert recent['summary']['totalSessions'] == 3 and recent['summary']['timedSessions'] == 2
    for ignored in ('?days=0', '?days=abc', '?days=99999'):
        assert _report(client, course_id, ignored)['summary']['totalSessions'] == 4
