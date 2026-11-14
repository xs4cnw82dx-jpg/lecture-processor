"""Runtime status and download handlers for upload-related APIs."""

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.runtime_jobs import recovery as runtime_job_recovery
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.shared import sanitize_csv_row
from lecture_processor.domains.study import export as study_export
from lecture_processor.services import admin_support


def _require_admin_bypass(app_ctx, request):
    return admin_support.require_admin(app_ctx, request)


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
    if job.get('user_id', '') != uid:
        _admin_token, error_response, status = _require_admin_bypass(app_ctx, request)
        if error_response is not None:
            return error_response, status
    if (getattr(app_ctx, 'RUNTIME_JOB_RECOVERY_ENABLED', False)
            and runtime_job_recovery._runtime_job_is_stale(job, now_ts=app_ctx.time.time(), runtime=app_ctx)):
        if runtime_job_recovery.recover_runtime_job_if_stale(job_id, runtime=app_ctx):
            job = runtime_jobs_store.get_job_snapshot(job_id, runtime=app_ctx) or job
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
        if str(job.get('job_scope', '') or '').strip().lower() == 'tools':
            response['output_text'] = job.get('result') or ''
            response['content_markdown'] = job.get('result') or ''
            response['source_type'] = job.get('tool_source_type', '')
            response['file_name'] = job.get('tool_input_name', '')
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
        if job.get('mode') == 'voice-note':
            response['transcript'] = job.get('transcript')
            response['title'] = job.get('study_pack_title')
            response['tags'] = job.get('voice_note_tags', [])
        if job.get('mode') == 'physio-transcription':
            response['transcript'] = job.get('transcript')
    elif job['status'] == 'error':
        response['error'] = job['error']
        response['credit_refunded'] = bool(job.get('credit_refunded', False)) or billing_receipts.job_has_refunds(job, runtime=app_ctx)
    return app_ctx.jsonify(response)


def _is_active_regular_runtime_job(job, uid):
    if not isinstance(job, dict):
        return False
    if str(job.get('user_id', '') or '').strip() != uid:
        return False
    status = str(job.get('status', '') or '').strip().lower()
    if status not in account_lifecycle.ACTIVE_ACCOUNT_JOB_STATES:
        return False
    if str(job.get('job_scope', '') or '').strip().lower() == 'tools':
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
            runtime_docs = app_ctx.repositories.runtime_jobs.query_by_user_and_statuses(
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
    if job.get('user_id', '') != uid:
        _admin_token, error_response, status = _require_admin_bypass(app_ctx, request)
        if error_response is not None:
            return error_response, status
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
    if job.get('user_id', '') != uid:
        _admin_token, error_response, status = _require_admin_bypass(app_ctx, request)
        if error_response is not None:
            return error_response, status
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
