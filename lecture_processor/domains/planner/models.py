"""Validation and normalization helpers for synced planner data."""

from __future__ import annotations

import re
from datetime import datetime

SESSION_ID_RE = re.compile(r'^[A-Za-z0-9_-]{4,120}$')
DATE_RE = re.compile(r'^(\d{4})-(\d{2})-(\d{2})$')
TIME_RE = re.compile(r'^([01]\d|2[0-3]):([0-5]\d)$')

DEFAULT_SETTINGS = {
    'enabled': 'off',
    'offset': '30',
    'daily_enabled': 'on',
    'daily_time': '19:00',
}
ALLOWED_OFFSETS = {'5', '10', '15', '30', '60'}


def sanitize_session_id(value, runtime=None):
    _ = runtime
    safe = str(value or '').strip()
    if not safe or not SESSION_ID_RE.match(safe):
        return ''
    return safe


def _sanitize_date(value):
    raw = str(value or '').strip()
    match = DATE_RE.match(raw)
    if not match:
        return ''
    year = int(match.group(1))
    month = int(match.group(2))
    day = int(match.group(3))
    try:
        datetime(year, month, day)
    except ValueError:
        return ''
    return raw


def _sanitize_time(value):
    raw = str(value or '').strip()
    if not TIME_RE.match(raw):
        return ''
    return raw


def sanitize_session_payload(payload, *, session_id='', existing=None, now_ts=0.0, runtime=None):
    _ = runtime
    source = payload if isinstance(payload, dict) else {}
    current = existing if isinstance(existing, dict) else {}
    safe_id = sanitize_session_id(session_id or source.get('id', '') or current.get('id', ''))
    if not safe_id:
        return (None, 'Session id is invalid.')
    title = ' '.join(str(source.get('title', current.get('title', '')) or '').split()).strip()[:160]
    if not title:
        return (None, 'Session title is required.')
    date_value = _sanitize_date(source.get('date', current.get('date', '')))
    if not date_value:
        return (None, 'Session date must use YYYY-MM-DD.')
    time_value = _sanitize_time(source.get('time', current.get('time', '')))
    if not time_value:
        return (None, 'Session time must use HH:MM in 24-hour format.')
    try:
        duration = int(source.get('duration', current.get('duration', 0)) or 0)
    except Exception:
        duration = 0
    if duration < 5 or duration > 360:
        return (None, 'Duration must be between 5 and 360 minutes.')
    notes = str(source.get('notes', current.get('notes', '')) or '').strip()[:2000]
    pack_id = str(source.get('pack_id', current.get('pack_id', '')) or '').strip()[:120]
    pack_title = ' '.join(str(source.get('pack_title', current.get('pack_title', '')) or '').split()).strip()[:160]
    created_at = float(current.get('created_at', now_ts) or now_ts)
    return (
        {
            'id': safe_id,
            'title': title,
            'date': date_value,
            'time': time_value,
            'duration': duration,
            'notes': notes,
            'pack_id': pack_id,
            'pack_title': pack_title,
            'created_at': created_at,
            'updated_at': float(now_ts or created_at or 0.0),
        },
        '',
    )


def sanitize_settings_payload(payload, *, existing=None, runtime=None):
    _ = runtime
    source = payload if isinstance(payload, dict) else {}
    current = existing if isinstance(existing, dict) else {}
    merged = dict(DEFAULT_SETTINGS)
    merged.update(current)

    if 'enabled' in source:
        merged['enabled'] = 'on' if str(source.get('enabled', '') or '').strip().lower() == 'on' else 'off'
    if 'offset' in source:
        offset = str(source.get('offset', '') or '').strip()
        merged['offset'] = offset if offset in ALLOWED_OFFSETS else DEFAULT_SETTINGS['offset']
    if 'daily_enabled' in source:
        merged['daily_enabled'] = 'off' if str(source.get('daily_enabled', '') or '').strip().lower() == 'off' else 'on'
    if 'daily_time' in source:
        daily_time = _sanitize_time(source.get('daily_time', ''))
        merged['daily_time'] = daily_time if daily_time else DEFAULT_SETTINGS['daily_time']
    if merged['daily_enabled'] != 'on':
        merged['daily_time'] = ''
    return merged


def merge_settings(existing, incoming, now_ts=0.0, runtime=None):
    merged = sanitize_settings_payload(incoming, existing=existing, runtime=runtime)
    merged['updated_at'] = float(now_ts or 0.0)
    return merged


def sort_sessions(sessions, runtime=None):
    _ = runtime
    return sorted(
        [dict(item) for item in (sessions or []) if isinstance(item, dict)],
        key=lambda item: (
            str(item.get('date', '') or ''),
            str(item.get('time', '') or '00:00'),
            str(item.get('title', '') or '').lower(),
            str(item.get('id', '') or ''),
        ),
    )
