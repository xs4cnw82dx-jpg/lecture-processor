"""Consent-aware active time per step: storage through the public API and CSV export."""
import csv
import io

from lecture_processor.domains.elearning.reporting import MAX_STEP_SECONDS
from tests.test_elearning_api import _create_sample, _post_pilot_response, auth_headers

# Reuse the isolated store and verified Firebase fixture of the Studio API tests.
from tests.support.academy_analytics import academy_studio as academy_studio_fixture

setup = academy_studio_fixture


def _export(client, expedition_id):
    response = client.get(f'/api/elearning/expeditions/{expedition_id}/responses/export.csv', headers=auth_headers('owner'))
    assert response.status_code == 200
    return {row['session_id']: row for row in csv.DictReader(io.StringIO(response.data.decode('utf-8-sig')), delimiter=';')}


def test_shared_time_keeps_the_largest_report_for_each_step(setup):
    client, _ = setup
    course = _create_sample(client)
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    for seconds in (40, 25, 70):
        saved = _post_pilot_response(client, url, json={'sessionId': 'lrn_timed', 'activeTimeDisclosure': 1, 'stepSeconds': {'stp_1': seconds}})
        assert saved.status_code == 200
    rows = _export(client, course['id'])
    assert rows['lrn_timed']['seconds_stp_1'] == '70'
    assert rows['lrn_timed']['active_seconds'] == '70'


def test_reports_for_unknown_hidden_or_invalid_steps_are_ignored_and_large_values_capped(setup):
    client, _ = setup
    course = _create_sample(client)
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    report = {'stp_1': 10 ** 400, 'stp_h': 50, 'stp_unknown': 50}
    assert _post_pilot_response(client, url, json={'sessionId': 'lrn_capped', 'activeTimeDisclosure': 1, 'stepSeconds': report}).status_code == 200
    for invalid in (-5, 0, 0.4, True, 'ninety', None, float('inf'), [3]):
        response = _post_pilot_response(client, url, json={'sessionId': 'lrn_invalid', 'activeTimeDisclosure': 1, 'stepSeconds': {'stp_1': invalid}})
        assert response.status_code == 200
    rows = _export(client, course['id'])
    # A hidden step keeps its column for the author, but learners cannot report time on it.
    assert rows['lrn_capped']['seconds_stp_h'] == '' and 'seconds_stp_unknown' not in rows['lrn_capped']
    assert rows['lrn_capped']['seconds_stp_1'] == str(MAX_STEP_SECONDS)
    assert rows['lrn_invalid']['seconds_stp_1'] == '' and rows['lrn_invalid']['active_seconds'] == ''


def test_sessions_without_measured_time_leave_the_time_columns_empty(setup):
    client, _ = setup
    course = _create_sample(client)
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    assert _post_pilot_response(client, url, json={'sessionId': 'lrn_untimed', 'answers': {'blk_mf': 'myth'}}).status_code == 200
    row = _export(client, course['id'])['lrn_untimed']
    assert row['active_seconds'] == '' and row['seconds_stp_1'] == ''
    assert row['blk_mf'] == 'myth'


def test_time_is_never_stored_without_the_learners_permission(setup):
    client, _ = setup
    course = _create_sample(client)
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    refused = client.post(url, json={'sessionId': 'lrn_private', 'consent': False, 'activeTimeDisclosure': 1, 'stepSeconds': {'stp_1': 30}})
    assert refused.status_code == 403
    assert 'lrn_private' not in _export(client, course['id'])


def test_old_consent_cannot_start_measuring_in_the_same_session(setup):
    client, _ = setup
    course = _create_sample(client)
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    for affirmative in (None, True, 1):
        body = {'sessionId': 'untimed-existing', 'stepSeconds': {'stp_1': 10}}
        if affirmative is not None:
            body['activeTimeDisclosure'] = affirmative
        assert _post_pilot_response(client, url, json=body).status_code == 200
    assert _export(client, course['id'])['untimed-existing']['active_seconds'] == ''


def test_original_studio_does_not_collect_export_or_disclose_active_time(client, monkeypatch, runtime):
    from tests.test_elearning_api import setup as legacy_fixture
    client, db = legacy_fixture.__wrapped__(client, monkeypatch, runtime)
    course = _create_sample(client)
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    assert _post_pilot_response(client, url, json={'sessionId':'untimed-legacy', 'activeTimeDisclosure':1,
                                                 'stepSeconds':{'stp_1':800}}).status_code == 200
    stored = next(row for path, row in db.data.items() if path.startswith('elearning_responses/'))
    assert not {'stepSeconds','activeTimeDisclosure'}.intersection(stored)
    api = f"/api/elearning/expeditions/{course['id']}/responses"
    assert 'timedSessions' not in client.get(api, headers=auth_headers('owner')).json['summary']
    csv_data = client.get(api+'/export.csv', headers=auth_headers('owner')).data.decode('utf-8-sig')
    assert 'active_seconds' not in next(csv.reader(io.StringIO(csv_data)))
    assert client.get(api+'/export.xlsx', headers=auth_headers('owner')).status_code == 404
    from lxml import html
    page = html.fromstring(client.get('/elearning/p/'+course['share']['token']).data)
    assert not page.xpath('//script[contains(@src,"step-timer")]')
