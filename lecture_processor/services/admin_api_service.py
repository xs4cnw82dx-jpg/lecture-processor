"""Business logic handlers for admin APIs."""

from datetime import datetime, timezone

try:
    from openpyxl import Workbook
except Exception:
    Workbook = None

from lecture_processor.domains.admin import metrics as admin_metrics
from lecture_processor.domains.ai import batch_orchestrator


def sanitize_csv_cell(value):
    if value is None:
        return ''
    if isinstance(value, (int, float, bool)):
        return value
    text = str(value)
    if text and text[0] in {'=', '+', '-', '@', '\t', '\r', '\n'}:
        return "'" + text
    return text


def sanitize_csv_row(values):
    return [sanitize_csv_cell(value) for value in (values or [])]


def sanitize_excel_cell(value):
    return sanitize_csv_cell(value)


def _require_admin(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return None, app_ctx.jsonify({'error': 'Unauthorized'}), 401
    if not app_ctx.is_admin_user(decoded_token):
        return None, app_ctx.jsonify({'error': 'Forbidden'}), 403
    return decoded_token, None, None


def _to_non_negative_float(value, default=0.0):
    try:
        parsed = float(value)
    except Exception:
        parsed = float(default)
    if parsed < 0:
        return 0.0
    return parsed


def _to_non_negative_int(value, default=0):
    try:
        parsed = int(value)
    except Exception:
        parsed = int(default)
    if parsed < 0:
        return 0
    return parsed


def _coerce_usd_to_eur(payload):
    raw_usd_to_eur = payload.get('usd_to_eur')
    raw_eur_usd = payload.get('eur_usd')
    if raw_usd_to_eur not in (None, ''):
        value = _to_non_negative_float(raw_usd_to_eur, default=0.0)
        if value > 0:
            return value
    if raw_eur_usd not in (None, ''):
        eur_usd = _to_non_negative_float(raw_eur_usd, default=0.0)
        if eur_usd > 0:
            return 1.0 / eur_usd
    return 0.93


def _normalize_analysis_filters(payload, runtime=None):
    _ = runtime
    data = payload if isinstance(payload, dict) else {}
    mode = str(data.get('mode', '') or '').strip()
    status = str(data.get('status', '') or '').strip()
    uid = str(data.get('uid', '') or '').strip()
    email = str(data.get('email', '') or '').strip().lower()
    period = admin_metrics.coerce_analysis_period(data.get('period', data.get('window', 'monthly')))
    selected_ids = data.get('job_ids', data.get('selected_job_ids', []))
    if not isinstance(selected_ids, list):
        selected_ids = []
    selected_ids = [str(item or '').strip() for item in selected_ids if str(item or '').strip()]
    return {
        'period': period,
        'mode': mode,
        'status': status,
        'uid': uid,
        'email': email,
        'selection': str(data.get('selection', 'all') or 'all').strip().lower(),
        'job_ids': selected_ids,
        'single_job_id': str(data.get('job_id', '') or '').strip(),
        'usd_to_eur': _coerce_usd_to_eur(data),
    }


def _job_matches_filters(job, normalized_filters):
    mode = normalized_filters.get('mode', '')
    status = normalized_filters.get('status', '')
    uid = normalized_filters.get('uid', '')
    email = normalized_filters.get('email', '')
    if mode and str(job.get('mode', '') or '').strip() != mode:
        return False
    if status and str(job.get('status', '') or '').strip() != status:
        return False
    if uid and str(job.get('uid', '') or '').strip() != uid:
        return False
    if email and str(job.get('email', '') or '').strip().lower() != email:
        return False
    return True


def _select_jobs(filtered_jobs, normalized_filters):
    selected_ids = set(normalized_filters.get('job_ids', []) or [])
    selection = normalized_filters.get('selection', 'all')
    if selected_ids:
        return [job for job in filtered_jobs if str(job.get('job_id', '') or '') in selected_ids]
    if selection == 'one':
        one_job_id = normalized_filters.get('single_job_id', '')
        if not one_job_id:
            return []
        return [job for job in filtered_jobs if str(job.get('job_id', '') or '') == one_job_id]
    return list(filtered_jobs)


def _build_cost_analysis_payload(app_ctx, normalized_filters):
    now_ts = app_ctx.time.time()
    window = admin_metrics.resolve_period_window(normalized_filters.get('period', 'monthly'), now_ts=now_ts, runtime=app_ctx)
    pricing = admin_metrics.get_model_pricing_config(runtime=app_ctx)

    docs = admin_metrics.safe_query_docs_in_window(
        collection_name='job_logs',
        timestamp_field='finished_at',
        window_start=window['start'],
        window_end=window['end'],
        order_desc=True,
        runtime=app_ctx,
    )
    filtered_jobs = []
    for doc in docs:
        job = doc.to_dict() or {}
        job_id = str(job.get('job_id', doc.id) or doc.id)
        if not job_id:
            continue
        job['job_id'] = job_id
        if _job_matches_filters(job, normalized_filters):
            filtered_jobs.append(job)

    selected_jobs = _select_jobs(filtered_jobs, normalized_filters)
    usd_to_eur = _to_non_negative_float(normalized_filters.get('usd_to_eur', 0.93), default=0.93) or 0.93

    job_rows = []
    stage_rows = []
    sum_input_tokens = 0
    sum_output_tokens = 0
    sum_total_tokens = 0
    sum_cost_usd = 0.0

    for job in selected_jobs:
        cost_info = admin_metrics.compute_job_stage_costs(job, pricing, runtime=app_ctx)
        job_input = _to_non_negative_int(cost_info.get('input_tokens', 0))
        job_output = _to_non_negative_int(cost_info.get('output_tokens', 0))
        job_total = _to_non_negative_int(cost_info.get('total_tokens', 0))
        job_cost_usd = float(cost_info.get('cost_usd', 0.0) or 0.0)
        job_cost_eur = job_cost_usd * usd_to_eur
        job_row = {
            'job_id': str(job.get('job_id', '') or ''),
            'uid': str(job.get('uid', '') or ''),
            'email': str(job.get('email', '') or ''),
            'mode': str(job.get('mode', '') or ''),
            'status': str(job.get('status', '') or ''),
            'finished_at': job.get('finished_at', 0),
            'billing_mode': str(job.get('billing_mode', 'standard') or 'standard'),
            'is_batch': bool(job.get('is_batch', False)),
            'batch_parent_id': str(job.get('batch_parent_id', '') or ''),
            'batch_row_id': str(job.get('batch_row_id', '') or ''),
            'token_input_total': job_input,
            'token_output_total': job_output,
            'token_total': job_total,
            'cost_usd': round(job_cost_usd, 8),
            'cost_eur': round(job_cost_eur, 8),
            'missing_stage_usage': bool(cost_info.get('missing_stage_usage', False)),
        }
        job_rows.append(job_row)

        for stage in cost_info.get('stages', []) or []:
            stage_rows.append(
                {
                    'job_id': job_row['job_id'],
                    'stage': str(stage.get('stage', '') or ''),
                    'model': str(stage.get('model', '') or ''),
                    'tier': str(stage.get('tier', '') or ''),
                    'billing_mode': str(stage.get('billing_mode', '') or ''),
                    'input_modality': str(stage.get('input_modality', '') or ''),
                    'input_tokens': _to_non_negative_int(stage.get('input_tokens', 0)),
                    'output_tokens': _to_non_negative_int(stage.get('output_tokens', 0)),
                    'total_tokens': _to_non_negative_int(stage.get('total_tokens', 0)),
                    'input_rate_per_million': float(stage.get('input_rate_per_million', 0.0) or 0.0),
                    'output_rate_per_million': float(stage.get('output_rate_per_million', 0.0) or 0.0),
                    'cost_input_usd': float(stage.get('cost_input_usd', 0.0) or 0.0),
                    'cost_output_usd': float(stage.get('cost_output_usd', 0.0) or 0.0),
                    'cost_usd': float(stage.get('cost_usd', 0.0) or 0.0),
                    'cost_eur': float(stage.get('cost_usd', 0.0) or 0.0) * usd_to_eur,
                    'matched_pricing': bool(stage.get('matched_pricing', False)),
                }
            )

        sum_input_tokens += job_input
        sum_output_tokens += job_output
        sum_total_tokens += job_total
        sum_cost_usd += job_cost_usd

    return {
        'filters': {
            'period': window['period'],
            'window_start': window['start'],
            'window_end': window['end'],
            'mode': normalized_filters.get('mode', ''),
            'status': normalized_filters.get('status', ''),
            'uid': normalized_filters.get('uid', ''),
            'email': normalized_filters.get('email', ''),
            'selection': normalized_filters.get('selection', 'all'),
            'selected_job_ids': list(normalized_filters.get('job_ids', []) or []),
        },
        'pricing_version': str((pricing or {}).get('version', '') or ''),
        'usd_to_eur': usd_to_eur,
        'summary': {
            'jobs_filtered': len(filtered_jobs),
            'jobs_selected': len(selected_jobs),
            'token_input_total': sum_input_tokens,
            'token_output_total': sum_output_tokens,
            'token_total': sum_total_tokens,
            'cost_usd_total': round(sum_cost_usd, 8),
            'cost_eur_total': round(sum_cost_usd * usd_to_eur, 8),
        },
        'jobs': job_rows,
        'stages': stage_rows,
    }


def admin_overview(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    if not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403

    try:
        window_key, window_seconds = admin_metrics.get_admin_window(
            request.args.get('window', '7d'),
            runtime=app_ctx,
        )
        now_ts = app_ctx.time.time()
        window_start = now_ts - window_seconds

        total_users = admin_metrics.safe_count_collection('users', runtime=app_ctx)
        new_users = admin_metrics.safe_count_window('users', 'created_at', window_start, runtime=app_ctx)
        total_processed = admin_metrics.safe_count_collection('job_logs', runtime=app_ctx)

        filtered_purchases_docs = admin_metrics.safe_query_docs_in_window(
            collection_name='purchases',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
            runtime=app_ctx,
        )
        filtered_jobs_docs = admin_metrics.safe_query_docs_in_window(
            collection_name='job_logs',
            timestamp_field='finished_at',
            window_start=window_start,
            window_end=now_ts,
            runtime=app_ctx,
        )
        filtered_analytics_docs = admin_metrics.safe_query_docs_in_window(
            collection_name='analytics_events',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
            runtime=app_ctx,
        )
        filtered_rate_limit_docs = admin_metrics.safe_query_docs_in_window(
            collection_name='rate_limit_logs',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
            runtime=app_ctx,
        )

        total_revenue_cents = 0
        purchase_count = 0
        filtered_purchases = []
        for doc in filtered_purchases_docs:
            purchase = doc.to_dict() or {}
            filtered_purchases.append(purchase)
            purchase_count += 1
            total_revenue_cents += purchase.get('price_cents', 0) or 0

        job_count = 0
        success_jobs = 0
        failed_jobs = 0
        refunded_jobs = 0
        durations = []
        filtered_jobs = []
        for doc in filtered_jobs_docs:
            job = doc.to_dict() or {}
            filtered_jobs.append(job)
            job_count += 1
            status = job.get('status', '')
            if status == 'complete':
                success_jobs += 1
            elif status == 'error':
                failed_jobs += 1
            if job.get('credit_refunded'):
                refunded_jobs += 1
            duration = job.get('duration_seconds')
            if isinstance(duration, (int, float)):
                durations.append(duration)

        avg_duration_seconds = round(sum(durations) / len(durations), 1) if durations else 0

        funnel_steps, analytics_event_count = admin_metrics.build_admin_funnel_steps(
            filtered_analytics_docs,
            window_start,
            runtime=app_ctx,
        )
        rate_limit_counts = {'upload': 0, 'checkout': 0, 'analytics': 0, 'tools': 0}
        for doc in filtered_rate_limit_docs:
            entry = doc.to_dict() or {}
            limit_name = str(entry.get('limit_name', '') or '').strip().lower()
            if limit_name in rate_limit_counts:
                rate_limit_counts[limit_name] += 1

        rate_limit_entries = []
        for doc in filtered_rate_limit_docs:
            entry = doc.to_dict() or {}
            rate_limit_entries.append(entry)
        recent_rate_limits_sorted = sorted(
            rate_limit_entries,
            key=lambda entry: admin_metrics.get_timestamp(entry.get('created_at'), runtime=app_ctx),
            reverse=True,
        )[:20]
        recent_rate_limits = []
        for entry in recent_rate_limits_sorted:
            limit_name = str(entry.get('limit_name', '') or '').strip().lower()
            if limit_name not in {'upload', 'checkout', 'analytics', 'tools'}:
                continue
            recent_rate_limits.append({
                'created_at': entry.get('created_at', 0),
                'limit_name': limit_name,
                'retry_after_seconds': int(entry.get('retry_after_seconds', 0) or 0),
            })

        mode_breakdown = {
            'lecture-notes': {'label': 'Lecture Notes', 'total': 0, 'complete': 0, 'error': 0},
            'slides-only': {'label': 'Slide Extract', 'total': 0, 'complete': 0, 'error': 0},
            'interview': {'label': 'Interview Transcript', 'total': 0, 'complete': 0, 'error': 0},
            'other': {'label': 'Other', 'total': 0, 'complete': 0, 'error': 0},
        }
        for job in filtered_jobs:
            mode = job.get('mode', '')
            key = mode if mode in mode_breakdown else 'other'
            status = job.get('status', '')
            mode_breakdown[key]['total'] += 1
            if status == 'complete':
                mode_breakdown[key]['complete'] += 1
            elif status == 'error':
                mode_breakdown[key]['error'] += 1

        recent_jobs_sorted = sorted(
            filtered_jobs,
            key=lambda j: admin_metrics.get_timestamp(j.get('finished_at'), runtime=app_ctx),
            reverse=True
        )[:20]
        recent_jobs = []
        for job in recent_jobs_sorted:
            recent_jobs.append({
                'job_id': job.get('job_id', ''),
                'email': job.get('email', ''),
                'mode': job.get('mode', ''),
                'source_type': job.get('source_type', ''),
                'source_url': job.get('source_url', ''),
                'status': job.get('status', ''),
                'duration_seconds': job.get('duration_seconds', 0),
                'credit_refunded': job.get('credit_refunded', False),
                'finished_at': job.get('finished_at', 0),
                'token_input_total': job.get('token_input_total', 0),
                'token_output_total': job.get('token_output_total', 0),
                'token_total': job.get('token_total', 0),
                'custom_prompt': job.get('custom_prompt', ''),
                'prompt_template_key': job.get('prompt_template_key', ''),
                'prompt_source': job.get('prompt_source', ''),
                'credit_refund_method': job.get('credit_refund_method', ''),
            })

        recent_purchases_sorted = sorted(
            filtered_purchases,
            key=lambda p: admin_metrics.get_timestamp(p.get('created_at'), runtime=app_ctx),
            reverse=True
        )[:20]
        recent_purchases = []
        for purchase in recent_purchases_sorted:
            recent_purchases.append({
                'uid': purchase.get('uid', ''),
                'bundle_name': purchase.get('bundle_name', 'Unknown'),
                'price_cents': purchase.get('price_cents', 0),
                'currency': purchase.get('currency', 'eur'),
                'created_at': purchase.get('created_at', 0),
            })

        trend_labels, trend_keys, trend_granularity = admin_metrics.build_time_buckets(
            window_key,
            now_ts,
            runtime=app_ctx,
        )
        success_by_bucket = {key: {'complete': 0, 'error': 0} for key in trend_keys}
        revenue_by_bucket = {key: 0 for key in trend_keys}

        for job in filtered_jobs:
            timestamp = admin_metrics.get_timestamp(job.get('finished_at'), runtime=app_ctx)
            bucket_key = admin_metrics.get_bucket_key(timestamp, window_key, runtime=app_ctx)
            if bucket_key not in success_by_bucket:
                continue
            status = job.get('status', '')
            if status == 'complete':
                success_by_bucket[bucket_key]['complete'] += 1
            elif status == 'error':
                success_by_bucket[bucket_key]['error'] += 1

        for purchase in filtered_purchases:
            timestamp = admin_metrics.get_timestamp(purchase.get('created_at'), runtime=app_ctx)
            bucket_key = admin_metrics.get_bucket_key(timestamp, window_key, runtime=app_ctx)
            if bucket_key not in revenue_by_bucket:
                continue
            revenue_by_bucket[bucket_key] += purchase.get('price_cents', 0) or 0

        success_trend = []
        revenue_trend = []
        for key in trend_keys:
            complete_count = success_by_bucket[key]['complete']
            error_count = success_by_bucket[key]['error']
            total_count = complete_count + error_count
            success_rate = round((complete_count / total_count) * 100, 1) if total_count > 0 else 0
            success_trend.append(success_rate)
            revenue_trend.append(revenue_by_bucket[key])

        return app_ctx.jsonify({
            'window': {
                'key': window_key,
                'start': window_start,
                'end': now_ts,
            },
            'metrics': {
                'total_users': total_users,
                'new_users': new_users,
                'total_processed': total_processed,
                'total_revenue_cents': total_revenue_cents,
                'purchase_count': purchase_count,
                'job_count': job_count,
                'success_jobs': success_jobs,
                'failed_jobs': failed_jobs,
                'refunded_jobs': refunded_jobs,
                'avg_duration_seconds': avg_duration_seconds,
                'analytics_event_count': analytics_event_count,
                'rate_limit_upload_429': rate_limit_counts['upload'],
                'rate_limit_checkout_429': rate_limit_counts['checkout'],
                'rate_limit_analytics_429': rate_limit_counts['analytics'],
                'rate_limit_tools_429': rate_limit_counts['tools'],
                'rate_limit_429_total': rate_limit_counts['upload'] + rate_limit_counts['checkout'] + rate_limit_counts['analytics'] + rate_limit_counts['tools'],
            },
            'trends': {
                'labels': trend_labels,
                'success_rate': success_trend,
                'revenue_cents': revenue_trend,
                'granularity': trend_granularity,
            },
            'mode_breakdown': mode_breakdown,
            'funnel': {
                'steps': funnel_steps,
            },
            'recent_jobs': recent_jobs,
            'recent_purchases': recent_purchases,
            'recent_rate_limits': recent_rate_limits,
            'data_warnings': admin_metrics.get_admin_data_warnings(runtime=app_ctx),
            'deployment': admin_metrics.build_admin_deployment_info(request.host, runtime=app_ctx),
            'runtime_checks': admin_metrics.build_admin_runtime_checks(runtime=app_ctx),
        })
    except Exception as e:
        app_ctx.logger.error(f"Error fetching admin overview: {e}")
        return app_ctx.jsonify({'error': 'Could not fetch admin dashboard data'}), 500


def admin_export(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    if not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403

    export_type = request.args.get('type', 'jobs')
    if export_type not in {'jobs', 'purchases', 'funnel', 'funnel-daily'}:
        return app_ctx.jsonify({'error': 'Invalid export type'}), 400

    window_key, window_seconds = admin_metrics.get_admin_window(
        request.args.get('window', '7d'),
        runtime=app_ctx,
    )
    now_ts = app_ctx.time.time()
    window_start = now_ts - window_seconds
    usd_to_eur = _to_non_negative_float(request.args.get('usd_to_eur', 0.93), default=0.93) or 0.93
    pricing_payload = {}
    try:
        pricing_payload = admin_metrics.get_model_pricing_config(runtime=app_ctx)
    except Exception:
        pricing_payload = {}

    class _CsvBuffer:
        def write(self, value):
            return value

    def iter_rows():
        if export_type == 'jobs':
            yield [
                'job_id', 'uid', 'email', 'mode', 'source_type', 'source_url',
                'custom_prompt', 'prompt_template_key', 'prompt_source', 'status', 'credit_deducted',
                'credit_refund_method',
                'credit_refunded', 'error_message', 'started_at', 'finished_at', 'duration_seconds',
                'token_input_total', 'token_output_total', 'token_total', 'cost_usd', 'cost_eur'
            ]
            docs = admin_metrics.safe_query_docs_in_window(
                collection_name='job_logs',
                timestamp_field='finished_at',
                window_start=window_start,
                window_end=now_ts,
                order_desc=True,
                runtime=app_ctx,
            )
            for doc in docs:
                job = doc.to_dict() or {}
                cost_info = admin_metrics.compute_job_stage_costs(job, pricing_payload, runtime=app_ctx)
                token_input_total = _to_non_negative_int(cost_info.get('input_tokens', job.get('token_input_total', 0)))
                token_output_total = _to_non_negative_int(cost_info.get('output_tokens', job.get('token_output_total', 0)))
                token_total = _to_non_negative_int(cost_info.get('total_tokens', job.get('token_total', 0)))
                cost_usd = float(cost_info.get('cost_usd', 0.0) or 0.0)
                yield [
                    job.get('job_id', doc.id),
                    job.get('uid', ''),
                    job.get('email', ''),
                    job.get('mode', ''),
                    job.get('source_type', ''),
                    job.get('source_url', ''),
                    job.get('custom_prompt', ''),
                    job.get('prompt_template_key', ''),
                    job.get('prompt_source', ''),
                    job.get('status', ''),
                    job.get('credit_deducted', ''),
                    job.get('credit_refund_method', ''),
                    job.get('credit_refunded', False),
                    job.get('error_message', ''),
                    job.get('started_at', 0),
                    job.get('finished_at', 0),
                    job.get('duration_seconds', 0),
                    token_input_total,
                    token_output_total,
                    token_total,
                    round(cost_usd, 8),
                    round(cost_usd * usd_to_eur, 8),
                ]
            return

        if export_type == 'purchases':
            yield [
                'uid', 'bundle_id', 'bundle_name', 'price_cents', 'currency',
                'credits', 'stripe_session_id', 'created_at'
            ]
            docs = admin_metrics.safe_query_docs_in_window(
                collection_name='purchases',
                timestamp_field='created_at',
                window_start=window_start,
                window_end=now_ts,
                order_desc=True,
                runtime=app_ctx,
            )
            for doc in docs:
                purchase = doc.to_dict() or {}
                yield [
                    purchase.get('uid', ''),
                    purchase.get('bundle_id', ''),
                    purchase.get('bundle_name', ''),
                    purchase.get('price_cents', 0),
                    purchase.get('currency', 'eur'),
                    app_ctx.json.dumps(purchase.get('credits', {}), ensure_ascii=True),
                    purchase.get('stripe_session_id', ''),
                    purchase.get('created_at', 0),
                ]
            return

        analytics_docs = admin_metrics.safe_query_docs_in_window(
            collection_name='analytics_events',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
            order_desc=False,
            runtime=app_ctx,
        )

        if export_type == 'funnel':
            yield [
                'event',
                'label',
                'count',
                'conversion_from_prev_percent',
                'window_key',
                'window_start',
                'window_end',
                'generated_at',
            ]
            funnel_steps, _ = admin_metrics.build_admin_funnel_steps(
                analytics_docs,
                window_start,
                runtime=app_ctx,
            )
            generated_at = now_ts
            for step in funnel_steps:
                yield [
                    step.get('event', ''),
                    step.get('label', ''),
                    int(step.get('count', 0) or 0),
                    float(step.get('conversion_from_prev', 0.0) or 0.0),
                    window_key,
                    window_start,
                    now_ts,
                    generated_at,
                ]
            return

        yield [
            'bucket_key',
            'granularity',
            'event',
            'label',
            'unique_actor_count',
            'event_count',
            'conversion_from_prev_percent',
            'window_key',
            'window_start',
            'window_end',
            'generated_at',
        ]
        daily_rows, granularity = admin_metrics.build_admin_funnel_daily_rows(
            analytics_docs=analytics_docs,
            window_start=window_start,
            window_key=window_key,
            now_ts=now_ts,
            runtime=app_ctx,
        )
        generated_at = now_ts
        for row in daily_rows:
            yield [
                row.get('bucket_key', ''),
                granularity,
                row.get('event', ''),
                row.get('label', ''),
                int(row.get('unique_actor_count', 0) or 0),
                int(row.get('event_count', 0) or 0),
                float(row.get('conversion_from_prev', 0.0) or 0.0),
                window_key,
                window_start,
                now_ts,
                generated_at,
            ]

    def generate_csv():
        buffer = _CsvBuffer()
        writer = app_ctx.csv.writer(buffer)
        for row in iter_rows():
            yield writer.writerow(sanitize_csv_row(row))

    try:
        filename = f"admin-{export_type}-{window_key}.csv"
        response = app_ctx.Response(app_ctx.stream_with_context(generate_csv()), mimetype='text/csv')
        response.headers['Content-Disposition'] = f'attachment; filename={filename}'
        return response
    except Exception as e:
        app_ctx.logger.error(f"Error exporting admin CSV ({export_type}): {e}")
        return app_ctx.jsonify({'error': 'Could not export CSV'}), 500


def admin_prompts(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    if not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403

    fmt = request.args.get('format', 'json')
    if fmt == 'markdown':
        return app_ctx.jsonify({'markdown': app_ctx.get_prompt_inventory_markdown()})
    return app_ctx.jsonify({'prompts': app_ctx.get_prompt_inventory()})


def admin_model_pricing(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    if not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403

    try:
        payload = admin_metrics.get_model_pricing_config(runtime=app_ctx)
    except Exception as error:
        app_ctx.logger.error(f"Error loading model pricing config: {error}")
        return app_ctx.jsonify({'error': 'Could not load model pricing configuration'}), 500

    if not isinstance(payload, dict):
        return app_ctx.jsonify({'error': 'Invalid model pricing configuration'}), 500
    return app_ctx.jsonify(payload)


def admin_cost_analysis(app_ctx, request):
    _decoded, error_response, status = _require_admin(app_ctx, request)
    if error_response is not None:
        return error_response, status

    payload = request.get_json(silent=True) or {}
    normalized_filters = _normalize_analysis_filters(payload, runtime=app_ctx)
    try:
        analysis = _build_cost_analysis_payload(app_ctx, normalized_filters)
    except Exception as error:
        app_ctx.logger.error(f"Error building admin cost analysis: {error}")
        return app_ctx.jsonify({'error': 'Could not build cost analysis'}), 500
    return app_ctx.jsonify(analysis)


def admin_cost_analysis_export(app_ctx, request):
    _decoded, error_response, status = _require_admin(app_ctx, request)
    if error_response is not None:
        return error_response, status
    if Workbook is None:
        return app_ctx.jsonify({'error': 'Excel export dependency is missing'}), 500

    payload = request.get_json(silent=True) or {}
    normalized_filters = _normalize_analysis_filters(payload, runtime=app_ctx)
    try:
        analysis = _build_cost_analysis_payload(app_ctx, normalized_filters)
    except Exception as error:
        app_ctx.logger.error(f"Error building admin cost analysis export: {error}")
        return app_ctx.jsonify({'error': 'Could not export cost analysis'}), 500

    workbook = Workbook()
    summary_sheet = workbook.active
    summary_sheet.title = 'Summary'

    summary_rows = [
        ['Pricing version', analysis.get('pricing_version', '')],
        ['Period', analysis.get('filters', {}).get('period', '')],
        ['Window start (UTC)', datetime.fromtimestamp(analysis.get('filters', {}).get('window_start', 0), tz=timezone.utc).isoformat()],
        ['Window end (UTC)', datetime.fromtimestamp(analysis.get('filters', {}).get('window_end', 0), tz=timezone.utc).isoformat()],
        ['Mode filter', analysis.get('filters', {}).get('mode', '') or 'all'],
        ['Status filter', analysis.get('filters', {}).get('status', '') or 'all'],
        ['UID filter', analysis.get('filters', {}).get('uid', '') or 'all'],
        ['Email filter', analysis.get('filters', {}).get('email', '') or 'all'],
        ['Selection mode', analysis.get('filters', {}).get('selection', 'all')],
        ['USD -> EUR rate', float(analysis.get('usd_to_eur', 0.93) or 0.93)],
        ['Jobs filtered', int((analysis.get('summary') or {}).get('jobs_filtered', 0) or 0)],
        ['Jobs selected', int((analysis.get('summary') or {}).get('jobs_selected', 0) or 0)],
        ['Input tokens total', int((analysis.get('summary') or {}).get('token_input_total', 0) or 0)],
        ['Output tokens total', int((analysis.get('summary') or {}).get('token_output_total', 0) or 0)],
        ['Token total', int((analysis.get('summary') or {}).get('token_total', 0) or 0)],
        ['Cost total (USD)', float((analysis.get('summary') or {}).get('cost_usd_total', 0.0) or 0.0)],
        ['Cost total (EUR)', float((analysis.get('summary') or {}).get('cost_eur_total', 0.0) or 0.0)],
    ]
    for row in summary_rows:
        summary_sheet.append([sanitize_excel_cell(value) for value in row])

    jobs_sheet = workbook.create_sheet('Jobs')
    jobs_sheet.append(
        [
            'job_id',
            'uid',
            'email',
            'mode',
            'status',
            'finished_at',
            'billing_mode',
            'is_batch',
            'batch_parent_id',
            'batch_row_id',
            'token_input_total',
            'token_output_total',
            'token_total',
            'cost_usd',
            'cost_eur',
            'missing_stage_usage',
        ]
    )
    for job in analysis.get('jobs', []) or []:
        jobs_sheet.append(
            [
                sanitize_excel_cell(job.get('job_id', '')),
                sanitize_excel_cell(job.get('uid', '')),
                sanitize_excel_cell(job.get('email', '')),
                sanitize_excel_cell(job.get('mode', '')),
                sanitize_excel_cell(job.get('status', '')),
                sanitize_excel_cell(job.get('finished_at', 0)),
                sanitize_excel_cell(job.get('billing_mode', '')),
                sanitize_excel_cell(bool(job.get('is_batch', False))),
                sanitize_excel_cell(job.get('batch_parent_id', '')),
                sanitize_excel_cell(job.get('batch_row_id', '')),
                sanitize_excel_cell(int(job.get('token_input_total', 0) or 0)),
                sanitize_excel_cell(int(job.get('token_output_total', 0) or 0)),
                sanitize_excel_cell(int(job.get('token_total', 0) or 0)),
                sanitize_excel_cell(float(job.get('cost_usd', 0.0) or 0.0)),
                sanitize_excel_cell(float(job.get('cost_eur', 0.0) or 0.0)),
                sanitize_excel_cell(bool(job.get('missing_stage_usage', False))),
            ]
        )

    stages_sheet = workbook.create_sheet('Stage Breakdown')
    stages_sheet.append(
        [
            'job_id',
            'stage',
            'model',
            'tier',
            'billing_mode',
            'input_modality',
            'input_tokens',
            'output_tokens',
            'total_tokens',
            'input_rate_per_million_usd',
            'output_rate_per_million_usd',
            'cost_input_usd',
            'cost_output_usd',
            'cost_usd',
            'cost_eur',
            'matched_pricing',
        ]
    )
    for stage in analysis.get('stages', []) or []:
        stages_sheet.append(
            [
                sanitize_excel_cell(stage.get('job_id', '')),
                sanitize_excel_cell(stage.get('stage', '')),
                sanitize_excel_cell(stage.get('model', '')),
                sanitize_excel_cell(stage.get('tier', '')),
                sanitize_excel_cell(stage.get('billing_mode', '')),
                sanitize_excel_cell(stage.get('input_modality', '')),
                sanitize_excel_cell(int(stage.get('input_tokens', 0) or 0)),
                sanitize_excel_cell(int(stage.get('output_tokens', 0) or 0)),
                sanitize_excel_cell(int(stage.get('total_tokens', 0) or 0)),
                sanitize_excel_cell(float(stage.get('input_rate_per_million', 0.0) or 0.0)),
                sanitize_excel_cell(float(stage.get('output_rate_per_million', 0.0) or 0.0)),
                sanitize_excel_cell(float(stage.get('cost_input_usd', 0.0) or 0.0)),
                sanitize_excel_cell(float(stage.get('cost_output_usd', 0.0) or 0.0)),
                sanitize_excel_cell(float(stage.get('cost_usd', 0.0) or 0.0)),
                sanitize_excel_cell(float(stage.get('cost_eur', 0.0) or 0.0)),
                sanitize_excel_cell(bool(stage.get('matched_pricing', False))),
            ]
        )

    output = app_ctx.io.BytesIO()
    workbook.save(output)
    output.seek(0)
    period = analysis.get('filters', {}).get('period', 'monthly')
    filename = f'admin-cost-analysis-{period}.xlsx'
    return app_ctx.send_file(
        output,
        mimetype='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        as_attachment=True,
        download_name=filename,
    )


def admin_batch_jobs(app_ctx, request):
    _decoded, error_response, status = _require_admin(app_ctx, request)
    if error_response is not None:
        return error_response, status

    status_filter = str(request.args.get('status', '') or '').strip()
    mode_filter = str(request.args.get('mode', '') or '').strip()
    try:
        limit = int(request.args.get('limit', 200) or 200)
    except Exception:
        limit = 200
    limit = max(1, min(500, limit))

    statuses = [part.strip() for part in status_filter.split(',') if part.strip()] if status_filter else []
    batches = batch_orchestrator.list_batches_for_admin(
        statuses=statuses,
        limit=limit,
        runtime=app_ctx,
    )
    if mode_filter:
        batches = [item for item in batches if str(item.get('mode', '') or '') == mode_filter]
    return app_ctx.jsonify({'batches': batches})
