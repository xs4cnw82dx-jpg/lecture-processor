"""Runtime status, download, and estimate handlers for upload-related APIs."""

from collections import defaultdict

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.admin import metrics as admin_metrics
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.shared import sanitize_csv_row
from lecture_processor.domains.study import export as study_export


def get_status(app_ctx, request, job_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = runtime_jobs_store.get_job_snapshot(job_id, runtime=app_ctx)
    if not job:
        app_ctx.cleanup_old_jobs()
        job = runtime_jobs_store.get_job_snapshot(job_id, runtime=app_ctx)
        if not job:
            return app_ctx.jsonify({
                'error': 'Job status is temporarily unavailable. Retrying should usually recover it within a few seconds.',
                'error_code': 'JOB_TEMPORARILY_UNAVAILABLE',
                'job_lost': True,
                'retryable': True,
            }), 404
    if job.get('user_id', '') != uid and not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403
    response = {
        'status': job['status'],
        'step': job['step'],
        'step_description': job['step_description'],
        'total_steps': job.get('total_steps', 3),
        'mode': job.get('mode', 'lecture-notes'),
        'retry_attempts': int(job.get('retry_attempts', 0) or 0),
        'failed_stage': job.get('failed_stage', ''),
        'provider_error_code': job.get('provider_error_code', ''),
    }
    billing_receipt = billing_receipts.get_billing_receipt_snapshot(job, runtime=app_ctx)
    if billing_receipt.get('charged') or billing_receipt.get('refunded'):
        response['billing_receipt'] = billing_receipt
    if job['status'] == 'complete':
        response['result'] = job['result']
        response['flashcards'] = job.get('flashcards', [])
        response['test_questions'] = job.get('test_questions', [])
        response['study_generation_error'] = job.get('study_generation_error')
        response['study_pack_id'] = job.get('study_pack_id')
        response['study_features'] = job.get('study_features', 'none')
        response['output_language'] = job.get('output_language', 'English')
        response['interview_features'] = job.get('interview_features', [])
        response['interview_features_successful'] = job.get('interview_features_successful', [])
        response['interview_summary'] = job.get('interview_summary')
        response['interview_sections'] = job.get('interview_sections')
        response['interview_combined'] = job.get('interview_combined')
        response['token_input_total'] = int(job.get('token_input_total', 0) or 0)
        response['token_output_total'] = int(job.get('token_output_total', 0) or 0)
        response['token_total'] = int(job.get('token_total', 0) or 0)
        response['token_usage_by_stage'] = job.get('token_usage_by_stage', {})
        if job.get('mode') == 'lecture-notes':
            response['slide_text'] = job.get('slide_text')
            response['transcript'] = job.get('transcript')
        if job.get('mode') == 'interview':
            response['transcript'] = job.get('transcript')
        if job.get('mode') == 'physio-transcription':
            response['transcript'] = job.get('transcript')
    elif job['status'] == 'error':
        response['error'] = job['error']
        response['credit_refunded'] = job.get('credit_refunded', False)
    return app_ctx.jsonify(response)


def _is_active_regular_runtime_job(job, uid):
    if not isinstance(job, dict):
        return False
    if str(job.get('user_id', '') or '').strip() != uid:
        return False
    status = str(job.get('status', '') or '').strip().lower()
    if status not in account_lifecycle.ACTIVE_ACCOUNT_JOB_STATES:
        return False
    return not bool(job.get('is_batch', False))


def _serialize_active_runtime_job(job_id, job):
    return {
        'job_id': str(job_id or '').strip(),
        'mode': str(job.get('mode', '') or '').strip(),
        'status': str(job.get('status', '') or '').strip(),
        'step': int(job.get('step', 0) or 0),
        'step_description': str(job.get('step_description', '') or '').strip(),
        'study_pack_title': str(job.get('study_pack_title', '') or '').strip(),
        'started_at': float(job.get('started_at', 0) or 0),
        'study_pack_id': str(job.get('study_pack_id', '') or '').strip(),
        'error': str(job.get('error', '') or '').strip(),
    }


def get_active_runtime_jobs(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']

    jobs_by_id = {}
    with app_ctx.JOBS_LOCK:
        for job_id, job in (app_ctx.jobs or {}).items():
            if not _is_active_regular_runtime_job(job, uid):
                continue
            jobs_by_id[str(job_id)] = _serialize_active_runtime_job(job_id, job)

    if getattr(app_ctx, 'db', None) is not None:
        try:
            runtime_docs = app_ctx.runtime_jobs_repo.query_by_user_and_statuses(
                app_ctx.db,
                app_ctx.RUNTIME_JOBS_COLLECTION,
                uid,
                account_lifecycle.ACTIVE_ACCOUNT_JOB_STATES,
                limit=200,
            )
            for doc in runtime_docs:
                job = doc.to_dict() or {}
                if not _is_active_regular_runtime_job(job, uid):
                    continue
                serialized = _serialize_active_runtime_job(doc.id, job)
                existing = jobs_by_id.get(serialized['job_id'])
                if existing is None or float(serialized.get('started_at', 0) or 0) >= float(existing.get('started_at', 0) or 0):
                    jobs_by_id[serialized['job_id']] = serialized
        except Exception as error:
            app_ctx.logger.warning('Could not load active runtime jobs for user %s: %s', uid, error)

    jobs = sorted(
        jobs_by_id.values(),
        key=lambda row: (-float(row.get('started_at', 0) or 0), str(row.get('job_id', '') or '')),
    )
    return app_ctx.jsonify({'jobs': jobs})


def download_docx(app_ctx, request, job_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = runtime_jobs_store.get_job_snapshot(job_id, runtime=app_ctx)
    if not job:
        return app_ctx.jsonify({'error': 'Job not found'}), 404
    if job.get('user_id', '') != uid and not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403
    if job['status'] != 'complete':
        return app_ctx.jsonify({'error': 'Job not complete'}), 400
    content_type = request.args.get('type', 'result')
    allowed_content_types = {'result', 'slides', 'transcript', 'summary', 'sections', 'combined'}
    if content_type not in allowed_content_types:
        content_type = 'result'

    if content_type == 'slides' and job.get('slide_text'):
        content, filename, title = job['slide_text'], 'slide-extract.docx', 'Slide Extract'
    elif content_type == 'transcript' and job.get('transcript'):
        content, filename, title = job['transcript'], 'lecture-transcript.docx', 'Lecture Transcript'
    elif content_type == 'summary' and job.get('interview_summary'):
        content, filename, title = job['interview_summary'], 'interview-summary.docx', 'Interview Summary'
    elif content_type == 'sections' and job.get('interview_sections'):
        content, filename, title = job['interview_sections'], 'interview-structured.docx', 'Structured Interview Transcript'
    elif content_type == 'combined' and job.get('interview_combined'):
        content, filename, title = job['interview_combined'], 'interview-summary-structured.docx', 'Interview Summary + Structured Transcript'
    else:
        content = job['result']
        mode = job.get('mode', 'lecture-notes')
        if mode == 'lecture-notes':
            filename, title = 'lecture-notes.docx', 'Lecture Notes'
        elif mode == 'slides-only':
            filename, title = 'slide-extract.docx', 'Slide Extract'
        else:
            filename, title = 'interview-transcript.docx', 'Interview Transcript'

    doc = study_export.markdown_to_docx(content, title, runtime=app_ctx)
    docx_io = app_ctx.io.BytesIO()
    doc.save(docx_io)
    docx_io.seek(0)
    return app_ctx.send_file(
        docx_io,
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        as_attachment=True,
        download_name=filename,
    )


def download_flashcards_csv(app_ctx, request, job_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = runtime_jobs_store.get_job_snapshot(job_id, runtime=app_ctx)
    if not job:
        return app_ctx.jsonify({'error': 'Job not found'}), 404
    if job.get('user_id', '') != uid and not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403
    if job.get('status') != 'complete':
        return app_ctx.jsonify({'error': 'Job not complete'}), 400
    export_type = request.args.get('type', 'flashcards').strip().lower()

    output = app_ctx.io.StringIO()
    writer = app_ctx.csv.writer(output)
    if export_type == 'test':
        test_questions = job.get('test_questions', [])
        if not test_questions:
            return app_ctx.jsonify({'error': 'No practice questions available for this job'}), 400
        writer.writerow(['question', 'option_a', 'option_b', 'option_c', 'option_d', 'answer', 'explanation'])
        for question in test_questions:
            options = question.get('options', [])
            padded = (options + ['', '', '', ''])[:4]
            writer.writerow(sanitize_csv_row([
                question.get('question', ''),
                padded[0],
                padded[1],
                padded[2],
                padded[3],
                question.get('answer', ''),
                question.get('explanation', ''),
            ]))
        filename = f'practice-test-{job_id}.csv'
    else:
        flashcards = job.get('flashcards', [])
        if not flashcards:
            return app_ctx.jsonify({'error': 'No flashcards available for this job'}), 400
        writer.writerow(['question', 'answer'])
        for card in flashcards:
            writer.writerow(sanitize_csv_row([card.get('front', ''), card.get('back', '')]))
        filename = f'flashcards-{job_id}.csv'

    csv_bytes = app_ctx.io.BytesIO(output.getvalue().encode('utf-8'))
    csv_bytes.seek(0)
    return app_ctx.send_file(csv_bytes, mimetype='text/csv', as_attachment=True, download_name=filename)


def _estimate_size_bucket(total_mb):
    try:
        value = float(total_mb or 0.0)
    except Exception:
        value = 0.0
    if value <= 0:
        return 'unknown'
    if value < 25:
        return 's'
    if value < 100:
        return 'm'
    if value < 300:
        return 'l'
    return 'xl'


def _duration_percentile(sorted_values, percentile):
    import math

    if not sorted_values:
        return 0
    if len(sorted_values) == 1:
        return int(round(sorted_values[0]))
    pos = max(0.0, min(1.0, float(percentile))) * (len(sorted_values) - 1)
    lo = int(math.floor(pos))
    hi = int(math.ceil(pos))
    if lo == hi:
        return int(round(sorted_values[lo]))
    frac = pos - lo
    value = sorted_values[lo] + (sorted_values[hi] - sorted_values[lo]) * frac
    return int(round(value))


def _heuristic_estimate_range(mode, total_mb, study_features, interview_features_count):
    mb = max(0.0, float(total_mb or 0.0))
    if mode == 'lecture-notes':
        base = 70 + mb * 1.0
        if study_features == 'none':
            base -= 18
        elif study_features == 'both':
            base += 12
    elif mode == 'slides-only':
        base = 25 + mb * 0.6
        if study_features in {'flashcards', 'test', 'both'}:
            base += 10
    else:
        base = 45 + mb * 1.2 + int(interview_features_count or 0) * 16
    typical = max(20, int(round(base)))
    low = max(15, int(round(typical * 0.72)))
    high = max(low + 10, int(round(typical * 1.34)))
    return (low, typical, high)


def processing_estimate(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    mode = str(request.args.get('mode', 'lecture-notes') or 'lecture-notes').strip().lower()
    if mode not in {'lecture-notes', 'slides-only', 'interview'}:
        return app_ctx.jsonify({'error': 'Invalid mode'}), 400

    study_features = str(request.args.get('study_features', 'none') or 'none').strip().lower()
    if study_features not in {'none', 'flashcards', 'test', 'both'}:
        study_features = 'none'

    interview_features_count = app_ctx.sanitize_int(
        request.args.get('interview_features_count', 0),
        default=0,
        min_value=0,
        max_value=2,
    )
    total_mb = app_ctx.sanitize_float(
        request.args.get('total_mb', 0),
        default=0.0,
        min_value=0.0,
        max_value=1024.0,
    )
    requested_bucket = _estimate_size_bucket(total_mb)
    window_start = app_ctx.time.time() - 30 * 86400
    docs = admin_metrics.safe_query_docs_in_window(
        collection_name='job_logs',
        timestamp_field='finished_at',
        window_start=window_start,
        order_desc=True,
        limit=600,
        runtime=app_ctx,
    )

    strict = []
    feature_only = []
    mode_only = []
    for doc in docs:
        row = doc.to_dict() if hasattr(doc, 'to_dict') else {}
        if not isinstance(row, dict):
            continue
        if str(row.get('status', '')).lower() != 'complete':
            continue
        if str(row.get('mode', '')).lower() != mode:
            continue
        duration = row.get('duration_seconds', 0)
        if not isinstance(duration, (int, float)) or duration <= 0:
            continue
        mode_only.append(float(duration))
        if mode in {'lecture-notes', 'slides-only'}:
            row_feature = str(row.get('study_features', 'none') or 'none').strip().lower()
            if row_feature != study_features:
                continue
            feature_only.append(float(duration))
            row_bucket = _estimate_size_bucket(row.get('file_size_mb', 0))
            if requested_bucket != 'unknown' and row_bucket == requested_bucket:
                strict.append(float(duration))
            elif requested_bucket == 'unknown':
                strict.append(float(duration))
        else:
            row_extras = app_ctx.sanitize_int(row.get('interview_features_count', 0), default=0, min_value=0, max_value=4)
            if row_extras != interview_features_count:
                continue
            feature_only.append(float(duration))
            row_bucket = _estimate_size_bucket(row.get('file_size_mb', 0))
            if requested_bucket != 'unknown' and row_bucket == requested_bucket:
                strict.append(float(duration))
            elif requested_bucket == 'unknown':
                strict.append(float(duration))

    source = 'heuristic'
    sample = []
    if len(strict) >= 8:
        sample = strict
        source = 'strict'
    elif len(feature_only) >= 8:
        sample = feature_only
        source = 'feature'
    elif len(mode_only) >= 8:
        sample = mode_only
        source = 'mode'

    if sample:
        sorted_values = sorted(sample)
        low = _duration_percentile(sorted_values, 0.25)
        typical = _duration_percentile(sorted_values, 0.5)
        high = _duration_percentile(sorted_values, 0.75)
        low = max(15, low)
        typical = max(low, typical)
        high = max(typical + 5, high)
    else:
        low, typical, high = _heuristic_estimate_range(mode, total_mb, study_features, interview_features_count)

    return app_ctx.jsonify({
        'mode': mode,
        'range': {
            'low_seconds': int(low),
            'high_seconds': int(high),
            'typical_seconds': int(typical),
        },
        'sample_count': len(sample),
        'source': source,
    })


def processing_averages(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    try:
        docs = (
            app_ctx.db.collection('job_logs')
            .where('status', '==', 'complete')
            .order_by('finished_at', direction=app_ctx.firestore.Query.DESCENDING)
            .limit(200)
            .stream()
        )
        by_mode = defaultdict(list)
        for doc in docs:
            job = doc.to_dict() or {}
            mode = job.get('mode', 'unknown')
            duration = job.get('duration_seconds')
            if isinstance(duration, (int, float)) and duration > 0:
                by_mode[mode].append(duration)

        averages = {}
        total_jobs = 0
        for mode, durations in by_mode.items():
            total_jobs += len(durations)
            avg = round(sum(durations) / len(durations), 1)
            averages[mode] = {
                'avg_seconds': avg,
                'job_count': len(durations),
                'min_seconds': round(min(durations), 1),
                'max_seconds': round(max(durations), 1),
            }

        response = app_ctx.jsonify({'averages': averages, 'total_jobs': total_jobs})
        response.headers['Cache-Control'] = 'private, max-age=300'
        return response
    except Exception:
        app_ctx.logger.warning('Could not load processing averages; returning empty fallback', exc_info=True)
        response = app_ctx.jsonify({'averages': {}, 'total_jobs': 0})
        response.headers['Cache-Control'] = 'no-store'
        return response
