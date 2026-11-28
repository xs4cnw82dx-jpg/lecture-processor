"""Consent-aware active time per step: storage through the public API and CSV export."""
import csv
import io

from lecture_processor.services.elearning_service import MAX_STEP_SECONDS
from tests.test_elearning_api import _create_sample, _post_pilot_response, auth_headers, setup as studio_fixture

# Reuse the isolated store and verified Firebase fixture of the Studio API tests.
setup = studio_fixture


def _export(client, expedition_id):
    response = client.get(f'/api/elearning/expeditions/{expedition_id}/responses/export.csv', headers=auth_headers('owner'))
    assert response.status_code == 200
    return {row['session_id']: row for row in csv.DictReader(io.StringIO(response.data.decode('utf-8-sig')))}


def test_shared_time_keeps_the_largest_report_for_each_step(setup):
    client, _ = setup
    course = _create_sample(client)
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    for seconds in (40, 25, 70):
        saved = _post_pilot_response(client, url, json={'sessionId': 'lrn_timed', 'stepSeconds': {'stp_1': seconds}})
        assert saved.status_code == 200
    rows = _export(client, course['id'])
    assert rows['lrn_timed']['seconds_stp_1'] == '70'
    assert rows['lrn_timed']['active_seconds'] == '70'


def test_reports_for_unknown_hidden_or_invalid_steps_are_ignored_and_large_values_capped(setup):
    client, _ = setup
    course = _create_sample(client)
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    report = {'stp_1': 10 ** 9, 'stp_h': 50, 'stp_unknown': 50}
    assert _post_pilot_response(client, url, json={'sessionId': 'lrn_capped', 'stepSeconds': report}).status_code == 200
    for invalid in (-5, 0, 0.4, True, 'ninety', None, float('inf'), [3]):
        response = _post_pilot_response(client, url, json={'sessionId': 'lrn_invalid', 'stepSeconds': {'stp_1': invalid}})
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
    refused = client.post(url, json={'sessionId': 'lrn_private', 'consent': False, 'stepSeconds': {'stp_1': 30}})
    assert refused.status_code == 403
    assert 'lrn_private' not in _export(client, course['id'])
