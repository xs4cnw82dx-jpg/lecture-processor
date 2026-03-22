"""Background transcription flow for the general transcriber tool."""

from __future__ import annotations

from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.shared import parsing as shared_parsing
from lecture_processor.runtime.job_dispatcher import JobQueueFullError

from lecture_processor.services import upload_batch_support


def _is_email_allowed(app_ctx, email: str) -> bool:
    checker = getattr(app_ctx, 'is_email_allowed', None)
    if callable(checker):
        try:
            return bool(checker(email))
        except TypeError:
            return bool(checker(email, runtime=app_ctx))
    return auth_policy.is_email_allowed(email, runtime=app_ctx)


def _account_write_guard_response(app_ctx, uid):
    return upload_batch_support.account_write_guard_response(app_ctx, uid)


def _require_ai_processing_ready(app_ctx):
    return upload_batch_support.require_ai_processing_ready(app_ctx)


def _handle_runtime_job_queue_full(
    app_ctx,
    *,
    job_id,
    uid,
    cleanup_paths,
    credit_type='',
):
    return upload_batch_support.handle_runtime_job_queue_full(
        app_ctx,
        job_id=job_id,
        uid=uid,
        cleanup_paths=cleanup_paths,
        credit_type=credit_type,
    )


def _total_interview_credits(user):
    if not isinstance(user, dict):
        return 0
    return (
        int(user.get('interview_credits_short', 0) or 0)
        + int(user.get('interview_credits_medium', 0) or 0)
        + int(user.get('interview_credits_long', 0) or 0)
    )


