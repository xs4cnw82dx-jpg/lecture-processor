"""Resetting a course's learner statistics through the standalone Studio."""
import csv
import io

from google.api_core.exceptions import InvalidArgument, ResourceExhausted

from lecture_processor.services import elearning_account_service, elearning_service as service
from tests.support.academy_analytics import academy_studio as academy_fixture
from tests.test_academy_authors import (ADMIN, AUTHOR, OTHER, change_author, create_course,
                                      studio as authors_fixture)
from tests.test_elearning_api import _create_sample, _post_pilot_response, auth_headers

academy = academy_fixture
authors = authors_fixture
OWNER = auth_headers('owner')


def paths(course):
    return ('/api/elearning/expeditions/' + course['id'], '/api/elearning/public/' + course['share']['token'])


def submit(client, public, session, group='pilot'):
    return _post_pilot_response(client, public + '/responses', json={
        'sessionId': session, 'cohort': group, 'answers': {'blk_mf': 'myth'},
        'peerDisclosureTypes': {'blk_mf': 'myth_fact'}, 'visitedStepIds': ['stp_1'],
        'activeTimeDisclosure': 1, 'stepSeconds': {'stp_1': 20}, 'completed': True,
        'pilotFeedback': {'comment': 'Synthetic feedback'},
    })


def test_reset_excludes_old_results_across_surfaces_and_resumes_without_losing_new_sessions(academy, monkeypatch):
    client, store = academy
    monkeypatch.setattr(service, 'RESPONSE_RESET_PAGE', 1)
    monkeypatch.setattr(elearning_account_service, 'ElearningStore', lambda _: store)
    course, other = _create_sample(client), _create_sample(client)
    owner_url, public = paths(course)
    other_url, other_public = paths(other)
    report_url = owner_url + '/responses'
    course_path = 'elearning_expeditions/' + course['id']
    original = store.get(course_path)
    for session in ('session_0001', 'session_0002', 'session_0003'):
        assert submit(client, public, session).status_code == 200
    assert submit(client, other_public, 'session_0001').status_code == 200
    peer_url = public + '/aggregates/blk_mf'
    assert client.get(peer_url).json['aggregate']['count'] == 3
    report = client.get(report_url + '?cohort=absent', headers=OWNER).json
    assert report['summary']['totalSessions'] == 0
    assert report['statisticsReset']['totalSessions'] == 3
    confirmation = {'version': report['statisticsReset']['version'], 'confirmTitle': course['title']}

    def reset():
        return client.post(report_url + '/reset', headers=OWNER, json=confirmation)

    first = reset()
    assert first.status_code == 202 and first.json['pending']
    assert len(store.list('elearning_responses', 'expedition_id', course['id'])) == 2
    pending = client.get(report_url, headers=OWNER).json
    assert pending['statisticsReset'] == {'version': confirmation['version'], 'totalSessions': 0, 'pending': True}
    assert pending['pilotFeedback'] == [] and pending['cohorts'] == [] and pending['summary']['totalSessions'] == 0
    assert client.get(peer_url).json['aggregate']['count'] == 0
    assert client.get(owner_url + '/outline-results', headers=OWNER).json['totalSessions'] == 0
    assert client.get(other_url + '/responses', headers=OWNER).json['summary']['totalSessions'] == 1
    assert client.get('/api/elearning/admin/statistics', headers=OWNER).json['sessions'] == 1
    overview = client.get('/api/academy/overview', headers=OWNER).json
    assert overview['current']['sessions'] == 1
    rows = client.get(report_url + '/export.csv', headers=OWNER)
    assert not list(csv.DictReader(io.StringIO(rows.data.decode('utf-8-sig')), delimiter=';'))
    runtime = client.application.extensions['lecture_processor']['runtime']
    bundle = elearning_account_service.collect(runtime, 'owner')
    assert next(c for c in bundle if c['id'] == course['id'])['responses'] == []
    unchanged = store.get(course_path)
    assert {k:v for k,v in unchanged.items() if k not in ('_statisticsReset','share')} == {k:v for k,v in original.items() if k != 'share'}
    assert {k:v for k,v in unchanged['share'].items() if k != 'collectionVersion'} == {k:v for k,v in original['share'].items() if k != 'collectionVersion'}
    assert unchanged['share']['collectionVersion'] != original['share']['collectionVersion']
    assert client.get(public).status_code == 200
    stale = client.post(public + '/responses', json={'sessionId':'session_0002', 'consent': True,
                                               'collectionVersion': original['share']['collectionVersion']})
    assert stale.status_code == 409
    assert submit(client, public, 'session_0002', 'new-group').status_code == 200
    assert client.get(report_url, headers=OWNER).json['cohorts'] == ['new-group']
    # A sharing setting can also change during cleanup. Continuations preserve its new token.
    settings = client.post(owner_url + '/sharing', headers=OWNER, json={'action':'update_public','allowStepComments':True})
    assert settings.status_code == 200
    for _ in range(5):
        response = reset()
        if response.status_code == 200:
            break
        assert response.status_code == 202
    assert response.json == {'reset':True, 'pending':False}
    assert reset().json == response.json
    assert store.get(course_path)['share'] == settings.json['share']
    stored = store.list('elearning_responses', 'expedition_id', course['id'])
    assert [s['cohort'] for s in stored] == ['new-group']
    assert client.get(other_url + '/responses', headers=OWNER).json['summary']['totalSessions'] == 1
    fresh = client.get(report_url, headers=OWNER).json['statisticsReset']
    assert fresh['totalSessions'] == 1 and not fresh['pending'] and fresh['version'] != confirmation['version']
    assert client.post(report_url + '/reset', headers=OWNER, json={**confirmation,'version':fresh['version']}).status_code == 200
    assert store.list('elearning_responses', 'expedition_id', course['id']) == []
    assert reset().status_code == 409


