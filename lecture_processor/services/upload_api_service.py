"""Business logic handlers for upload/status/download APIs."""

import json
import zipfile
from datetime import datetime, timezone

from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.admin import metrics as admin_metrics
from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.ai import pipelines as ai_pipelines
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.shared import sanitize_csv_row
from lecture_processor.domains.shared import parsing as shared_parsing
from lecture_processor.domains.study import export as study_export
from lecture_processor.domains.upload import import_audio as upload_import_audio
from lecture_processor.runtime.job_dispatcher import JobQueueFullError
from lecture_processor.services import (
    upload_audio_import_service,
    upload_batch_service,
    upload_batch_support,
    upload_quota_service,
    upload_runtime_service,
    tools_extraction_support,
)


def _sanitize_tools_custom_prompt(raw_prompt, max_chars=6000):
    return tools_extraction_support.sanitize_tools_custom_prompt(raw_prompt, max_chars=max_chars)


def _sanitize_tools_template_key(raw_key, max_chars=80):
    return tools_extraction_support.sanitize_tools_template_key(raw_key, max_chars=max_chars)


def _sanitize_study_pack_title(raw_title, max_chars=120):
    return upload_batch_support.sanitize_study_pack_title(raw_title, max_chars=max_chars)


def _sanitize_tools_source_url(raw_url, max_chars=2000):
    return tools_extraction_support.sanitize_tools_source_url(raw_url, max_chars=max_chars)


def _extract_text_from_html_document(raw_html, max_chars=180000):
    return tools_extraction_support.extract_text_from_html_document(raw_html, max_chars=max_chars)


def _extract_content_charset(content_type):
    return tools_extraction_support.extract_content_charset(content_type)


def _fetch_tools_url_text(source_url, max_bytes=1_500_000, max_chars=180000):
    return tools_extraction_support.fetch_tools_url_text(source_url, max_bytes=max_bytes, max_chars=max_chars)


def _build_tools_prompt(source_type, custom_prompt=''):
    return tools_extraction_support.build_tools_prompt(source_type, custom_prompt=custom_prompt)


def _extract_docx_text(app_ctx, docx_path, max_chars=180000):
    return tools_extraction_support.extract_docx_text(app_ctx, docx_path, max_chars=max_chars)


def _sum_retry_attempts(retry_tracker):
    return tools_extraction_support.sum_retry_attempts(retry_tracker)


def _require_ai_processing_ready(app_ctx):
    return upload_batch_support.require_ai_processing_ready(app_ctx)


def _account_write_guard_response(app_ctx, uid):
    return upload_batch_support.account_write_guard_response(app_ctx, uid)


def _cleanup_upload_files(app_ctx, paths, *, imported_audio_used=False, imported_audio_path=''):
    protected_import_path = str(imported_audio_path or '').strip() if imported_audio_used else ''
    cleanup_paths = []
    for path in paths or []:
        safe_path = str(path or '').strip()
        if not safe_path:
            continue
        if protected_import_path and safe_path == protected_import_path:
            continue
        cleanup_paths.append(safe_path)
    if cleanup_paths:
        app_ctx.cleanup_files(cleanup_paths, [])


def _attempt_credit_refund(app_ctx, uid, credit_type, expected_floor=None):
    return upload_batch_support.attempt_credit_refund(
        app_ctx,
        uid,
        credit_type,
        expected_floor=expected_floor,
    )


def _queue_full_message():
    return upload_batch_support.queue_full_message()


def _queue_full_response(app_ctx, *, job_id='', batch_id=''):
    return upload_batch_support.queue_full_response(app_ctx, job_id=job_id, batch_id=batch_id)


def _handle_runtime_job_queue_full(
    app_ctx,
    *,
    job_id,
    uid,
    cleanup_paths,
    credit_type='',
    expected_credit_floor=None,
    extra_slides_credits=0,
):
    return upload_batch_support.handle_runtime_job_queue_full(
        app_ctx,
        job_id=job_id,
        uid=uid,
        cleanup_paths=cleanup_paths,
        credit_type=credit_type,
        expected_credit_floor=expected_credit_floor,
        extra_slides_credits=extra_slides_credits,
    )


