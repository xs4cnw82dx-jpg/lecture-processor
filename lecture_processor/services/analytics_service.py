"""Analytics event sanitization and persistence helpers."""

from datetime import datetime, timezone

from lecture_processor.domains.admin import rollups as admin_rollups
from lecture_processor.repositories import analytics_repo


DEFAULT_TELEMETRY_RETENTION_SECONDS = 90 * 24 * 60 * 60


def _telemetry_expires_at(created_at, runtime=None):
    retention = getattr(runtime, 'TELEMETRY_RETENTION_SECONDS', DEFAULT_TELEMETRY_RETENTION_SECONDS)
    try:
        retention_seconds = int(retention)
    except Exception:
        retention_seconds = DEFAULT_TELEMETRY_RETENTION_SECONDS
    return float(created_at or 0) + max(24 * 60 * 60, retention_seconds)


def _telemetry_expires_at_ts(expires_at):
    try:
        return datetime.fromtimestamp(float(expires_at), tz=timezone.utc)
    except Exception:
        return datetime.fromtimestamp(_telemetry_expires_at(0), tz=timezone.utc)


def sanitize_event_name(raw_name, *, name_re, allowed_events):
    name = str(raw_name or '').strip().lower()
    if not name_re.match(name):
        return ''
    return name if name in allowed_events else ''


def sanitize_session_id(raw_session_id, *, session_id_re):
    session_id = str(raw_session_id or '').strip()
    if not session_id_re.match(session_id):
        return ''
    return session_id


def sanitize_properties(raw_props, *, name_re):
    if not isinstance(raw_props, dict):
        return {}
    cleaned = {}
    for raw_key, raw_value in raw_props.items():
        key = str(raw_key or '').strip().lower().replace('-', '_').replace(' ', '_')
        if not key or not name_re.match(key):
            continue
        if isinstance(raw_value, bool):
            cleaned[key] = raw_value
            continue
        if isinstance(raw_value, (int, float)):
            cleaned[key] = round(float(raw_value), 4)
            continue
        if isinstance(raw_value, str):
            cleaned[key] = raw_value.strip()[:200]
            continue
    return cleaned


def log_analytics_event(
    event_name,
    source='frontend',
    uid='',
    email='',
    session_id='',
    properties=None,
    created_at=None,
    *,
    db,
    name_re,
    session_id_re,
    allowed_events,
    logger,
    time_module,
    runtime=None,
):
    safe_name = sanitize_event_name(event_name, name_re=name_re, allowed_events=allowed_events)
    if not safe_name:
        return False
    safe_source = str(source or 'frontend').strip().lower()[:16]
    event_created_at = created_at if isinstance(created_at, (int, float)) else time_module.time()
    event_expires_at = _telemetry_expires_at(event_created_at, runtime=runtime)
    payload = {
        'event': safe_name,
        'source': safe_source if safe_source in {'frontend', 'backend'} else 'frontend',
        'uid': str(uid or '')[:128],
        'email': str(email or '').lower()[:160],
        'session_id': sanitize_session_id(session_id, session_id_re=session_id_re),
        'properties': sanitize_properties(properties or {}, name_re=name_re),
        'created_at': event_created_at,
        'expires_at': event_expires_at,
        'expires_at_ts': _telemetry_expires_at_ts(event_expires_at),
    }
    try:
        analytics_repo.add_event(db, payload)
        admin_rollups.increment_analytics_rollups(payload, runtime=runtime)
        return True
    except Exception as exc:
        if logger is not None:
            logger.info(f"⚠️ Could not store analytics event {safe_name}: {exc}")
        return False


def log_rate_limit_hit(limit_name, retry_after=0, *, db, logger, time_module, runtime=None):
    safe_name = str(limit_name or '').strip().lower()
    if safe_name not in admin_rollups.KNOWN_RATE_LIMITS:
        return False
    try:
        retry_after_seconds = int(float(retry_after))
    except Exception:
        retry_after_seconds = 1
    retry_after_seconds = max(1, retry_after_seconds)
    try:
        created_at = time_module.time()
        expires_at = _telemetry_expires_at(created_at, runtime=runtime)
        payload = {
            'limit_name': safe_name,
            'retry_after_seconds': retry_after_seconds,
            'created_at': created_at,
            'expires_at': expires_at,
            'expires_at_ts': _telemetry_expires_at_ts(expires_at),
        }
        analytics_repo.add_rate_limit_log(db, payload)
        admin_rollups.increment_rate_limit_rollups(payload, runtime=runtime)
        return True
    except Exception as exc:
        if logger is not None:
            logger.info(f"⚠️ Could not store rate limit log ({safe_name}): {exc}")
        return False
