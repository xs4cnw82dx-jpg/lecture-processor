import json
import logging

from lecture_processor.calendar_observability import (
    _CalendarUrlFilter, redact_calendar_url, scrub_calendar_event,
)


def test_private_urls_are_redacted_in_route_tags_and_access_logs():
    feed = '/calendar/feed/feed_test.secret-token.ics'
    callback = '/api/study-plan/calendar/google/callback?code=private-code&state=private-state'
    assert redact_calendar_url(feed) == '/calendar/feed/[redacted].ics'
    assert redact_calendar_url(callback) == '/api/study-plan/calendar/google/callback?[redacted]'
    record = logging.LogRecord('werkzeug', logging.INFO, '', 0, 'GET %s HTTP/1.1', (callback,), None)
    assert _CalendarUrlFilter().filter(record)
    assert 'private-code' not in record.getMessage()
    assert 'GET /api/study-plan/calendar/google/callback?[redacted] HTTP/1.1' == record.getMessage()


def test_calendar_error_scrubs_query_headers_and_frame_locals_without_mutating_input():
    event = {
        'request': {'url': 'https://example.test/api/study-plan/calendar/google/callback?code=secret-code',
                    'query_string': 'code=secret-code', 'headers': {'Authorization': 'Bearer secret-auth', 'Cookie': 'secret-cookie'}},
        'exception': {'values': [{'stacktrace': {'frames': [{'filename': 'calendar_sync_service.py',
                            'vars': {'token': {'refresh_token': 'secret-refresh'}}}]}}]},
        'breadcrumbs': {'values': [{'data': {'url': 'https://example.test/calendar/feed/feed.secret-feed.ics'}}]},
    }
    scrubbed = scrub_calendar_event(event)
    assert 'secret-' not in json.dumps(scrubbed)
    assert scrubbed['exception']['values'][0]['stacktrace']['frames'] == [{'filename': 'calendar_sync_service.py'}]
    assert 'secret-refresh' in json.dumps(event)


def test_worker_errors_do_not_export_oauth_frame_locals():
    event = {'request': {'url': 'https://example.test/internal/study-plan/calendar-sync/drain'},
             'exception': {'vars': {'connection': {'credentials': 'secret-encrypted'}, 'token': 'secret-access'}}}
    assert 'secret-' not in json.dumps(scrub_calendar_event(event))


def test_unrelated_debug_fields_survive_calendar_specific_scrubber():
    event = {'request': {'url': 'https://example.test/api/ordinary'}, 'vars': {'code': 'useful-code'}, 'tags': {'route.path': '/api/ordinary'}}
    assert scrub_calendar_event(event) == event
