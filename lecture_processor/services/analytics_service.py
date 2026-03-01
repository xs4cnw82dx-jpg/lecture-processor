"""Analytics event sanitization and persistence helpers."""


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
):
    safe_name = sanitize_event_name(event_name, name_re=name_re, allowed_events=allowed_events)
    if not safe_name:
        return False
    safe_source = str(source or 'frontend').strip().lower()[:16]
    payload = {
        'event': safe_name,
        'source': safe_source if safe_source in {'frontend', 'backend'} else 'frontend',
        'uid': str(uid or '')[:128],
        'email': str(email or '').lower()[:160],
        'session_id': sanitize_session_id(session_id, session_id_re=session_id_re),
        'properties': sanitize_properties(properties or {}, name_re=name_re),
        'created_at': created_at if isinstance(created_at, (int, float)) else time_module.time(),
    }
    try:
        db.collection('analytics_events').add(payload)
        return True
    except Exception as exc:
        if logger is not None:
            logger.info(f"⚠️ Could not store analytics event {safe_name}: {exc}")
        return False


def log_rate_limit_hit(limit_name, retry_after=0, *, db, logger, time_module):
    safe_name = str(limit_name or '').strip().lower()
    if safe_name not in {'upload', 'checkout', 'analytics'}:
        return False
    try:
        retry_after_seconds = int(float(retry_after))
    except Exception:
        retry_after_seconds = 1
    retry_after_seconds = max(1, retry_after_seconds)
    try:
        db.collection('rate_limit_logs').add({
            'limit_name': safe_name,
            'retry_after_seconds': retry_after_seconds,
            'created_at': time_module.time(),
        })
        return True
    except Exception as exc:
        if logger is not None:
            logger.info(f"⚠️ Could not store rate limit log ({safe_name}): {exc}")
        return False