def _handle_runtime_job_setup_failure(
    app_ctx,
    *,
    job_id,
    uid,
    cleanup_paths,
    credit_type='',
    expected_credit_floor=None,
    extra_slides_credits=0,
    error=None,
):
    return upload_batch_support.handle_runtime_job_setup_failure(
        app_ctx,
        job_id=job_id,
        uid=uid,
        cleanup_paths=cleanup_paths,
        credit_type=credit_type,
        expected_credit_floor=expected_credit_floor,
        extra_slides_credits=extra_slides_credits,
        error=error,
    )


def _normalize_tools_markdown_for_export(markdown_text):
    return tools_extraction_support.normalize_tools_markdown_for_export(markdown_text)


def _normalize_export_base_name(raw_title):
    return tools_extraction_support.normalize_export_base_name(raw_title)


def _detect_tools_source_type(app_ctx, uploaded_file, requested_source):
    return tools_extraction_support.detect_tools_source_type(app_ctx, uploaded_file, requested_source)


def import_audio_from_url(app_ctx, request):
    return upload_audio_import_service.import_audio_from_url(app_ctx, request)


def release_imported_audio(app_ctx, request):
    return upload_audio_import_service.release_imported_audio(app_ctx, request)


def _parse_batch_rows_payload(request):
    return upload_batch_support.parse_batch_rows_payload(request)


def _parse_checkbox_value(raw_value):
    return upload_batch_support.parse_checkbox_value(raw_value)


def _batch_user_guard(app_ctx, request):
    return upload_batch_support.batch_user_guard(app_ctx, request)


def _get_batch_with_permission(app_ctx, request, batch_id):
    return upload_batch_support.get_batch_with_permission(
        app_ctx,
        request,
        batch_id,
        batch_orchestrator_module=batch_orchestrator,
    )


def create_batch_job(app_ctx, request):
    return upload_batch_service.create_batch_job(app_ctx, request)


def create_instant_batch_job(app_ctx, request):
    return upload_batch_service.create_instant_batch_job(app_ctx, request)


def list_batch_jobs(app_ctx, request):
    return upload_batch_service.list_batch_jobs(app_ctx, request)


def list_instant_batch_jobs(app_ctx, request):
    return upload_batch_service.list_instant_batch_jobs(app_ctx, request)


def get_batch_job_status(app_ctx, request, batch_id):
    return upload_batch_service.get_batch_job_status(app_ctx, request, batch_id)


def _batch_row_docx_bytes(app_ctx, row, content_type='result'):
    return upload_batch_service.batch_row_docx_bytes(app_ctx, row, content_type=content_type)


def _batch_row_csv_bytes(app_ctx, row, export_type='flashcards'):
    return upload_batch_service.batch_row_csv_bytes(app_ctx, row, export_type=export_type)


def _append_combined_markdown_section(parts, title, content):
    return upload_batch_service.append_combined_markdown_section(parts, title, content)


def _batch_row_flashcards_markdown(row):
    return upload_batch_service.batch_row_flashcards_markdown(row)


def _batch_row_questions_markdown(row):
    return upload_batch_service.batch_row_questions_markdown(row)


def _batch_row_combined_markdown(batch, row):
    return upload_batch_service.batch_row_combined_markdown(batch, row)


def _batch_combined_docx_bytes(app_ctx, batch, rows):
    return upload_batch_service.batch_combined_docx_bytes(app_ctx, batch, rows)


def download_batch_row_docx(app_ctx, request, batch_id, row_id):
    return upload_batch_service.download_batch_row_docx(app_ctx, request, batch_id, row_id)


def download_batch_row_flashcards_csv(app_ctx, request, batch_id, row_id):
    return upload_batch_service.download_batch_row_flashcards_csv(app_ctx, request, batch_id, row_id)


def download_batch_zip(app_ctx, request, batch_id):
    return upload_batch_service.download_batch_zip(app_ctx, request, batch_id)


