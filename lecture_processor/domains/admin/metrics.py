import json
from datetime import datetime, timedelta, timezone

from flask import g

from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def infer_stripe_key_mode(key_value, runtime=None):
    key = str(key_value or '').strip()
    if not key:
        return 'missing'
    if key.startswith('sk_live_') or key.startswith('pk_live_'):
        return 'live'
    if key.startswith('sk_test_') or key.startswith('pk_test_'):
        return 'test'
    return 'unknown'


def build_admin_deployment_info(request_host='', runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    request_host = str(request_host or '').strip()
    request_hostname = request_host.split(':', 1)[0].strip().lower()
    render_hostname = str(resolved_runtime.os.getenv('RENDER_EXTERNAL_HOSTNAME', '') or '').strip().lower()
    render_external_url = str(resolved_runtime.os.getenv('RENDER_EXTERNAL_URL', '') or '').strip()
    render_service_id = str(resolved_runtime.os.getenv('RENDER_SERVICE_ID', '') or '').strip()
    render_deploy_id = str(resolved_runtime.os.getenv('RENDER_DEPLOY_ID', '') or '').strip()
    render_instance_id = str(resolved_runtime.os.getenv('RENDER_INSTANCE_ID', '') or '').strip()
    render_service_name = str(resolved_runtime.os.getenv('RENDER_SERVICE_NAME', '') or '').strip()
    render_git_commit = str(resolved_runtime.os.getenv('RENDER_GIT_COMMIT', '') or '').strip()
    render_git_branch = str(resolved_runtime.os.getenv('RENDER_GIT_BRANCH', '') or '').strip()
    render_detected = bool(str(resolved_runtime.os.getenv('RENDER', '') or '').strip() or render_service_id or render_deploy_id)
    host_matches_render = None
    if render_hostname and request_hostname:
        host_matches_render = request_hostname == render_hostname
    return {
        'runtime': 'render' if render_detected else 'local',
        'request_host': request_host,
        'request_hostname': request_hostname,
        'render_external_hostname': render_hostname,
        'render_external_url': render_external_url,
        'host_matches_render': host_matches_render,
        'service_id': render_service_id,
        'service_name': render_service_name,
        'deploy_id': render_deploy_id,
        'instance_id': render_instance_id,
        'git_branch': render_git_branch,
        'git_commit': render_git_commit,
        'git_commit_short': render_git_commit[:12] if render_git_commit else '',
        'app_boot_ts': resolved_runtime.APP_BOOT_TS,
        'app_uptime_seconds': max(0, round(resolved_runtime.time.time() - resolved_runtime.APP_BOOT_TS, 1)),
    }


def build_admin_runtime_checks(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    secret_key_mode = infer_stripe_key_mode(resolved_runtime.stripe.api_key, runtime=resolved_runtime)
    publishable_key_mode = infer_stripe_key_mode(resolved_runtime.STRIPE_PUBLISHABLE_KEY, runtime=resolved_runtime)
    webhook_configured = bool(str(resolved_runtime.STRIPE_WEBHOOK_SECRET or '').strip())
    stripe_keys_match = (
        secret_key_mode in {'live', 'test'}
        and publishable_key_mode in {'live', 'test'}
        and (secret_key_mode == publishable_key_mode)
    )
    soffice_available = bool(resolved_runtime.get_soffice_binary())
    ffmpeg_available = bool(resolved_runtime.get_ffmpeg_binary())
    ytdlp_available = bool(resolved_runtime.shutil.which('yt-dlp'))
    return {
        'firebase_ready': bool(resolved_runtime.db),
        'gemini_ready': bool(resolved_runtime.client),
        'stripe_secret_mode': secret_key_mode,
        'stripe_publishable_mode': publishable_key_mode,
        'stripe_keys_match': stripe_keys_match,
        'stripe_webhook_configured': webhook_configured,
        'pptx_conversion_available': soffice_available,
        'video_import_available': ffmpeg_available and ytdlp_available,
        'ffmpeg_available': ffmpeg_available,
        'yt_dlp_available': ytdlp_available,
    }


def get_admin_window(window_key, runtime=None):
    windows = {'24h': 24 * 60 * 60, '7d': 7 * 24 * 60 * 60, '30d': 30 * 24 * 60 * 60}
    safe_key = window_key if window_key in windows else '7d'
    return (safe_key, windows[safe_key])


def get_timestamp(value, runtime=None):
    return value if isinstance(value, (int, float)) else 0


def build_time_buckets(window_key, now_ts, runtime=None):
    labels = []
    keys = []
    if window_key == '24h':
        now_dt = datetime.fromtimestamp(now_ts, tz=timezone.utc).replace(minute=0, second=0, microsecond=0)
        start_dt = now_dt - timedelta(hours=23)
        for i in range(24):
            current = start_dt + timedelta(hours=i)
            labels.append(current.strftime('%H:%M'))
            keys.append(current.strftime('%Y-%m-%d %H:00'))
        granularity = 'hour'
    else:
        days = 7 if window_key == '7d' else 30
        now_dt = datetime.fromtimestamp(now_ts, tz=timezone.utc).replace(hour=0, minute=0, second=0, microsecond=0)
        start_dt = now_dt - timedelta(days=days - 1)
        for i in range(days):
            current = start_dt + timedelta(days=i)
            labels.append(current.strftime('%d %b'))
            keys.append(current.strftime('%Y-%m-%d'))
        granularity = 'day'
    return (labels, keys, granularity)


def get_bucket_key(timestamp, window_key, runtime=None):
    dt = datetime.fromtimestamp(timestamp, tz=timezone.utc)
    if window_key == '24h':
        return dt.replace(minute=0, second=0, microsecond=0).strftime('%Y-%m-%d %H:00')
    return dt.replace(hour=0, minute=0, second=0, microsecond=0).strftime('%Y-%m-%d')


def query_docs_in_window(collection_name, timestamp_field, window_start, window_end=None, order_desc=False, limit=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return resolved_runtime.admin_repo.query_docs_in_window(
        resolved_runtime.db,
        collection_name=collection_name,
        timestamp_field=timestamp_field,
        window_start=window_start,
        window_end=window_end,
        order_desc=order_desc,
        limit=limit,
        firestore_module=resolved_runtime.firestore,
    )


def mark_admin_data_warning(collection_name, reason, runtime=None):
    safe_collection = str(collection_name or '').strip().lower() or 'unknown'
    safe_reason = str(reason or '').strip().lower() or 'unknown'
    try:
        existing = getattr(g, 'admin_data_warnings', [])
        if not isinstance(existing, list):
            existing = []
        warning_key = f'{safe_collection}:{safe_reason}'
        if warning_key not in existing:
            existing.append(warning_key)
        g.admin_data_warnings = existing
    except RuntimeError:
        return


def get_admin_data_warnings(runtime=None):
    try:
        warnings_list = getattr(g, 'admin_data_warnings', [])
    except RuntimeError:
        return []
    if not isinstance(warnings_list, list):
        return []
    return [str(entry) for entry in warnings_list if str(entry or '').strip()]


def safe_query_docs_in_window(collection_name, timestamp_field, window_start, window_end=None, order_desc=False, limit=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if resolved_runtime.db is None:
        return []
    try:
        return query_docs_in_window(
            collection_name=collection_name,
            timestamp_field=timestamp_field,
            window_start=window_start,
            window_end=window_end,
            order_desc=order_desc,
            limit=limit,
            runtime=resolved_runtime,
        )
    except Exception:
        resolved_runtime.logger.warning(
            'Admin query failed for %s (%s); returning empty partial dataset.',
            collection_name,
            timestamp_field,
            exc_info=True,
        )
        mark_admin_data_warning(collection_name, 'query_failed', runtime=resolved_runtime)
        return []


def safe_count_collection(collection_name, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if resolved_runtime.db is None:
        return 0
    try:
        return resolved_runtime.admin_repo.count_collection(resolved_runtime.db, collection_name)
    except Exception:
        resolved_runtime.logger.warning(
            'Admin count query failed for %s; returning 0 partial dataset.',
            collection_name,
            exc_info=True,
        )
        mark_admin_data_warning(collection_name, 'count_failed', runtime=resolved_runtime)
        return 0


def safe_count_window(collection_name, timestamp_field, window_start, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if resolved_runtime.db is None:
        return 0
    try:
        return resolved_runtime.admin_repo.count_window(
            resolved_runtime.db,
            collection_name,
            timestamp_field,
            window_start,
        )
    except Exception:
        resolved_runtime.logger.warning(
            'Admin window count query failed for %s (%s); returning 0 partial dataset.',
            collection_name,
            timestamp_field,
            exc_info=True,
        )
        mark_admin_data_warning(collection_name, 'window_count_failed', runtime=resolved_runtime)
        return 0


def build_admin_funnel_steps(analytics_docs, window_start, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    funnel_actor_sets = {stage['event']: set() for stage in resolved_runtime.ANALYTICS_FUNNEL_STAGES}
    analytics_event_count = 0
    for doc in analytics_docs:
        event = doc.to_dict() or {}
        created_at = get_timestamp(event.get('created_at'), runtime=resolved_runtime)
        if created_at < window_start:
            continue
        event_name = analytics_events.sanitize_analytics_event_name(event.get('event', ''), runtime=resolved_runtime)
        if not event_name:
            continue
        analytics_event_count += 1
        if event_name not in funnel_actor_sets:
            continue
        uid = str(event.get('uid', '') or '').strip()
        session_id = analytics_events.sanitize_analytics_session_id(event.get('session_id', ''), runtime=resolved_runtime)
        actor_id = uid or session_id or f'doc:{doc.id}'
        funnel_actor_sets[event_name].add(actor_id)
    funnel_steps = []
    previous_count = 0
    for idx, stage in enumerate(resolved_runtime.ANALYTICS_FUNNEL_STAGES):
        count = len(funnel_actor_sets.get(stage['event'], set()))
        if idx == 0:
            conversion = 100.0 if count > 0 else 0.0
        elif previous_count > 0:
            conversion = round(min(count / previous_count * 100.0, 100.0), 1)
        else:
            conversion = 0.0
        funnel_steps.append({
            'event': stage['event'],
            'label': stage['label'],
            'count': count,
            'conversion_from_prev': conversion,
        })
        previous_count = count
    return (funnel_steps, analytics_event_count)


def build_admin_funnel_daily_rows(analytics_docs, window_start, window_key, now_ts, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    _labels, bucket_keys, granularity = build_time_buckets(window_key, now_ts, runtime=resolved_runtime)
    counts_by_bucket = {}
    for doc in analytics_docs:
        event = doc.to_dict() or {}
        created_at = get_timestamp(event.get('created_at'), runtime=resolved_runtime)
        if created_at < window_start or created_at > now_ts:
            continue
        event_name = analytics_events.sanitize_analytics_event_name(event.get('event', ''), runtime=resolved_runtime)
        if event_name not in resolved_runtime.ANALYTICS_FUNNEL_EVENT_NAMES:
            continue
        bucket_key = get_bucket_key(created_at, window_key, runtime=resolved_runtime)
        if bucket_key not in counts_by_bucket:
            counts_by_bucket[bucket_key] = {}
        if event_name not in counts_by_bucket[bucket_key]:
            counts_by_bucket[bucket_key][event_name] = {'event_count': 0, 'actors': set()}
        uid = str(event.get('uid', '') or '').strip()
        session_id = analytics_events.sanitize_analytics_session_id(event.get('session_id', ''), runtime=resolved_runtime)
        actor_id = uid or session_id or f'doc:{doc.id}'
        counts_by_bucket[bucket_key][event_name]['event_count'] += 1
        counts_by_bucket[bucket_key][event_name]['actors'].add(actor_id)

    rows = []
    for bucket_key in bucket_keys:
        stage_counts = counts_by_bucket.get(bucket_key, {})
        prev_unique = 0
        for idx, stage in enumerate(resolved_runtime.ANALYTICS_FUNNEL_STAGES):
            stage_data = stage_counts.get(stage['event'], {'event_count': 0, 'actors': set()})
            unique_actor_count = len(stage_data.get('actors', set()))
            event_count = int(stage_data.get('event_count', 0) or 0)
            if idx == 0:
                conversion = 100.0 if unique_actor_count > 0 else 0.0
            elif prev_unique > 0:
                conversion = round(min(unique_actor_count / prev_unique * 100.0, 100.0), 1)
            else:
                conversion = 0.0
            rows.append({
                'bucket_key': bucket_key,
                'granularity': granularity,
                'event': stage['event'],
                'label': stage['label'],
                'unique_actor_count': unique_actor_count,
                'event_count': event_count,
                'conversion_from_prev': conversion,
            })
            prev_unique = unique_actor_count
    return (rows, granularity)


def get_model_pricing_config(force_reload=False, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    now_ts = resolved_runtime.time.time()
    cached = resolved_runtime.MODEL_PRICING_CACHE.get('payload')
    loaded_at = float(resolved_runtime.MODEL_PRICING_CACHE.get('loaded_at', 0.0) or 0.0)
    if not force_reload and isinstance(cached, dict) and cached and (now_ts - loaded_at < resolved_runtime.MODEL_PRICING_CACHE_TTL_SECONDS):
        return json.loads(json.dumps(cached))
    with open(resolved_runtime.MODEL_PRICING_CONFIG_PATH, 'r', encoding='utf-8') as handle:
        payload = json.load(handle)
    if not isinstance(payload, dict):
        raise ValueError(f"Model pricing config must be a JSON object: {resolved_runtime.MODEL_PRICING_CONFIG_PATH}")
    resolved_runtime.MODEL_PRICING_CACHE['payload'] = payload
    resolved_runtime.MODEL_PRICING_CACHE['loaded_at'] = now_ts
    return json.loads(json.dumps(payload))


def coerce_analysis_period(period_key, runtime=None):
    _ = runtime
    normalized = str(period_key or '').strip().lower()
    if normalized in {'daily', 'day', 'd'}:
        return 'daily'
    if normalized in {'weekly', 'week', 'w'}:
        return 'weekly'
    if normalized in {'monthly', 'month', 'm'}:
        return 'monthly'
    if normalized in {'quarterly', 'quarter', 'q'}:
        return 'quarterly'
    return 'monthly'


def resolve_period_window(period_key, now_ts=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    safe_period = coerce_analysis_period(period_key, runtime=resolved_runtime)
    now_ts_value = float(now_ts if isinstance(now_ts, (int, float)) else resolved_runtime.time.time())
    now_dt = datetime.fromtimestamp(now_ts_value, tz=timezone.utc)
    end_dt = now_dt.replace(microsecond=0)

    if safe_period == 'daily':
        start_dt = end_dt.replace(hour=0, minute=0, second=0)
    elif safe_period == 'weekly':
        start_of_day = end_dt.replace(hour=0, minute=0, second=0)
        start_dt = start_of_day - timedelta(days=start_of_day.weekday())
    elif safe_period == 'quarterly':
        quarter_month = ((end_dt.month - 1) // 3) * 3 + 1
        start_dt = end_dt.replace(month=quarter_month, day=1, hour=0, minute=0, second=0)
    else:
        start_dt = end_dt.replace(day=1, hour=0, minute=0, second=0)

    return {
        'period': safe_period,
        'start': start_dt.timestamp(),
        'end': end_dt.timestamp(),
    }


def _get_pricing_table(config_payload):
    payload = config_payload if isinstance(config_payload, dict) else {}
    table = payload.get('pricing_table')
    if isinstance(table, dict):
        return table
    # Backwards compatibility: fall back to the legacy flat "models" structure.
    models = payload.get('models')
    if not isinstance(models, dict):
        return {}
    fallback = {}
    for model_id, rates in models.items():
        if not isinstance(rates, dict):
            continue
        fallback[model_id] = {
            'standard': {
                'input_text_per_M': float(rates.get('input_text_per_M', 0) or 0),
                'input_audio_per_M': (
                    None if rates.get('input_audio_per_M') is None else float(rates.get('input_audio_per_M', 0) or 0)
                ),
                'output_per_M': float(rates.get('output_per_M', 0) or 0),
            }
        }
    return fallback


def _as_non_negative_int(value):
    try:
        return max(0, int(value or 0))
    except Exception:
        return 0


def _as_non_negative_float(value, default=0.0):
    try:
        parsed = float(value)
    except Exception:
        parsed = float(default)
    if parsed < 0:
        return 0.0
    return parsed


def resolve_stage_pricing(
    config_payload,
    model_id,
    billing_mode='standard',
    input_modality='text',
    input_tokens=0,
    runtime=None,
):
    _ = runtime
    safe_model = str(model_id or '').strip()
    safe_billing_mode = str(billing_mode or 'standard').strip().lower() or 'standard'
    safe_input_modality = str(input_modality or 'text').strip().lower() or 'text'
    safe_input_tokens = _as_non_negative_int(input_tokens)

    pricing_table = _get_pricing_table(config_payload)
    model_entry = pricing_table.get(safe_model)
    if not isinstance(model_entry, dict):
        return {
            'model': safe_model,
            'billing_mode': safe_billing_mode,
            'input_modality': safe_input_modality,
            'matched': False,
            'tier': '',
            'input_rate_per_million': 0.0,
            'output_rate_per_million': 0.0,
        }

    billing_entry = model_entry.get(safe_billing_mode)
    if not isinstance(billing_entry, dict):
        # Fallback to standard if a model has no explicit batch table.
        billing_entry = model_entry.get('standard')
    if not isinstance(billing_entry, dict):
        return {
            'model': safe_model,
            'billing_mode': safe_billing_mode,
            'input_modality': safe_input_modality,
            'matched': False,
            'tier': '',
            'input_rate_per_million': 0.0,
            'output_rate_per_million': 0.0,
        }

    tier_label = ''
    rates = billing_entry
    tiers = billing_entry.get('tiers')
    if isinstance(tiers, list) and tiers:
        selected = None
        for tier in tiers:
            if not isinstance(tier, dict):
                continue
            max_tokens = tier.get('max_input_tokens')
            min_tokens = tier.get('min_input_tokens')
            if max_tokens is not None and safe_input_tokens > _as_non_negative_int(max_tokens):
                continue
            if min_tokens is not None and safe_input_tokens < _as_non_negative_int(min_tokens):
                continue
            selected = tier
            break
        if selected is None:
            selected = tiers[-1] if isinstance(tiers[-1], dict) else {}
        rates = selected if isinstance(selected, dict) else {}
        tier_label = str(rates.get('label', '') or '').strip()

    input_text_rate = _as_non_negative_float(rates.get('input_text_per_M', 0.0), default=0.0)
    input_audio_rate = rates.get('input_audio_per_M')
    output_rate = _as_non_negative_float(rates.get('output_per_M', 0.0), default=0.0)
    if input_audio_rate is None:
        input_audio_rate = input_text_rate
    else:
        input_audio_rate = _as_non_negative_float(input_audio_rate, default=input_text_rate)

    input_rate = input_audio_rate if safe_input_modality == 'audio' else input_text_rate
    return {
        'model': safe_model,
        'billing_mode': safe_billing_mode,
        'input_modality': safe_input_modality,
        'matched': True,
        'tier': tier_label,
        'input_rate_per_million': input_rate,
        'output_rate_per_million': output_rate,
    }


def compute_job_stage_costs(job_payload, config_payload, runtime=None):
    _ = runtime
    job = job_payload if isinstance(job_payload, dict) else {}
    billing_mode = str(job.get('billing_mode', 'standard') or 'standard').strip().lower() or 'standard'
    stage_usage = job.get('token_usage_by_stage')
    if not isinstance(stage_usage, dict) or not stage_usage:
        return {
            'stages': [],
            'input_tokens': _as_non_negative_int(job.get('token_input_total', 0)),
            'output_tokens': _as_non_negative_int(job.get('token_output_total', 0)),
            'total_tokens': _as_non_negative_int(job.get('token_total', 0)),
            'cost_usd': 0.0,
            'missing_stage_usage': True,
        }

    stages = []
    input_total = 0
    output_total = 0
    total_total = 0
    cost_total = 0.0
    for stage_name, usage in stage_usage.items():
        safe_usage = usage if isinstance(usage, dict) else {}
        input_tokens = _as_non_negative_int(safe_usage.get('input_tokens', 0))
        output_tokens = _as_non_negative_int(safe_usage.get('output_tokens', 0))
        total_tokens = _as_non_negative_int(safe_usage.get('total_tokens', input_tokens + output_tokens))
        model_id = str(safe_usage.get('model') or '').strip()
        stage_billing_mode = str(safe_usage.get('billing_mode') or billing_mode).strip().lower() or billing_mode
        input_modality = str(safe_usage.get('input_modality') or 'text').strip().lower() or 'text'
        pricing = resolve_stage_pricing(
            config_payload,
            model_id,
            billing_mode=stage_billing_mode,
            input_modality=input_modality,
            input_tokens=input_tokens,
        )
        input_cost = (input_tokens / 1_000_000.0) * _as_non_negative_float(pricing.get('input_rate_per_million', 0.0))
        output_cost = (output_tokens / 1_000_000.0) * _as_non_negative_float(pricing.get('output_rate_per_million', 0.0))
        stage_cost = input_cost + output_cost

        stages.append(
            {
                'stage': str(stage_name or ''),
                'model': model_id,
                'billing_mode': stage_billing_mode,
                'input_modality': input_modality,
                'input_tokens': input_tokens,
                'output_tokens': output_tokens,
                'total_tokens': total_tokens,
                'input_rate_per_million': _as_non_negative_float(pricing.get('input_rate_per_million', 0.0)),
                'output_rate_per_million': _as_non_negative_float(pricing.get('output_rate_per_million', 0.0)),
                'tier': str(pricing.get('tier', '') or ''),
                'cost_input_usd': input_cost,
                'cost_output_usd': output_cost,
                'cost_usd': stage_cost,
                'matched_pricing': bool(pricing.get('matched', False)),
            }
        )
        input_total += input_tokens
        output_total += output_tokens
        total_total += total_tokens
        cost_total += stage_cost

    return {
        'stages': stages,
        'input_tokens': input_total,
        'output_tokens': output_total,
        'total_tokens': total_total,
        'cost_usd': cost_total,
        'missing_stage_usage': False,
    }
