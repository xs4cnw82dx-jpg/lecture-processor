from datetime import datetime

from lecture_processor.services import elearning_service as service
from lecture_processor.services.academy_overview import ZONE
from tests.test_academy_authors import ADMIN, AUTHOR, OTHER, change_author, create_course, studio as academy_fixture

studio = academy_fixture
URL = '/api/academy/overview'


def test_dashboard_uses_calendar_periods_comparison_and_allows_only_permitted_results(studio, monkeypatch):
    ts = datetime(2026, 10, 26, 12, tzinfo=ZONE).timestamp()
    monkeypatch.setattr(service, 'now', lambda: ts)
    own = create_course(studio, ADMIN)
    assert change_author(studio, 'grant').status_code == 200
    private = create_course(studio, AUTHOR)
    path = '/api/elearning/expeditions/' + own['id']
    assert studio.post(path + '/sharing', headers=ADMIN, json={
        'action': 'add_member', 'email': 'other@example.test', 'role': 'translate',
    }).status_code == 200
    store = service._store(None)
    def response(course, doc, days, **fields):
        store.put('elearning_responses/' + doc, dict(expedition_id=course['id'], started_at=ts - days * 86400,
                  updated_at=ts, consentVersion=1, **fields))
    response(own, 'current-a', 1, completed=True, cohort='group-a', stepSeconds={'a': 90},
             pilotFeedback={'comment':'Een helder voorbeeld.'})
    response(own, 'current-b', 0, completed=False, cohort='group-b')
    response(own, 'previous', 8, completed=True, cohort='group-a')
    response(private, 'elsewhere', 0, completed=True, cohort='unrelated', pilotFeedback={'comment':'Private comment'})

    data = studio.get(URL + '?days=7', headers=ADMIN).get_json()
    assert data['current'] == {'sessions': 2, 'completed': 1, 'completion': 50, 'medianSeconds': 90, 'measured': 1, 'active': 1}
    assert data['previous']['sessions'] == 1 and data['previous']['medianSeconds'] is None
    assert data['cohorts'] == ['group-a', 'group-b']
    assert [x['id'] for x in data['courses']] == [own['id']]
    assert data['feedback'][0]['comment'] == 'Een helder voorbeeld.'
    assert 'shareToken' not in data['courses'][0]
    assert sum(b['sessions'] for b in data['trend']) == 2
    cohort = studio.get(URL + '?from=2026-10-20&to=2026-10-26&cohort=group-a', headers=ADMIN).json
    assert cohort['current']['completion'] == 100 and cohort['previous']['sessions'] == 1
    other = studio.get(URL, headers=OTHER).json
    assert not other['canCreate'] and 'metrics' not in other['courses'][0]
    assert other['feedback'] == [] and other['cohorts'] == [] and other['current']['sessions'] == 0


def test_dashboard_first_run_access_and_invalid_periods(studio):
    assert studio.get(URL).status_code == 401
    data = studio.get(URL, headers=ADMIN).json
    assert data['courses'] == [] and data['canCreate']
    assert data['current']['completion'] is None
    assert studio.get(URL, headers=AUTHOR).json['canCreate'] is False
    for query in ('from=bad', 'days=0', 'from=2010-01-01&to=2020-01-01'):
        assert studio.get(URL + '?' + query, headers=ADMIN).status_code == 400


def test_workspace_search_respects_course_membership_and_team_access(studio):
    exp = create_course(studio, ADMIN)
    assert change_author(studio, 'grant').status_code == 200
    private = create_course(studio, AUTHOR)
    assert studio.post('/api/elearning/expeditions/' + exp['id'] + '/sharing', headers=ADMIN, json={
        'action': 'add_member', 'email': 'other@example.test', 'role': 'translate',
    }).status_code == 200
    url = '/api/academy/navigation'
    assert studio.get(url).status_code == 401
    owner = studio.get(url, headers=ADMIN).json
    assert private['id'] not in {r['course'] for r in owner['items']}
    assert 'author@example.test' in owner['people']
    other = studio.get(url, headers=OTHER).json
    assert not other['people'] and not other['canCreate']
    assert {r['course'] for r in other['items']} == {exp['id']}
    assert all('shareToken' not in r for r in other['items'])