def test_only_the_current_owner_can_reset_or_continue_a_reset(authors, monkeypatch):
    client = authors
    assert change_author(client, 'grant').status_code == 200
    course = create_course(client, AUTHOR)
    course_url, _ = paths(course)
    assert client.post(course_url + '/sharing', headers=AUTHOR,
                       json={'action':'add_member','email':'other@example.test','role':'edit'}).status_code == 200
    assert 'statisticsReset' not in client.get(course_url + '/responses', headers=OTHER).json
    report = client.get(course_url + '/responses', headers=AUTHOR).json
    confirmation = {'version':report['statisticsReset']['version'], 'confirmTitle':course['title']}
    reset = course_url + '/responses/reset'
    for headers in (ADMIN, OTHER, {}):
        assert client.post(reset, headers=headers, json=confirmation).status_code == 403
    for body, status in (({},400), ({**confirmation,'version':'stale'},409), ({**confirmation, 'confirmTitle':'other'},409)):
        assert client.post(reset, headers=AUTHOR, json=body).status_code == status
    monkeypatch.setattr(service, 'RESPONSE_RESET_PAGE', 1)
    store = service._store(None)
    for sid in ['old-a', 'old-b']:
        store.put('elearning_responses/' + sid, {'expedition_id':course['id'], 'session_id':sid})
    assert client.post(reset, headers=AUTHOR, json=confirmation).status_code == 202
    assert change_author(client, 'revoke').status_code == 200
    assert client.post(reset, headers=AUTHOR, json=confirmation).status_code == 403
    assert len(store.list('elearning_responses','expedition_id', course['id'])) == 1


def test_reset_error_rolls_back_deletion_and_collection_token(academy, monkeypatch):
    client, store = academy
    course = _create_sample(client)
    course_url, public = paths(course)
    assert submit(client, public, 'session_0001').status_code == 200
    report = client.get(course_url + '/responses', headers=OWNER).json
    confirmation = {'version':report['statisticsReset']['version'],'confirmTitle':course['title']}
    with monkeypatch.context() as patch:
        def failure(*args, **kwargs):
            raise RuntimeError('Synthetic database interruption')
        patch.setattr(store, 'update_fields', failure)
        assert client.post(course_url + '/responses/reset', headers=OWNER, json=confirmation).status_code == 503
    assert client.get(course_url + '/responses', headers=OWNER).json['statisticsReset'] == report['statisticsReset']
    assert client.post(course_url + '/responses/reset', headers=OWNER, json=confirmation).status_code == 200


def test_reset_endpoint_is_exclusive_to_academy(client):
    assert client.post('/api/elearning/expeditions/course-id/responses/reset', headers=OWNER, json={}).status_code == 404


def test_oversized_firestore_transactions_are_retried_in_smaller_pages_and_quotas_surface(academy, monkeypatch):
    client, store = academy
    course = _create_sample(client)
    course_url, _ = paths(course)
    report_url = course_url + '/responses'
    for index in range(10):
        store.put(f'elearning_responses/large-{index}', {'expedition_id':course['id'], 'session_id':str(index)})
    version = client.get(report_url, headers=OWNER).json['statisticsReset']['version']
    confirmation = {'version':version, 'confirmTitle':course['title']}
    monkeypatch.setattr(service, 'RESPONSE_RESET_PAGE', 8)
    attempts = []
    atomic = store.atomic
    def limited_atomic(operation):
        def check(tx):
            before = len(tx.data)
            result = operation(tx)
            removed = before - len(tx.data)
            attempts.append(removed)
            if removed > 2:
                raise InvalidArgument('Transaction too large: maximum request size of 10485760 bytes')
            return result
        return atomic(check)
    monkeypatch.setattr(store, 'atomic', limited_atomic)
    assert client.post(report_url + '/reset', headers=OWNER, json=confirmation).status_code == 202
    assert attempts == [8, 4, 2]
    attempts.clear()
    assert client.post(report_url + '/reset', headers=OWNER, json=confirmation).status_code == 202
    assert attempts == [2]
    quota_calls = []
    def quota(operation):
        quota_calls.append(True)
        raise ResourceExhausted('Quota exceeded for read requests')
    monkeypatch.setattr(store, 'atomic', quota)
    assert client.post(report_url + '/reset', headers=OWNER, json=confirmation).status_code == 503
    assert quota_calls == [True]
