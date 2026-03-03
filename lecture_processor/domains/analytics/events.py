from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def sanitize_analytics_event_name(raw_name, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return resolved_runtime.analytics_service.sanitize_event_name(
        raw_name,
        name_re=resolved_runtime.ANALYTICS_NAME_RE,
        allowed_events=resolved_runtime.ANALYTICS_ALLOWED_EVENTS,
    )


def sanitize_analytics_session_id(raw_session_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return resolved_runtime.analytics_service.sanitize_session_id(
        raw_session_id,
        session_id_re=resolved_runtime.ANALYTICS_SESSION_ID_RE,
    )


def sanitize_analytics_properties(raw_props, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return resolved_runtime.analytics_service.sanitize_properties(
        raw_props,
        name_re=resolved_runtime.ANALYTICS_NAME_RE,
    )


def log_analytics_event(event_name, source='frontend', uid='', email='', session_id='', properties=None, created_at=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return resolved_runtime.analytics_service.log_analytics_event(
        event_name,
        source=source,
        uid=uid,
        email=email,
        session_id=session_id,
        properties=properties,
        created_at=created_at,
        db=resolved_runtime.db,
        name_re=resolved_runtime.ANALYTICS_NAME_RE,
        session_id_re=resolved_runtime.ANALYTICS_SESSION_ID_RE,
        allowed_events=resolved_runtime.ANALYTICS_ALLOWED_EVENTS,
        logger=resolved_runtime.logger,
        time_module=resolved_runtime.time,
    )


def log_rate_limit_hit(limit_name, retry_after=0, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return resolved_runtime.analytics_service.log_rate_limit_hit(
        limit_name,
        retry_after=retry_after,
        db=resolved_runtime.db,
        logger=resolved_runtime.logger,
        time_module=resolved_runtime.time,
    )
