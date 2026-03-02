"""Business logic handlers for admin APIs."""


def admin_overview(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    if not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403

    try:
        window_key, window_seconds = app_ctx.get_admin_window(request.args.get('window', '7d'))
        now_ts = app_ctx.time.time()
        window_start = now_ts - window_seconds

        total_users = app_ctx.safe_count_collection('users')
        new_users = app_ctx.safe_count_window('users', 'created_at', window_start)
        total_processed = app_ctx.safe_count_collection('job_logs')

        filtered_purchases_docs = app_ctx.safe_query_docs_in_window(
            collection_name='purchases',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
        )
        filtered_jobs_docs = app_ctx.safe_query_docs_in_window(
            collection_name='job_logs',
            timestamp_field='finished_at',
            window_start=window_start,
            window_end=now_ts,
        )
        filtered_analytics_docs = app_ctx.safe_query_docs_in_window(
            collection_name='analytics_events',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
        )
        filtered_rate_limit_docs = app_ctx.safe_query_docs_in_window(
            collection_name='rate_limit_logs',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
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

        funnel_steps, analytics_event_count = app_ctx.build_admin_funnel_steps(filtered_analytics_docs, window_start)
        rate_limit_counts = {'upload': 0, 'checkout': 0, 'analytics': 0}
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
            key=lambda entry: app_ctx.get_timestamp(entry.get('created_at')),
            reverse=True,
        )[:20]
        recent_rate_limits = []
        for entry in recent_rate_limits_sorted:
            limit_name = str(entry.get('limit_name', '') or '').strip().lower()
            if limit_name not in {'upload', 'checkout', 'analytics'}:
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
            key=lambda j: app_ctx.get_timestamp(j.get('finished_at')),
            reverse=True
        )[:20]
        recent_jobs = []
        for job in recent_jobs_sorted:
            recent_jobs.append({
                'job_id': job.get('job_id', ''),
                'email': job.get('email', ''),
                'mode': job.get('mode', ''),
                'status': job.get('status', ''),
                'duration_seconds': job.get('duration_seconds', 0),
                'credit_refunded': job.get('credit_refunded', False),
                'finished_at': job.get('finished_at', 0),
            })

        recent_purchases_sorted = sorted(
            filtered_purchases,
            key=lambda p: app_ctx.get_timestamp(p.get('created_at')),
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

        trend_labels, trend_keys, trend_granularity = app_ctx.build_time_buckets(window_key, now_ts)
        success_by_bucket = {key: {'complete': 0, 'error': 0} for key in trend_keys}
        revenue_by_bucket = {key: 0 for key in trend_keys}

        for job in filtered_jobs:
            timestamp = app_ctx.get_timestamp(job.get('finished_at'))
            bucket_key = app_ctx.get_bucket_key(timestamp, window_key)
            if bucket_key not in success_by_bucket:
                continue
            status = job.get('status', '')
            if status == 'complete':
                success_by_bucket[bucket_key]['complete'] += 1
            elif status == 'error':
                success_by_bucket[bucket_key]['error'] += 1

        for purchase in filtered_purchases:
            timestamp = app_ctx.get_timestamp(purchase.get('created_at'))
            bucket_key = app_ctx.get_bucket_key(timestamp, window_key)
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
                'rate_limit_429_total': rate_limit_counts['upload'] + rate_limit_counts['checkout'] + rate_limit_counts['analytics'],
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
            'deployment': app_ctx.build_admin_deployment_info(request.host),
            'runtime_checks': app_ctx.build_admin_runtime_checks(),
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

    window_key, window_seconds = app_ctx.get_admin_window(request.args.get('window', '7d'))
    now_ts = app_ctx.time.time()
    window_start = now_ts - window_seconds

    class _CsvBuffer:
        def write(self, value):
            return value

    def iter_rows():
        if export_type == 'jobs':
            yield [
                'job_id', 'uid', 'email', 'mode', 'status', 'credit_deducted',
                'credit_refunded', 'error_message', 'started_at', 'finished_at', 'duration_seconds'
            ]
            docs = app_ctx.safe_query_docs_in_window(
                collection_name='job_logs',
                timestamp_field='finished_at',
                window_start=window_start,
                window_end=now_ts,
                order_desc=True,
            )
            for doc in docs:
                job = doc.to_dict() or {}
                yield [
                    job.get('job_id', doc.id),
                    job.get('uid', ''),
                    job.get('email', ''),
                    job.get('mode', ''),
                    job.get('status', ''),
                    job.get('credit_deducted', ''),
                    job.get('credit_refunded', False),
                    job.get('error_message', ''),
                    job.get('started_at', 0),
                    job.get('finished_at', 0),
                    job.get('duration_seconds', 0),
                ]
            return

        if export_type == 'purchases':
            yield [
                'uid', 'bundle_id', 'bundle_name', 'price_cents', 'currency',
                'credits', 'stripe_session_id', 'created_at'
            ]
            docs = app_ctx.safe_query_docs_in_window(
                collection_name='purchases',
                timestamp_field='created_at',
                window_start=window_start,
                window_end=now_ts,
                order_desc=True,
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

        analytics_docs = app_ctx.safe_query_docs_in_window(
            collection_name='analytics_events',
            timestamp_field='created_at',
            window_start=window_start,
            window_end=now_ts,
            order_desc=False,
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
            funnel_steps, _ = app_ctx.build_admin_funnel_steps(analytics_docs, window_start)
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
        daily_rows, granularity = app_ctx.build_admin_funnel_daily_rows(
            analytics_docs=analytics_docs,
            window_start=window_start,
            window_key=window_key,
            now_ts=now_ts,
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
            yield writer.writerow(row)

    try:
        filename = f"admin-{export_type}-{window_key}.csv"
        response = app_ctx.Response(app_ctx.stream_with_context(generate_csv()), mimetype='text/csv')
        response.headers['Content-Disposition'] = f'attachment; filename={filename}'
        return response
    except Exception as e:
        app_ctx.logger.error(f"Error exporting admin CSV ({export_type}): {e}")
        return app_ctx.jsonify({'error': 'Could not export CSV'}), 500
