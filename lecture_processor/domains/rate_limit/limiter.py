import re

from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def check_rate_limit(key, limit, window_seconds, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return resolved_runtime.rate_limit_service.check_rate_limit(
        key,
        limit,
        window_seconds,
        firestore_enabled=resolved_runtime.RATE_LIMIT_FIRESTORE_ENABLED,
        db=resolved_runtime.db,
        firestore_module=resolved_runtime.firestore,
        counter_collection=resolved_runtime.RATE_LIMIT_COUNTER_COLLECTION,
        in_memory_events=resolved_runtime.RATE_LIMIT_EVENTS,
        in_memory_lock=resolved_runtime.RATE_LIMIT_LOCK,
        time_module=resolved_runtime.time,
    )


def build_rate_limited_response(message, retry_after, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    response = resolved_runtime.jsonify({
        'error': message,
        'retry_after_seconds': int(max(1, retry_after)),
    })
    response.status_code = 429
    response.headers['Retry-After'] = str(int(max(1, retry_after)))
    return response


def normalize_rate_limit_key_part(value, fallback='anon', max_len=120, runtime=None):
    raw = str(value or '').strip().lower()
    if not raw:
        return fallback
    safe = re.sub('[^a-z0-9_.:@-]+', '_', raw)
    return safe[:max_len] if safe else fallback