def create_general_transcription(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not _is_email_allowed(app_ctx, email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403
    deletion_guard = _account_write_guard_response(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard

    allowed, retry_after = rate_limiter.check_rate_limit(
        key=f"tools_transcribe:{rate_limiter.normalize_rate_limit_key_part(uid, fallback='anon_uid', runtime=app_ctx)}",
        limit=app_ctx.TOOLS_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.TOOLS_RATE_LIMIT_WINDOW_SECONDS,
        runtime=app_ctx,
    )
    if not allowed:
        return rate_limiter.build_rate_limited_response(
            'Too many transcription attempts right now. Please wait and try again.',
            retry_after,
            runtime=app_ctx,
        )

    user = app_ctx.get_or_create_user(uid, email)
    if _total_interview_credits(user) <= 0:
        return app_ctx.jsonify({'error': 'No interview credits remaining. Please purchase more credits.'}), 402

    uploaded_audio_file = request.files.get('audio')
    if not uploaded_audio_file or not str(uploaded_audio_file.filename or '').strip():
        return app_ctx.jsonify({'error': 'Please choose an audio file before transcribing.'}), 400
    if not app_ctx.allowed_file(uploaded_audio_file.filename, app_ctx.ALLOWED_AUDIO_EXTENSIONS):
        return app_ctx.jsonify({'error': 'Invalid audio file'}), 400
    if str(getattr(uploaded_audio_file, 'mimetype', '') or '').lower() not in app_ctx.ALLOWED_AUDIO_MIME_TYPES:
        return app_ctx.jsonify({'error': 'Invalid audio content type'}), 400

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

    job_id = str(app_ctx.uuid.uuid4())
    original_name = app_ctx.secure_filename(uploaded_audio_file.filename)
    audio_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f"{job_id}_{original_name}")
    uploaded_audio_file.save(audio_path)

    audio_size = app_ctx.get_saved_file_size(audio_path)
    if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
        app_ctx.cleanup_files([audio_path], [])
        return app_ctx.jsonify({'error': 'Audio exceeds server limit (max 500MB) or is empty.'}), 400
    if not app_ctx.file_looks_like_audio(audio_path):
        app_ctx.cleanup_files([audio_path], [])
        return app_ctx.jsonify({'error': 'Uploaded audio file is invalid or unsupported.'}), 400

    ai_unavailable = _require_ai_processing_ready(app_ctx)
    if ai_unavailable is not None:
        app_ctx.cleanup_files([audio_path], [])
        return ai_unavailable

    deducted_credit = billing_credits.deduct_interview_credit(uid, runtime=app_ctx)
    if not deducted_credit:
        app_ctx.cleanup_files([audio_path], [])
        return app_ctx.jsonify({'error': 'No interview credits remaining.'}), 402

    runtime_jobs_store.set_job(
        job_id,
        {
            'status': 'queued',
            'step': 0,
            'step_description': 'Queued…',
            'total_steps': 1,
            'mode': 'tools-transcription',
            'job_scope': 'tools',
            'tool_source_type': 'audio',
            'tool_input_name': original_name,
            'user_id': uid,
            'user_email': email,
            'credit_deducted': deducted_credit,
            'credit_refunded': False,
            'started_at': app_ctx.time.time(),
            'finished_at': 0,
            'result': None,
            'transcript': None,
            'output_language': output_language,
            'error': '',
            'failed_stage': '',
            'provider_error_code': '',
            'retry_attempts': 0,
            'billing_receipt': billing_receipts.initialize_billing_receipt({deducted_credit: 1}, runtime=app_ctx),
        },
        runtime=app_ctx,
    )

    try:
        app_ctx.submit_background_job(
            _run_general_transcription_job,
            app_ctx,
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
            credit_type=deducted_credit,
        )

    return app_ctx.jsonify({'ok': True, 'job_id': job_id, 'status': 'queued'}), 202


def _run_general_transcription_job(app_ctx, job_id: str, audio_path: str, runtime=None):
    _ = runtime
    gemini_files = []
    local_paths = [audio_path]
    set_fields = lambda **fields: runtime_jobs_store.update_job_fields(job_id, runtime=app_ctx, **fields)
    get_fields = lambda: runtime_jobs_store.get_job_snapshot(job_id, runtime=app_ctx) or {}
    tokens = ai_provider.TokenAccumulator(runtime=app_ctx)
    retry_tracker = {}
    failed_stage = 'initialization'

    try:
        set_fields(status='processing', step=1, step_description='Preparing audio…')

        converted_audio_path, converted = app_ctx.convert_audio_to_mp3_with_ytdlp(audio_path)
        if converted and converted_audio_path not in local_paths:
            local_paths.append(converted_audio_path)

        audio_mime_type = app_ctx.get_mime_type(converted_audio_path)
        failed_stage = 'audio_upload'
        audio_file = ai_provider.run_with_provider_retry(
            'general_audio_upload',
            lambda: app_ctx.client.files.upload(file=converted_audio_path, config={'mime_type': audio_mime_type}),
            retry_tracker=retry_tracker,
            runtime=app_ctx,
        )
        gemini_files.append(audio_file)

        set_fields(step_description='Processing audio file…')
        failed_stage = 'audio_file_processing'
        ai_provider.run_with_provider_retry(
            'general_audio_file_processing',
            lambda: app_ctx.wait_for_file_processing(audio_file),
            retry_tracker=retry_tracker,
            runtime=app_ctx,
        )

        set_fields(step_description='Generating transcript…')
        failed_stage = 'audio_transcription'
        output_language = get_fields().get('output_language', 'English')
        transcript_text, usage = app_ctx.transcribe_audio_plain(
            audio_file,
            audio_mime_type,
            output_language=output_language,
            retry_tracker=retry_tracker,
            include_usage=True,
        )
        if not str(transcript_text or '').strip():
            raise ValueError('Transcript generation returned empty output.')
        tokens.record_usage(
            'audio_transcription',
            usage,
            model=app_ctx.MODEL_AUDIO,
            billing_mode='standard',
            input_modality='audio',
        )
        set_fields(
            status='complete',
            step=1,
            step_description='Complete!',
            transcript=transcript_text,
            result=transcript_text,
        )
    except Exception as error:
        app_ctx.logger.exception('General transcription failed for job %s', job_id)
        set_fields(
            status='error',
            error=app_ctx.PROCESSING_PUBLIC_ERROR_MESSAGE,
            failed_stage=failed_stage,
            retry_attempts=sum((int(v or 0) for v in retry_tracker.values())),
            provider_error_code=ai_provider.classify_provider_error_code(error, runtime=app_ctx),
        )

        failed_job = get_fields()
        uid = failed_job.get('user_id')
        credit_type = failed_job.get('credit_deducted')
        if credit_type:
            billing_credits.refund_credit(uid, credit_type, runtime=app_ctx)
            failed_job = get_fields()
            billing_receipts.add_job_credit_refund(failed_job, credit_type, 1, runtime=app_ctx)
            failed_job['credit_refunded'] = True
            runtime_jobs_store.set_job(job_id, failed_job, runtime=app_ctx)
    finally:
        app_ctx.cleanup_files(local_paths, gemini_files)
        finished_at = app_ctx.time.time()
        set_fields(
            finished_at=finished_at,
            retry_attempts=sum((int(v or 0) for v in retry_tracker.values())),
            **tokens.as_dict(),
        )
        final_job = get_fields()
        app_ctx.save_job_log(job_id, final_job, finished_at)
