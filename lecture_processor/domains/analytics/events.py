from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def sanitize_analytics_event_name(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_analytics_event_name(*args, **kwargs)


def sanitize_analytics_session_id(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_analytics_session_id(*args, **kwargs)


def sanitize_analytics_properties(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_analytics_properties(*args, **kwargs)


def log_analytics_event(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).log_analytics_event(*args, **kwargs)


def log_rate_limit_hit(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).log_rate_limit_hit(*args, **kwargs)