def upload_files(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not auth_policy.is_email_allowed(email, runtime=app_ctx):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403
    deletion_guard = _account_write_guard_response(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    active_jobs = account_lifecycle.count_active_jobs_for_user(uid, runtime=app_ctx)
    if active_jobs >= app_ctx.MAX_ACTIVE_JOBS_PER_USER:
        analytics_events.log_rate_limit_hit('upload', 10, runtime=app_ctx)
        return app_ctx.jsonify({
            'error': f'You already have {active_jobs} active processing job(s). Please wait for one to finish before starting another.'
        }), 429
    allowed_upload, retry_after = rate_limiter.check_rate_limit(
        key=f"upload:{uid}",
        limit=app_ctx.UPLOAD_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
        runtime=app_ctx,
    )
    if not allowed_upload:
        analytics_events.log_rate_limit_hit('upload', retry_after, runtime=app_ctx)
        return rate_limiter.build_rate_limited_response(
            'Too many upload attempts right now. Please wait and try again.',
            retry_after,
            runtime=app_ctx,
        )
    quota_reservation, quota_response, quota_status = upload_quota_service.reserve_upload_quota(
        app_ctx,
        uid,
        upload_quota_service.request_content_length(request),
        context='Upload',
    )
    if quota_response is not None:
        return quota_response, quota_status
    actual_upload_bytes = 0
    try:
        user = app_ctx.get_or_create_user(uid, email)
        mode = request.form.get('mode', 'lecture-notes')
        study_pack_title = _sanitize_study_pack_title(request.form.get('study_pack_title', ''))
        if mode in {'lecture-notes', 'slides-only', 'interview'} and not study_pack_title:
            return app_ctx.jsonify({'error': 'Lecture Topic / Name is required.'}), 400
        flashcard_selection = shared_parsing.parse_requested_amount(
            request.form.get('flashcard_amount', '20'),
            {'10', '20', '30', 'auto'},
            '20',
            runtime=app_ctx,
        )
        question_selection = shared_parsing.parse_requested_amount(
            request.form.get('question_amount', '10'),
            {'5', '10', '15', 'auto'},
            '10',
            runtime=app_ctx,
        )
        preferred_language_key = shared_parsing.sanitize_output_language_pref_key(
            user.get('preferred_output_language', app_ctx.DEFAULT_OUTPUT_LANGUAGE_KEY),
            runtime=app_ctx,
        )
        preferred_language_custom = shared_parsing.sanitize_output_language_pref_custom(
            user.get('preferred_output_language_custom', ''),
            runtime=app_ctx,
        )
        output_language = shared_parsing.parse_output_language(
            request.form.get('output_language', preferred_language_key),
            request.form.get('output_language_custom', preferred_language_custom),
            runtime=app_ctx,
        )
        study_features = shared_parsing.parse_study_features(request.form.get('study_features', 'none'), runtime=app_ctx)
        interview_features = shared_parsing.parse_interview_features(request.form.get('interview_features', 'none'), runtime=app_ctx)
        audio_import_token = str(request.form.get('audio_import_token', '') or '').strip()
        upload_import_audio.cleanup_expired_audio_import_tokens(runtime=app_ctx)
        if request.content_length and request.content_length > app_ctx.MAX_CONTENT_LENGTH:
            return app_ctx.jsonify({'error': 'Upload too large. Maximum total upload size is 560MB (up to 50MB slides file (PDF/PPTX) and 500MB audio).'}), 413

        if mode == 'lecture-notes':
            if not billing_credits.has_category_credit(user, 'lecture', runtime=app_ctx):
                return app_ctx.jsonify({'error': 'No lecture credits remaining. Please purchase more credits.'}), 402
            if 'pdf' not in request.files:
                return app_ctx.jsonify({'error': 'Both slides (PDF/PPTX) and audio files are required'}), 400
            slides_file = request.files['pdf']
            uploaded_audio_file = request.files.get('audio')
            has_uploaded_audio = bool(uploaded_audio_file and uploaded_audio_file.filename)
            has_imported_audio = bool(audio_import_token)
            if not has_uploaded_audio and not has_imported_audio:
                return app_ctx.jsonify({'error': 'Both slides (PDF/PPTX) and audio files are required'}), 400
            if slides_file.filename == '':
                return app_ctx.jsonify({'error': 'Both files must be selected'}), 400
            job_id = str(app_ctx.uuid.uuid4())
            pdf_path, slides_error = app_ctx.resolve_uploaded_slides_to_pdf(slides_file, job_id)
            if slides_error:
                return app_ctx.jsonify({'error': slides_error}), 400
            pdf_size = app_ctx.get_saved_file_size(pdf_path)

            imported_audio_used = False
            audio_path = ''
            if has_uploaded_audio:
                if not app_ctx.allowed_file(uploaded_audio_file.filename, app_ctx.ALLOWED_AUDIO_EXTENSIONS):
                    app_ctx.cleanup_files([pdf_path], [])
                    return app_ctx.jsonify({'error': 'Invalid audio file'}), 400
                if (uploaded_audio_file.mimetype or '').lower() not in app_ctx.ALLOWED_AUDIO_MIME_TYPES:
                    app_ctx.cleanup_files([pdf_path], [])
                    return app_ctx.jsonify({'error': 'Invalid audio content type'}), 400
                audio_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f"{job_id}_{app_ctx.secure_filename(uploaded_audio_file.filename)}")
                uploaded_audio_file.save(audio_path)
                if has_imported_audio:
                    upload_import_audio.release_audio_import_token(uid, audio_import_token, runtime=app_ctx)
            else:
                audio_path, token_error = upload_import_audio.get_audio_import_token_path(
                    uid,
                    audio_import_token,
                    consume=False,
                    runtime=app_ctx,
                )
                if token_error:
                    app_ctx.cleanup_files([pdf_path], [])
                    return app_ctx.jsonify({'error': token_error}), 400
                imported_audio_used = True

            audio_size = app_ctx.get_saved_file_size(audio_path)
            if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
                if imported_audio_used:
                    upload_import_audio.release_audio_import_token(uid, audio_import_token, runtime=app_ctx)
                _cleanup_upload_files(app_ctx, [pdf_path, audio_path])
                return app_ctx.jsonify({'error': 'Audio exceeds server limit (max 500MB) or is empty.'}), 400
            if not app_ctx.file_looks_like_audio(audio_path):
                if imported_audio_used:
                    upload_import_audio.release_audio_import_token(uid, audio_import_token, runtime=app_ctx)
                _cleanup_upload_files(app_ctx, [pdf_path, audio_path])
                return app_ctx.jsonify({'error': 'Uploaded audio file is invalid or unsupported.'}), 400
            chargeable_audio_size = (
                upload_quota_service.chargeable_import_token_bytes(app_ctx, uid, audio_import_token, audio_size)
                if imported_audio_used else audio_size
            )
            actual_upload_bytes = max(0, int(pdf_size if pdf_size > 0 else 0)) + chargeable_audio_size
            quota_error, quota_error_status = upload_quota_service.adjust_reserved_upload_bytes(
                app_ctx,
                quota_reservation,
                actual_upload_bytes,
                context='Upload',
            )
            if quota_error is not None:
                _cleanup_upload_files(app_ctx, [pdf_path, audio_path], imported_audio_used=imported_audio_used, imported_audio_path=audio_path)
                return quota_error, quota_error_status
            ai_unavailable = _require_ai_processing_ready(app_ctx)
            if ai_unavailable is not None:
                _cleanup_upload_files(app_ctx, [pdf_path, audio_path], imported_audio_used=imported_audio_used, imported_audio_path=audio_path)
                return ai_unavailable
            deducted = billing_credits.deduct_credit(
                uid,
                'lecture_credits_standard',
                'lecture_credits_extended',
                runtime=app_ctx,
            )
            if not deducted:
                _cleanup_upload_files(app_ctx, [pdf_path, audio_path], imported_audio_used=imported_audio_used, imported_audio_path=audio_path)
                return app_ctx.jsonify({'error': 'No lecture credits remaining.'}), 402
            if imported_audio_used:
                _consumed_path, token_error = upload_import_audio.get_audio_import_token_path(
                    uid,
                    audio_import_token,
                    consume=True,
                    runtime=app_ctx,
                )
                if token_error:
                    app_ctx.cleanup_files([pdf_path, audio_path], [])
                    billing_credits.refund_credit(uid, deducted, runtime=app_ctx)
                    return app_ctx.jsonify({'error': token_error}), 400
            total_steps = 4 if study_features != 'none' else 3
            try:
                runtime_jobs_store.set_job(job_id, {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': total_steps, 'mode': 'lecture-notes', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': app_ctx.time.time(), 'result': None, 'slide_text': None, 'transcript': None, 'flashcard_selection': flashcard_selection, 'question_selection': question_selection, 'study_features': study_features, 'output_language': output_language, 'flashcards': [], 'test_questions': [], 'study_generation_error': None, 'study_pack_id': None, 'study_pack_title': study_pack_title, 'error': None, 'failed_stage': '', 'provider_error_code': '', 'retry_attempts': 0, 'file_size_mb': round(((pdf_size if pdf_size > 0 else 0) + audio_size) / (1024 * 1024), 2), 'billing_receipt': billing_receipts.initialize_billing_receipt({deducted: 1}, runtime=app_ctx)}, runtime=app_ctx)
                app_ctx.submit_background_job(
                    ai_pipelines.process_lecture_notes,
                    job_id,
                    pdf_path,
                    audio_path,
                    runtime=app_ctx,
                )
            except JobQueueFullError:
                return _handle_runtime_job_queue_full(
                    app_ctx,
                    job_id=job_id,
                    uid=uid,
                    cleanup_paths=[pdf_path, audio_path],
                    credit_type=deducted,
                )
            except Exception as error:
                return _handle_runtime_job_setup_failure(
                    app_ctx,
                    job_id=job_id,
                    uid=uid,
                    cleanup_paths=[pdf_path, audio_path],
                    credit_type=deducted,
                    error=error,
                )

        elif mode == 'slides-only':
            if not billing_credits.has_category_credit(user, 'slides', runtime=app_ctx):
                return app_ctx.jsonify({'error': 'No text extraction credits remaining. Please purchase more credits.'}), 402
            if 'pdf' not in request.files:
                return app_ctx.jsonify({'error': 'Slide file (PDF or PPTX) is required'}), 400
            slides_file = request.files['pdf']
            if slides_file.filename == '':
                return app_ctx.jsonify({'error': 'Slide file must be selected'}), 400
            job_id = str(app_ctx.uuid.uuid4())
            pdf_path, slides_error = app_ctx.resolve_uploaded_slides_to_pdf(slides_file, job_id)
            if slides_error:
                return app_ctx.jsonify({'error': slides_error}), 400
            pdf_size = app_ctx.get_saved_file_size(pdf_path)
            actual_upload_bytes = max(0, int(pdf_size if pdf_size > 0 else 0))
            quota_error, quota_error_status = upload_quota_service.adjust_reserved_upload_bytes(
                app_ctx,
                quota_reservation,
                actual_upload_bytes,
                context='Upload',
            )
            if quota_error is not None:
                app_ctx.cleanup_files([pdf_path], [])
                return quota_error, quota_error_status
            ai_unavailable = _require_ai_processing_ready(app_ctx)
            if ai_unavailable is not None:
                app_ctx.cleanup_files([pdf_path], [])
                return ai_unavailable
            deducted = billing_credits.deduct_credit(uid, 'slides_credits', runtime=app_ctx)
            if not deducted:
                app_ctx.cleanup_files([pdf_path], [])
                return app_ctx.jsonify({'error': 'No text extraction credits remaining.'}), 402
            total_steps = 2 if study_features != 'none' else 1
            try:
                runtime_jobs_store.set_job(job_id, {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': total_steps, 'mode': 'slides-only', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': app_ctx.time.time(), 'result': None, 'flashcard_selection': flashcard_selection, 'question_selection': question_selection, 'study_features': study_features, 'output_language': output_language, 'flashcards': [], 'test_questions': [], 'study_generation_error': None, 'study_pack_id': None, 'study_pack_title': study_pack_title, 'error': None, 'failed_stage': '', 'provider_error_code': '', 'retry_attempts': 0, 'file_size_mb': round((pdf_size if pdf_size > 0 else 0) / (1024 * 1024), 2), 'billing_receipt': billing_receipts.initialize_billing_receipt({deducted: 1}, runtime=app_ctx)}, runtime=app_ctx)
                app_ctx.submit_background_job(
                    ai_pipelines.process_slides_only,
                    job_id,
                    pdf_path,
                    runtime=app_ctx,
                )
            except JobQueueFullError:
                return _handle_runtime_job_queue_full(
                    app_ctx,
                    job_id=job_id,
                    uid=uid,
                    cleanup_paths=[pdf_path],
                    credit_type=deducted,
                    expected_credit_floor=int(user.get('slides_credits', 0) or 0),
                )
            except Exception as error:
                return _handle_runtime_job_setup_failure(
                    app_ctx,
                    job_id=job_id,
                    uid=uid,
                    cleanup_paths=[pdf_path],
                    credit_type=deducted,
                    expected_credit_floor=int(user.get('slides_credits', 0) or 0),
                    error=error,
                )

        elif mode == 'interview':
            if not billing_credits.has_category_credit(user, 'interview', runtime=app_ctx):
                return app_ctx.jsonify({'error': 'No interview credits remaining. Please purchase more credits.'}), 402
            uploaded_audio_file = request.files.get('audio')
            has_uploaded_audio = bool(uploaded_audio_file and uploaded_audio_file.filename)
            has_imported_audio = bool(audio_import_token)
            if not has_uploaded_audio and not has_imported_audio:
                return app_ctx.jsonify({'error': 'Audio file is required'}), 400
            job_id = str(app_ctx.uuid.uuid4())
            imported_audio_used = False
            if has_uploaded_audio:
                if not app_ctx.allowed_file(uploaded_audio_file.filename, app_ctx.ALLOWED_AUDIO_EXTENSIONS):
                    return app_ctx.jsonify({'error': 'Invalid audio file'}), 400
                if (uploaded_audio_file.mimetype or '').lower() not in app_ctx.ALLOWED_AUDIO_MIME_TYPES:
                    return app_ctx.jsonify({'error': 'Invalid audio content type'}), 400
                audio_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f"{job_id}_{app_ctx.secure_filename(uploaded_audio_file.filename)}")
                uploaded_audio_file.save(audio_path)
                if has_imported_audio:
                    upload_import_audio.release_audio_import_token(uid, audio_import_token, runtime=app_ctx)
            else:
                audio_path, token_error = upload_import_audio.get_audio_import_token_path(
                    uid,
                    audio_import_token,
                    consume=False,
                    runtime=app_ctx,
                )
                if token_error:
                    return app_ctx.jsonify({'error': token_error}), 400
                imported_audio_used = True

            audio_size = app_ctx.get_saved_file_size(audio_path)
            if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
                if imported_audio_used:
                    upload_import_audio.release_audio_import_token(uid, audio_import_token, runtime=app_ctx)
                _cleanup_upload_files(app_ctx, [audio_path])
                return app_ctx.jsonify({'error': 'Audio exceeds server limit (max 500MB) or is empty.'}), 400
            if not app_ctx.file_looks_like_audio(audio_path):
                if imported_audio_used:
                    upload_import_audio.release_audio_import_token(uid, audio_import_token, runtime=app_ctx)
                _cleanup_upload_files(app_ctx, [audio_path])
                return app_ctx.jsonify({'error': 'Uploaded audio file is invalid or unsupported.'}), 400
            actual_upload_bytes = (
                upload_quota_service.chargeable_import_token_bytes(app_ctx, uid, audio_import_token, audio_size)
                if imported_audio_used else audio_size
            )
            quota_error, quota_error_status = upload_quota_service.adjust_reserved_upload_bytes(
                app_ctx,
                quota_reservation,
                actual_upload_bytes,
                context='Upload',
            )
            if quota_error is not None:
                _cleanup_upload_files(app_ctx, [audio_path], imported_audio_used=imported_audio_used, imported_audio_path=audio_path)
                return quota_error, quota_error_status
            ai_unavailable = _require_ai_processing_ready(app_ctx)
            if ai_unavailable is not None:
                _cleanup_upload_files(app_ctx, [audio_path], imported_audio_used=imported_audio_used, imported_audio_path=audio_path)
                return ai_unavailable
            deducted = billing_credits.deduct_interview_credit(uid, runtime=app_ctx)
            if not deducted:
                _cleanup_upload_files(app_ctx, [audio_path], imported_audio_used=imported_audio_used, imported_audio_path=audio_path)
                return app_ctx.jsonify({'error': 'No interview credits remaining.'}), 402
            interview_features_cost = len(interview_features)
            if interview_features_cost > 0:
                if not billing_credits.has_category_credit(user, 'slides', interview_features_cost, runtime=app_ctx):
                    billing_credits.refund_credit(uid, deducted, runtime=app_ctx)
                    _cleanup_upload_files(app_ctx, [audio_path], imported_audio_used=imported_audio_used, imported_audio_path=audio_path)
                    return app_ctx.jsonify({'error': f'Not enough text extraction credits for interview extras. You selected {interview_features_cost} option(s) and need {interview_features_cost} text extraction credits.'}), 402
                if not billing_credits.deduct_slides_credits(uid, interview_features_cost, runtime=app_ctx):
                    billing_credits.refund_credit(uid, deducted, runtime=app_ctx)
                    _cleanup_upload_files(app_ctx, [audio_path], imported_audio_used=imported_audio_used, imported_audio_path=audio_path)
                    return app_ctx.jsonify({'error': 'Could not reserve text extraction credits for interview extras. Please try again.'}), 402
            if imported_audio_used:
                _consumed_path, token_error = upload_import_audio.get_audio_import_token_path(
                    uid,
                    audio_import_token,
                    consume=True,
                    runtime=app_ctx,
                )
                if token_error:
                    app_ctx.cleanup_files([audio_path], [])
                    billing_credits.refund_credit(uid, deducted, runtime=app_ctx)
                    if interview_features_cost > 0:
                        billing_credits.refund_slides_credits(uid, interview_features_cost, runtime=app_ctx)
                    return app_ctx.jsonify({'error': token_error}), 400
            total_steps = 2 if interview_features_cost > 0 else 1
            try:
                runtime_jobs_store.set_job(job_id, {
                    'status': 'starting',
                    'step': 0,
                    'step_description': 'Starting...',
                    'total_steps': total_steps,
                    'mode': 'interview',
                    'user_id': uid,
                    'user_email': email,
                    'credit_deducted': deducted,
                    'credit_refunded': False,
                    'started_at': app_ctx.time.time(),
                    'result': None,
                    'study_pack_title': study_pack_title,
                    'transcript': None,
                    'flashcards': [],
                    'test_questions': [],
                    'study_features': 'none',
                    'output_language': output_language,
                    'interview_features': interview_features,
                    'interview_features_cost': interview_features_cost,
                    'interview_features_successful': [],
                    'interview_summary': None,
                    'interview_sections': None,
                    'interview_combined': None,
                    'extra_slides_refunded': 0,
                    'study_generation_error': None,
                    'error': None,
                    'failed_stage': '',
                    'provider_error_code': '',
                    'retry_attempts': 0,
                    'file_size_mb': round(audio_size / (1024 * 1024), 2),
                    'billing_receipt': billing_receipts.initialize_billing_receipt({deducted: 1, 'slides_credits': interview_features_cost}, runtime=app_ctx),
                }, runtime=app_ctx)
                app_ctx.submit_background_job(
                    ai_pipelines.process_interview_transcription,
                    job_id,
                    audio_path,
                    runtime=app_ctx,
                )
            except JobQueueFullError:
                return _handle_runtime_job_queue_full(
                    app_ctx,
                    job_id=job_id,
                    uid=uid,
                    cleanup_paths=[audio_path],
                    credit_type=deducted,
                    extra_slides_credits=interview_features_cost,
                )
            except Exception as error:
                return _handle_runtime_job_setup_failure(
                    app_ctx,
                    job_id=job_id,
                    uid=uid,
                    cleanup_paths=[audio_path],
                    credit_type=deducted,
                    extra_slides_credits=interview_features_cost,
                    error=error,
                )
        else:
            return app_ctx.jsonify({'error': 'Invalid mode selected'}), 400

        upload_quota_service.commit_upload_quota(quota_reservation)
        created_job = runtime_jobs_store.get_job_snapshot(job_id, runtime=app_ctx) or {}
        analytics_events.log_analytics_event(
            'processing_started_backend',
            source='backend',
            uid=uid,
            email=email,
            session_id=job_id,
            properties={
                'job_id': job_id,
                'mode': created_job.get('mode', mode),
                'study_features': created_job.get('study_features', 'none'),
                'interview_features_count': len(created_job.get('interview_features', [])) if isinstance(created_job.get('interview_features'), list) else 0,
            },
            created_at=created_job.get('started_at', app_ctx.time.time()),
            runtime=app_ctx,
        )
        return app_ctx.jsonify({'job_id': job_id})
    finally:
        upload_quota_service.release_uncommitted_upload_quota(app_ctx, quota_reservation)


