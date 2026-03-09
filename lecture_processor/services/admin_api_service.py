"""Business logic handlers for admin APIs."""

from datetime import datetime, timezone

try:
    from openpyxl import Workbook
except Exception:
    Workbook = None

from lecture_processor.services import admin_dashboard_service
from lecture_processor.domains.admin import metrics as admin_metrics
from lecture_processor.domains.shared import sanitize_excel_cell


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
        filters=admin_metrics.admin_job_filters(runtime=app_ctx),
        runtime=app_ctx,
    )
    filtered_jobs = []
    for doc in docs:
        job = doc.to_dict() or {}
        job_id = str(job.get('job_id', doc.id) or doc.id)
        if not job_id:
            continue
        job['job_id'] = job_id
        if not admin_metrics.is_admin_visible_job(job, runtime=app_ctx):
            continue
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
    return admin_dashboard_service.admin_overview(app_ctx, request)


def admin_export(app_ctx, request):
    return admin_dashboard_service.admin_export(app_ctx, request)


def admin_prompts(app_ctx, request):
    return admin_dashboard_service.admin_prompts(app_ctx, request)


def admin_model_pricing(app_ctx, request):
    return admin_dashboard_service.admin_model_pricing(app_ctx, request)


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
    return admin_dashboard_service.admin_batch_jobs(app_ctx, request)
