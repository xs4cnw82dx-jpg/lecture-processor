"""Keep private subscription URLs and OAuth callback secrets out of telemetry."""
from __future__ import annotations

import logging
import re

_FEED = re.compile(r'(/calendar/feed/)[^\s?\"<>]+')
_CALLBACK = re.compile(r'(/api/study-plan/calendar/google/callback)\?[^\s\"<>]*')
_PRIVATE_KEYS = {'authorization', 'cookie', 'cookies', 'access_token', 'refresh_token', 'id_token',
                 'client_secret', 'credentials', 'nonce', 'code', 'state', 'query_string', 'http.query',
                 'http.request.header.authorization', 'http.request.header.cookie'}


def redact_calendar_url(value):
    return _CALLBACK.sub(r'\1?[redacted]', _FEED.sub(r'\1[redacted].ics', str(value)))


def scrub_calendar_event(event, hint=None):
    """Sentry errors, traces and breadcrumbs all use the same URL filtering."""
    request = event.get('request') or {} if isinstance(event, dict) else {}
    location = str(request.get('url', '')) if isinstance(request, dict) else ''
    calendar_request = ('/calendar/feed/' in location or '/api/study-plan/calendar/' in location
                        or '/internal/study-plan/calendar-sync/' in location)

    def scrub(value):
        if isinstance(value, str):
            return redact_calendar_url(value)
        if isinstance(value, (list, tuple)):
            return [scrub(item) for item in value]
        if isinstance(value, dict):
            # Calendar exceptions can contain refresh tokens in frame locals.
            return {key: ('[redacted]' if calendar_request and str(key).lower() in _PRIVATE_KEYS else scrub(item))
                    for key, item in value.items() if not (calendar_request and key == 'vars')}
        return value

    return scrub(event)


class _CalendarUrlFilter(logging.Filter):
    def filter(self, record):
        message = record.getMessage()
        redacted = redact_calendar_url(message)
        if redacted != message:
            record.msg, record.args = redacted, ()
        return True


def install_calendar_log_filters():
    for target in [*logging.getLogger().handlers, logging.getLogger('werkzeug'), logging.getLogger('gunicorn.access')]:
        if not any(isinstance(item, _CalendarUrlFilter) for item in target.filters):
            target.addFilter(_CalendarUrlFilter())