def tools_extract(app_ctx, request):
    from lecture_processor.services import tools_extraction_service

    return tools_extraction_service.tools_extract(app_ctx, request)


def tools_lecture_download(app_ctx, request):
    from lecture_processor.services import tools_download_service

    return tools_download_service.download_lecture_media(app_ctx, request)


def tools_transcribe(app_ctx, request):
    from lecture_processor.services import tools_transcription_service

    return tools_transcription_service.create_general_transcription(app_ctx, request)


def tools_export(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not auth_policy.is_email_allowed(email, runtime=app_ctx):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403

    payload = request.get_json(silent=True) or {}
    export_format = str(payload.get('format', 'docx') or '').strip().lower()
    markdown = str(payload.get('content_markdown') or payload.get('output_text') or '').strip()
    title = str(payload.get('title', 'Tools Extract') or '').strip()

    if export_format != 'docx':
        return app_ctx.jsonify({'error': 'Unsupported export format.'}), 400
    if not markdown:
        return app_ctx.jsonify({'error': 'No extracted content to export.'}), 400
    if len(markdown) > 800000:
        return app_ctx.jsonify({'error': 'Export content is too large. Please shorten the result and retry.'}), 400

    export_markdown = _normalize_tools_markdown_for_export(markdown)
    doc = study_export.markdown_to_docx(export_markdown, title or 'Tools Extract', runtime=app_ctx)
    docx_io = app_ctx.io.BytesIO()
    doc.save(docx_io)
    docx_io.seek(0)
    base_name = _normalize_export_base_name(title)

    analytics_events.log_analytics_event(
        'tools_export_requested',
        source='backend',
        uid=uid,
        email=email,
        session_id=app_ctx.uuid.uuid4().hex,
        properties={'format': export_format},
        runtime=app_ctx,
    )
    return app_ctx.send_file(
        docx_io,
        as_attachment=True,
        download_name=f'{base_name}.docx',
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    )


def get_status(app_ctx, request, job_id):
    return upload_runtime_service.get_status(app_ctx, request, job_id)


def _is_active_regular_runtime_job(job, uid):
    return upload_runtime_service._is_active_regular_runtime_job(job, uid)


def _serialize_active_runtime_job(job_id, job):
    return upload_runtime_service._serialize_active_runtime_job(job_id, job)


def get_active_runtime_jobs(app_ctx, request):
    return upload_runtime_service.get_active_runtime_jobs(app_ctx, request)


def download_docx(app_ctx, request, job_id):
    return upload_runtime_service.download_docx(app_ctx, request, job_id)


def download_flashcards_csv(app_ctx, request, job_id):
    return upload_runtime_service.download_flashcards_csv(app_ctx, request, job_id)


def _estimate_size_bucket(total_mb):
    return upload_runtime_service._estimate_size_bucket(total_mb)


def _duration_percentile(sorted_values, percentile):
    return upload_runtime_service._duration_percentile(sorted_values, percentile)


def _heuristic_estimate_range(mode, total_mb, study_features, interview_features_count):
    return upload_runtime_service._heuristic_estimate_range(
        mode,
        total_mb,
        study_features,
        interview_features_count,
    )


def processing_estimate(app_ctx, request):
    return upload_runtime_service.processing_estimate(app_ctx, request)


def processing_averages(app_ctx, request):
    return upload_runtime_service.processing_averages(app_ctx, request)
