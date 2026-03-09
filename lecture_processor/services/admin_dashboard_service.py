"""Admin dashboard, export, and batch-list flows extracted from admin API service."""

from lecture_processor.domains.admin import metrics as admin_metrics
from lecture_processor.domains.admin import rollups as admin_rollups
from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.shared import sanitize_csv_row


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

        job_filters = admin_metrics.admin_job_filters(runtime=app_ctx)
        total_users = admin_metrics.safe_count_collection('users', runtime=app_ctx)
        new_users = admin_metrics.safe_count_window('users', 'created_at', window_start, runtime=app_ctx)
        total_processed = admin_metrics.safe_count_collection('job_logs', filters=job_filters, runtime=app_ctx)
        trend_labels, trend_keys, trend_granularity = admin_metrics.build_time_buckets(
            window_key,
            now_ts,
            runtime=app_ctx,
        )
        rollups = admin_rollups.load_window_rollups(window_key, now_ts, runtime=app_ctx)
        rollups_by_key = {
            str(rollup.get('bucket_key', '') or ''): rollup
            for rollup in rollups
            if isinstance(rollup, dict)
        }

        purchase_count = 0
        total_revenue_cents = 0
        job_count = 0
        success_jobs = 0
        failed_jobs = 0
        refunded_jobs = 0
        duration_sum_seconds = 0.0
        duration_count = 0
        analytics_event_count = 0
        rate_limit_counts = {name: 0 for name in admin_rollups.KNOWN_RATE_LIMITS}
        funnel_counts = {
            str(stage.get('event', '') or '').strip(): 0
            for stage in app_ctx.ANALYTICS_FUNNEL_STAGES
            if str(stage.get('event', '') or '').strip()
        }
        mode_breakdown = {
            'lecture-notes': {'label': 'Lecture Notes', 'total': 0, 'complete': 0, 'error': 0},
            'slides-only': {'label': 'Slide Extract', 'total': 0, 'complete': 0, 'error': 0},
            'interview': {'label': 'Interview Transcript', 'total': 0, 'complete': 0, 'error': 0},
            'other': {'label': 'Other', 'total': 0, 'complete': 0, 'error': 0},
        }

        for rollup in rollups:
            purchases = rollup.get('purchases', {}) if isinstance(rollup.get('purchases'), dict) else {}
            jobs = rollup.get('jobs', {}) if isinstance(rollup.get('jobs'), dict) else {}
            analytics = rollup.get('analytics', {}) if isinstance(rollup.get('analytics'), dict) else {}
            rate_limits = rollup.get('rate_limits', {}) if isinstance(rollup.get('rate_limits'), dict) else {}
            purchase_count += _to_non_negative_int(purchases.get('count', 0))
            total_revenue_cents += _to_non_negative_int(purchases.get('total_revenue_cents', 0))
            job_count += _to_non_negative_int(jobs.get('total', 0))
            success_jobs += _to_non_negative_int(jobs.get('complete', 0))
            failed_jobs += _to_non_negative_int(jobs.get('error', 0))
            refunded_jobs += _to_non_negative_int(jobs.get('refunded', 0))
            duration_sum_seconds += _to_non_negative_float(jobs.get('duration_sum_seconds', 0.0))
            duration_count += _to_non_negative_int(jobs.get('duration_count', 0))
            analytics_event_count += _to_non_negative_int(analytics.get('event_count', 0))
            funnel_counts_payload = analytics.get('funnel_counts', {}) if isinstance(analytics.get('funnel_counts'), dict) else {}
            for event_name in funnel_counts:
                funnel_counts[event_name] += _to_non_negative_int(funnel_counts_payload.get(event_name, 0))
            for limit_name in rate_limit_counts:
                rate_limit_counts[limit_name] += _to_non_negative_int(rate_limits.get(limit_name, 0))
            by_mode = jobs.get('by_mode', {}) if isinstance(jobs.get('by_mode'), dict) else {}
            for mode_name in mode_breakdown:
                mode_payload = by_mode.get(mode_name, {}) if isinstance(by_mode.get(mode_name), dict) else {}
                mode_breakdown[mode_name]['total'] += _to_non_negative_int(mode_payload.get('total', 0))
                mode_breakdown[mode_name]['complete'] += _to_non_negative_int(mode_payload.get('complete', 0))
                mode_breakdown[mode_name]['error'] += _to_non_negative_int(mode_payload.get('error', 0))

        avg_duration_seconds = round(duration_sum_seconds / duration_count, 1) if duration_count > 0 else 0

        funnel_steps = []
        previous_count = 0
        for idx, stage in enumerate(app_ctx.ANALYTICS_FUNNEL_STAGES):
            event_name = str(stage.get('event', '') or '').strip()
            count = _to_non_negative_int(funnel_counts.get(event_name, 0))
            if idx == 0:
                conversion = 100.0 if count > 0 else 0.0
            elif previous_count > 0:
                conversion = round(min(count / previous_count * 100.0, 100.0), 1)
            else:
                conversion = 0.0
            funnel_steps.append({
                'event': event_name,
                'label': stage.get('label', event_name),
                'count': count,
                'conversion_from_prev': conversion,
            })
            previous_count = count

        recent_job_docs = admin_metrics.safe_query_docs_in_window(
            collection_name='job_logs',
            timestamp_field='finished_at',
            window_start=window_start,
            window_end=now_ts,
            order_desc=True,
            limit=20,
            filters=job_filters,
            allow_unfiltered_fallback=False,
            runtime=app_ctx,
        )
        recent_jobs = []
        for doc in recent_job_docs:
            job = doc.to_dict() or {}
            if not admin_metrics.is_admin_visible_job(job, runtime=app_ctx):
                continue
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

        recent_purchase_docs = admin_metrics.safe_query_docs_in_window(
            collection_name='purchases',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
            order_desc=True,
            limit=20,
            allow_unfiltered_fallback=False,
            runtime=app_ctx,
        )
        recent_purchases = []
        for doc in recent_purchase_docs:
            purchase = doc.to_dict() or {}
            recent_purchases.append({
                'uid': purchase.get('uid', ''),
                'bundle_name': purchase.get('bundle_name', 'Unknown'),
                'price_cents': purchase.get('price_cents', 0),
                'currency': purchase.get('currency', 'eur'),
                'created_at': purchase.get('created_at', 0),
            })

        recent_rate_limit_docs = admin_metrics.safe_query_docs_in_window(
            collection_name='rate_limit_logs',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
            order_desc=True,
            limit=20,
            allow_unfiltered_fallback=False,
            runtime=app_ctx,
        )
        recent_rate_limits = []
        for doc in recent_rate_limit_docs:
            entry = doc.to_dict() or {}
            limit_name = str(entry.get('limit_name', '') or '').strip().lower()
            if limit_name not in rate_limit_counts:
                continue
            recent_rate_limits.append({
                'created_at': entry.get('created_at', 0),
                'limit_name': limit_name,
                'retry_after_seconds': int(entry.get('retry_after_seconds', 0) or 0),
            })

        success_trend = []
        revenue_trend = []
        for key in trend_keys:
            rollup = rollups_by_key.get(key, {})
            jobs_payload = rollup.get('jobs', {}) if isinstance(rollup.get('jobs'), dict) else {}
            purchases_payload = rollup.get('purchases', {}) if isinstance(rollup.get('purchases'), dict) else {}
            complete_count = _to_non_negative_int(jobs_payload.get('complete', 0))
            error_count = _to_non_negative_int(jobs_payload.get('error', 0))
            total_count = complete_count + error_count
            success_rate = round((complete_count / total_count) * 100, 1) if total_count > 0 else 0
            success_trend.append(success_rate)
            revenue_trend.append(_to_non_negative_int(purchases_payload.get('total_revenue_cents', 0)))

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
                filters=admin_metrics.admin_job_filters(runtime=app_ctx),
                runtime=app_ctx,
            )
            for doc in docs:
                job = doc.to_dict() or {}
                if not admin_metrics.is_admin_visible_job(job, runtime=app_ctx):
                    continue
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
    upstream_limit = max(limit, min(500, limit * 4))
    batches = batch_orchestrator.list_batches_for_admin(
        statuses=statuses,
        limit=upstream_limit,
        runtime=app_ctx,
    )
    visible_batches = []
    for item in batches:
        if not admin_metrics.is_admin_visible_batch(item, runtime=app_ctx):
            continue
        if mode_filter and str(item.get('mode', '') or '') != mode_filter:
            continue
        visible_batches.append(item)
        if len(visible_batches) >= limit:
            break
    return app_ctx.jsonify({'batches': visible_batches})
