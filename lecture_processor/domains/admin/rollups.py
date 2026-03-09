"""Admin rollup writes and lazy backfill helpers."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

from lecture_processor.runtime.container import get_runtime

HOURLY_COLLECTION = 'admin_rollups_hourly'
DAILY_COLLECTION = 'admin_rollups_daily'
KNOWN_RATE_LIMITS = ('upload', 'checkout', 'analytics', 'tools')
KNOWN_MODES = ('lecture-notes', 'slides-only', 'interview', 'other')


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _bucket_period_for_window(window_key):
    return 'hourly' if str(window_key or '') == '24h' else 'daily'


def _collection_for_period(period):
    return HOURLY_COLLECTION if period == 'hourly' else DAILY_COLLECTION


def _floor_bucket_datetime(timestamp, period):
    dt = datetime.fromtimestamp(float(timestamp or 0), tz=timezone.utc)
    if period == 'hourly':
        return dt.replace(minute=0, second=0, microsecond=0)
    return dt.replace(hour=0, minute=0, second=0, microsecond=0)


def bucket_key_for_timestamp(timestamp, period):
    dt = _floor_bucket_datetime(timestamp, period)
    return dt.strftime('%Y-%m-%d %H:00') if period == 'hourly' else dt.strftime('%Y-%m-%d')


def _bucket_bounds(bucket_key, period):
    if period == 'hourly':
        start_dt = datetime.strptime(bucket_key, '%Y-%m-%d %H:00').replace(tzinfo=timezone.utc)
        end_dt = start_dt + timedelta(hours=1) - timedelta(seconds=0.000001)
        return (start_dt.timestamp(), end_dt.timestamp())
    start_dt = datetime.strptime(bucket_key, '%Y-%m-%d').replace(tzinfo=timezone.utc)
    end_dt = start_dt + timedelta(days=1) - timedelta(seconds=0.000001)
    return (start_dt.timestamp(), end_dt.timestamp())


def _base_rollup(bucket_key, period, *, window_start, window_end, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    funnel_events = [
        str(item.get('event', '') or '').strip().lower()
        for item in getattr(resolved_runtime, 'ANALYTICS_FUNNEL_STAGES', [])
        if str(item.get('event', '') or '').strip()
    ]
    return {
        'bucket_key': bucket_key,
        'period': period,
        'window_start': float(window_start or 0),
        'window_end': float(window_end or 0),
        'updated_at': float(resolved_runtime.time.time()),
        'purchases': {
            'count': 0,
            'total_revenue_cents': 0,
        },
        'jobs': {
            'total': 0,
            'complete': 0,
            'error': 0,
            'refunded': 0,
            'duration_sum_seconds': 0.0,
            'duration_count': 0,
            'by_mode': {
                mode: {'total': 0, 'complete': 0, 'error': 0}
                for mode in KNOWN_MODES
            },
        },
        'analytics': {
            'event_count': 0,
            'funnel_counts': {event_name: 0 for event_name in funnel_events},
        },
        'rate_limits': {name: 0 for name in KNOWN_RATE_LIMITS},
    }


def _rollup_doc_ref(db, period, bucket_key):
    return db.collection(_collection_for_period(period)).document(bucket_key)


def _empty_rollup(bucket_key, period, runtime=None):
    start_ts, end_ts = _bucket_bounds(bucket_key, period)
    return _base_rollup(bucket_key, period, window_start=start_ts, window_end=end_ts, runtime=runtime)


def _incremented_mode(mode):
    safe_mode = str(mode or '').strip().lower()
    if safe_mode not in {'lecture-notes', 'slides-only', 'interview'}:
        return 'other'
    return safe_mode


def _increment_rollup_doc(period, bucket_key, payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    firestore_module = getattr(resolved_runtime, 'firestore', None)
    if db is None or firestore_module is None:
        return False
    doc_ref = _rollup_doc_ref(db, period, bucket_key)
    window_start, window_end = _bucket_bounds(bucket_key, period)
    increment = firestore_module.Increment
    merge_payload = _base_rollup(bucket_key, period, window_start=window_start, window_end=window_end, runtime=resolved_runtime)
    merge_payload['updated_at'] = float(resolved_runtime.time.time())
    for section, section_payload in (payload or {}).items():
        if not isinstance(section_payload, dict) or section not in merge_payload:
            continue
        for key, value in section_payload.items():
            if isinstance(value, dict) and isinstance(merge_payload[section].get(key), dict):
                for child_key, child_value in value.items():
                    if isinstance(child_value, dict) and isinstance(merge_payload[section][key].get(child_key), dict):
                        nested = {}
                        for grand_key, grand_value in child_value.items():
                            nested[grand_key] = increment(grand_value)
                        merge_payload[section][key][child_key] = nested
                    else:
                        merge_payload[section][key][child_key] = increment(child_value)
            else:
                merge_payload[section][key] = increment(value)
    doc_ref.set(merge_payload, merge=True)
    return True


def increment_purchase_rollups(purchase_payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    payload = purchase_payload if isinstance(purchase_payload, dict) else {}
    created_at = float(payload.get('created_at', resolved_runtime.time.time()) or resolved_runtime.time.time())
    price_cents = int(payload.get('price_cents', 0) or 0)
    increment_payload = {
        'purchases': {
            'count': 1,
            'total_revenue_cents': price_cents,
        }
    }
    for period in ('hourly', 'daily'):
        _increment_rollup_doc(period, bucket_key_for_timestamp(created_at, period), increment_payload, runtime=resolved_runtime)


def increment_job_rollups(job_payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    payload = job_payload if isinstance(job_payload, dict) else {}
    finished_at = float(payload.get('finished_at', resolved_runtime.time.time()) or resolved_runtime.time.time())
    status = str(payload.get('status', '') or '').strip().lower()
    mode = _incremented_mode(payload.get('mode', ''))
    increment_payload = {
        'jobs': {
            'total': 1,
            'complete': 1 if status == 'complete' else 0,
            'error': 1 if status == 'error' else 0,
            'refunded': 1 if bool(payload.get('credit_refunded', False)) else 0,
            'duration_sum_seconds': float(payload.get('duration_seconds', 0) or 0),
            'duration_count': 1 if isinstance(payload.get('duration_seconds'), (int, float)) else 0,
            'by_mode': {
                mode: {
                    'total': 1,
                    'complete': 1 if status == 'complete' else 0,
                    'error': 1 if status == 'error' else 0,
                }
            },
        }
    }
    for period in ('hourly', 'daily'):
        _increment_rollup_doc(period, bucket_key_for_timestamp(finished_at, period), increment_payload, runtime=resolved_runtime)


def increment_analytics_rollups(event_payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    payload = event_payload if isinstance(event_payload, dict) else {}
    created_at = float(payload.get('created_at', resolved_runtime.time.time()) or resolved_runtime.time.time())
    event_name = str(payload.get('event', '') or '').strip().lower()
    increment_payload = {
        'analytics': {
            'event_count': 1,
            'funnel_counts': {event_name: 1} if event_name else {},
        }
    }
    for period in ('hourly', 'daily'):
        _increment_rollup_doc(period, bucket_key_for_timestamp(created_at, period), increment_payload, runtime=resolved_runtime)


def increment_rate_limit_rollups(entry_payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    payload = entry_payload if isinstance(entry_payload, dict) else {}
    created_at = float(payload.get('created_at', resolved_runtime.time.time()) or resolved_runtime.time.time())
    limit_name = str(payload.get('limit_name', '') or '').strip().lower()
    if limit_name not in KNOWN_RATE_LIMITS:
        return
    increment_payload = {
        'rate_limits': {limit_name: 1},
    }
    for period in ('hourly', 'daily'):
        _increment_rollup_doc(period, bucket_key_for_timestamp(created_at, period), increment_payload, runtime=resolved_runtime)


def _aggregate_bucket_from_source(bucket_key, period, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    start_ts, end_ts = _bucket_bounds(bucket_key, period)
    aggregate = _empty_rollup(bucket_key, period, runtime=resolved_runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None:
        return aggregate
    purchases_docs = resolved_runtime.admin_repo.query_docs_in_window(
        db,
        collection_name='purchases',
        timestamp_field='created_at',
        window_start=start_ts,
        window_end=end_ts,
        firestore_module=resolved_runtime.firestore,
    )
    for doc in purchases_docs:
        purchase = doc.to_dict() or {}
        aggregate['purchases']['count'] += 1
        aggregate['purchases']['total_revenue_cents'] += int(purchase.get('price_cents', 0) or 0)

    jobs_docs = resolved_runtime.admin_repo.query_docs_in_window(
        db,
        collection_name='job_logs',
        timestamp_field='finished_at',
        window_start=start_ts,
        window_end=end_ts,
        firestore_module=resolved_runtime.firestore,
        filters=[('admin_visible', '==', True)],
    )
    for doc in jobs_docs:
        job = doc.to_dict() or {}
        mode = _incremented_mode(job.get('mode', ''))
        status = str(job.get('status', '') or '').strip().lower()
        aggregate['jobs']['total'] += 1
        aggregate['jobs']['by_mode'][mode]['total'] += 1
        if status == 'complete':
            aggregate['jobs']['complete'] += 1
            aggregate['jobs']['by_mode'][mode]['complete'] += 1
        elif status == 'error':
            aggregate['jobs']['error'] += 1
            aggregate['jobs']['by_mode'][mode]['error'] += 1
        if bool(job.get('credit_refunded', False)):
            aggregate['jobs']['refunded'] += 1
        duration = job.get('duration_seconds')
        if isinstance(duration, (int, float)):
            aggregate['jobs']['duration_sum_seconds'] += float(duration)
            aggregate['jobs']['duration_count'] += 1

    analytics_docs = resolved_runtime.admin_repo.query_docs_in_window(
        db,
        collection_name='analytics_events',
        timestamp_field='created_at',
        window_start=start_ts,
        window_end=end_ts,
        firestore_module=resolved_runtime.firestore,
    )
    funnel_counts = aggregate['analytics']['funnel_counts']
    for doc in analytics_docs:
        analytics = doc.to_dict() or {}
        event_name = str(analytics.get('event', '') or '').strip().lower()
        aggregate['analytics']['event_count'] += 1
        if event_name in funnel_counts:
            funnel_counts[event_name] += 1

    rate_limit_docs = resolved_runtime.admin_repo.query_docs_in_window(
        db,
        collection_name='rate_limit_logs',
        timestamp_field='created_at',
        window_start=start_ts,
        window_end=end_ts,
        firestore_module=resolved_runtime.firestore,
    )
    for doc in rate_limit_docs:
        entry = doc.to_dict() or {}
        limit_name = str(entry.get('limit_name', '') or '').strip().lower()
        if limit_name in aggregate['rate_limits']:
            aggregate['rate_limits'][limit_name] += 1
    return aggregate


def get_or_build_rollup(bucket_key, period, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    db = getattr(resolved_runtime, 'db', None)
    if db is None:
        return _empty_rollup(bucket_key, period, runtime=resolved_runtime)
    doc = _rollup_doc_ref(db, period, bucket_key).get()
    if getattr(doc, 'exists', False):
        payload = doc.to_dict() or {}
        payload.setdefault('bucket_key', bucket_key)
        payload.setdefault('period', period)
        return payload
    payload = _aggregate_bucket_from_source(bucket_key, period, runtime=resolved_runtime)
    _rollup_doc_ref(db, period, bucket_key).set(payload, merge=False)
    return payload


def load_window_rollups(window_key, now_ts, runtime=None):
    from lecture_processor.domains.admin import metrics as admin_metrics

    resolved_runtime = _resolve_runtime(runtime)
    _labels, bucket_keys, _granularity = admin_metrics.build_time_buckets(window_key, now_ts, runtime=resolved_runtime)
    period = _bucket_period_for_window(window_key)
    return [get_or_build_rollup(bucket_key, period, runtime=resolved_runtime) for bucket_key in bucket_keys]
