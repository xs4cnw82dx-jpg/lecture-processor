"""Mobile PWA voice-note APIs."""

from __future__ import annotations

import json

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.ai import pipelines as ai_pipelines
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.shared import parsing as shared_parsing
from lecture_processor.runtime.job_dispatcher import JobQueueFullError
from lecture_processor.services import access_service, upload_batch_support, upload_quota_service


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
    extra_slides_credits=0,
):
    return upload_batch_support.handle_runtime_job_queue_full(
        app_ctx,
        job_id=job_id,
        uid=uid,
        cleanup_paths=cleanup_paths,
        credit_type=credit_type,
        extra_slides_credits=extra_slides_credits,
    )


def _handle_runtime_job_setup_failure(
    app_ctx,
    *,
    job_id,
    uid,
    cleanup_paths,
    credit_type='',
    extra_slides_credits=0,
    error=None,
):
    return upload_batch_support.handle_runtime_job_setup_failure(
        app_ctx,
        job_id=job_id,
        uid=uid,
        cleanup_paths=cleanup_paths,
        credit_type=credit_type,
        extra_slides_credits=extra_slides_credits,
        error=error,
    )


def _parse_bool(raw_value):
    value = str(raw_value or '').strip().lower()
    return value in {'1', 'true', 'yes', 'on'}


def sanitize_voice_note_tags(raw_value, max_tags=12, max_chars=32):
    if raw_value is None:
        return []
    if isinstance(raw_value, list):
        parts = raw_value
    else:
        text = str(raw_value or '').strip()
        if text.startswith('['):
            try:
                parsed = json.loads(text)
                parts = parsed if isinstance(parsed, list) else [text]
            except Exception:
                parts = [text]
        else:
            parts = text.split(',')
    cleaned = []
    seen = set()
    for part in parts:
        tag = ' '.join(str(part or '').strip().split())[:max_chars]
        if not tag:
            continue
        key = tag.lower()
        if key in seen:
            continue
        seen.add(key)
        cleaned.append(tag)
        if len(cleaned) >= max_tags:
            break
    return cleaned


def _normalize_audio_mime(raw_value):
    return str(raw_value or '').split(';', 1)[0].strip().lower()


def _resolve_folder(app_ctx, uid, folder_id):
    safe_folder_id = str(folder_id or '').strip()
    if not safe_folder_id:
        return ('', '')
    folder_doc = app_ctx.study_repo.get_study_folder_doc(app_ctx.db, safe_folder_id)
    if not getattr(folder_doc, 'exists', False):
        raise ValueError('Folder not found')
    folder = folder_doc.to_dict() or {}
    if str(folder.get('uid', '') or '').strip() != uid:
        raise PermissionError('Forbidden')
    return (safe_folder_id, str(folder.get('name', '') or '').strip()[:120])


def _resolve_output_language(app_ctx, request, user):
    preferred_language_key = shared_parsing.sanitize_output_language_pref_key(
        user.get('preferred_output_language', app_ctx.DEFAULT_OUTPUT_LANGUAGE_KEY),
        runtime=app_ctx,
    )
    preferred_language_custom = shared_parsing.sanitize_output_language_pref_custom(
        user.get('preferred_output_language_custom', ''),
        runtime=app_ctx,
    )
    return shared_parsing.parse_output_language(
        request.form.get('output_language', preferred_language_key),
        request.form.get('output_language_custom', preferred_language_custom),
        runtime=app_ctx,
    )


def _authorized_user(app_ctx, request):
    decoded_token, error_response, status = access_service.require_allowed_user(
        app_ctx,
        request,
        unauthorized_error='Please sign in to continue',
    )
    if error_response is not None:
        return None, error_response, status
    uid = decoded_token['uid']
    deletion_guard = _account_write_guard_response(app_ctx, uid)
    if deletion_guard is not None:
        response, status_code = deletion_guard
        return None, response, status_code
    return decoded_token, None, None


def create_voice_note(app_ctx, request):
    decoded_token, error_response, status = _authorized_user(app_ctx, request)
    if error_response is not None:
        return error_response, status

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    active_jobs = account_lifecycle.count_active_jobs_for_user(uid, runtime=app_ctx)
    if active_jobs >= app_ctx.MAX_ACTIVE_JOBS_PER_USER:
        return app_ctx.jsonify({
            'error': f'You already have {active_jobs} active processing job(s). Please wait for one to finish before starting another.'
        }), 429

    allowed, retry_after = rate_limiter.check_rate_limit(
        key=f"voice_notes:{rate_limiter.normalize_rate_limit_key_part(uid, fallback='anon_uid', runtime=app_ctx)}",
        limit=app_ctx.UPLOAD_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
        runtime=app_ctx,
    )
    if not allowed:
        return rate_limiter.build_rate_limited_response(
            'Too many voice-note sync attempts right now. Please wait and try again.',
            retry_after,
            runtime=app_ctx,
        )

    quota_reservation, quota_response, quota_status = upload_quota_service.reserve_upload_quota(
        app_ctx,
        uid,
        upload_quota_service.request_content_length(request),
        context='Voice-note upload',
    )
    if quota_response is not None:
        return quota_response, quota_status

    audio_path = ''
    try:
        user = app_ctx.get_or_create_user(uid, email)
        if not billing_credits.has_category_credit(user, 'interview', runtime=app_ctx):
            return app_ctx.jsonify({'error': 'No interview credits remaining. Your recording is still saved offline on this device.'}), 402

        uploaded_audio_file = request.files.get('audio')
        if not uploaded_audio_file or not str(uploaded_audio_file.filename or '').strip():
            return app_ctx.jsonify({'error': 'Audio file is required'}), 400
        if not app_ctx.allowed_file(uploaded_audio_file.filename, app_ctx.ALLOWED_AUDIO_EXTENSIONS):
            return app_ctx.jsonify({'error': 'Invalid audio file'}), 400
        if _normalize_audio_mime(getattr(uploaded_audio_file, 'mimetype', '')) not in app_ctx.ALLOWED_AUDIO_MIME_TYPES:
            return app_ctx.jsonify({'error': 'Invalid audio content type'}), 400

        job_id = str(app_ctx.uuid.uuid4())
        original_name = app_ctx.secure_filename(uploaded_audio_file.filename) or f'{job_id}.webm'
        audio_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f"{job_id}_{original_name}")
        uploaded_audio_file.save(audio_path)

        audio_size = app_ctx.get_saved_file_size(audio_path)
        if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
            app_ctx.cleanup_files([audio_path], [])
            return app_ctx.jsonify({'error': 'Audio exceeds server limit (max 500MB) or is empty.'}), 400
        if not app_ctx.file_looks_like_audio(audio_path):
            app_ctx.cleanup_files([audio_path], [])
            return app_ctx.jsonify({'error': 'Uploaded audio file is invalid or unsupported.'}), 400

        quota_error, quota_error_status = upload_quota_service.adjust_reserved_upload_bytes(
            app_ctx,
            quota_reservation,
            audio_size,
            context='Voice-note upload',
        )
        if quota_error is not None:
            app_ctx.cleanup_files([audio_path], [])
            return quota_error, quota_error_status

        ai_unavailable = _require_ai_processing_ready(app_ctx)
        if ai_unavailable is not None:
            app_ctx.cleanup_files([audio_path], [])
            return ai_unavailable

        deducted_credit = billing_credits.deduct_interview_credit(uid, runtime=app_ctx)
        if not deducted_credit:
            app_ctx.cleanup_files([audio_path], [])
            return app_ctx.jsonify({'error': 'No interview credits remaining.'}), 402

        study_pack_title = upload_batch_support.sanitize_study_pack_title(
            request.form.get('title') or request.form.get('study_pack_title') or '',
            max_chars=120,
        )
        if not study_pack_title:
            study_pack_title = 'Transcribing voice note...'

        output_language = _resolve_output_language(app_ctx, request, user)
        try:
            runtime_jobs_store.set_job(
                job_id,
                {
                    'status': 'queued',
                    'step': 0,
                    'step_description': 'Queued...',
                    'total_steps': 2,
                    'mode': 'voice-note',
                    'job_scope': 'study',
                    'tool_source_type': 'audio',
                    'tool_input_name': original_name,
                    'user_id': uid,
                    'user_email': email,
                    'credit_deducted': deducted_credit,
                    'credit_refunded': False,
                    'study_tools_credit_cost': 0,
                    'started_at': app_ctx.time.time(),
                    'finished_at': 0,
                    'result': None,
                    'transcript': None,
                    'flashcards': [],
                    'test_questions': [],
                    'flashcard_selection': '10',
                    'question_selection': '5',
                    'study_features': 'none',
                    'output_language': output_language,
                    'study_generation_error': None,
                    'study_pack_id': None,
                    'study_pack_title': study_pack_title,
                    'folder_id': '',
                    'folder_name': '',
                    'voice_note_tags': [],
                    'voice_note_pinned': False,
                    'voice_note_archived': _parse_bool(request.form.get('archived')),
                    'voice_note_custom_instruction': str(request.form.get('custom_instruction', '') or '').strip()[:2000],
                    'voice_note_append_to_pack_id': '',
                    'error': '',
                    'failed_stage': '',
                    'provider_error_code': '',
                    'retry_attempts': 0,
                    'file_size_mb': round(audio_size / (1024 * 1024), 2),
                    'billing_receipt': billing_receipts.initialize_billing_receipt(
                        {deducted_credit: 1},
                        runtime=app_ctx,
                    ),
                },
                runtime=app_ctx,
            )
            app_ctx.submit_background_job(
                ai_pipelines.process_voice_note,
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
                extra_slides_credits=0,
            )
        except Exception as error:
            return _handle_runtime_job_setup_failure(
                app_ctx,
                job_id=job_id,
                uid=uid,
                cleanup_paths=[audio_path],
                credit_type=deducted_credit,
                error=error,
            )

        upload_quota_service.commit_upload_quota(quota_reservation)
        return app_ctx.jsonify({'ok': True, 'job_id': job_id, 'status': 'queued'}), 202
    except ValueError as error:
        if audio_path:
            app_ctx.cleanup_files([audio_path], [])
        return app_ctx.jsonify({'error': str(error)}), 400
    except PermissionError:
        if audio_path:
            app_ctx.cleanup_files([audio_path], [])
        return app_ctx.jsonify({'error': 'Forbidden'}), 403
    finally:
        upload_quota_service.release_uncommitted_upload_quota(app_ctx, quota_reservation)


def get_voice_note_job_status(app_ctx, request, job_id):
    from lecture_processor.services import upload_runtime_service

    return upload_runtime_service.get_status(app_ctx, request, job_id)


def update_voice_note_metadata(app_ctx, request, pack_id):
    decoded_token, error_response, status = _authorized_user(app_ctx, request)
    if error_response is not None:
        return error_response, status

    uid = decoded_token['uid']
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return app_ctx.jsonify({'error': 'Invalid payload'}), 400

    pack_ref = app_ctx.study_repo.study_pack_doc_ref(app_ctx.db, pack_id)
    doc = pack_ref.get()
    if not getattr(doc, 'exists', False):
        return app_ctx.jsonify({'error': 'Study pack not found'}), 404
    pack = doc.to_dict() or {}
    if str(pack.get('uid', '') or '').strip() != uid:
        return app_ctx.jsonify({'error': 'Forbidden'}), 403

    updates = {'updated_at': app_ctx.time.time()}
    if 'tags' in payload:
        updates['tags'] = sanitize_voice_note_tags(payload.get('tags'))
    if 'pinned' in payload:
        updates['pinned'] = bool(payload.get('pinned'))
    if 'archived' in payload:
        updates['archived'] = bool(payload.get('archived'))
    if 'custom_instruction' in payload:
        updates['custom_instruction'] = str(payload.get('custom_instruction', '') or '').strip()[:2000]
    if 'title' in payload:
        updates['title'] = str(payload.get('title', '') or '').strip()[:120]
    pack_ref.update(updates)
    return app_ctx.jsonify({'ok': True, 'updates': updates})


def regenerate_voice_note_study_tools(app_ctx, request, pack_id):
    decoded_token, error_response, status = _authorized_user(app_ctx, request)
    if error_response is not None:
        return error_response, status

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    user = app_ctx.get_or_create_user(uid, email)
    if not billing_credits.has_category_credit(user, 'slides', runtime=app_ctx):
        return app_ctx.jsonify({'error': 'No text extraction credits remaining.'}), 402

    pack_doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
    if not getattr(pack_doc, 'exists', False):
        return app_ctx.jsonify({'error': 'Study pack not found'}), 404
    pack = pack_doc.to_dict() or {}
    if str(pack.get('uid', '') or '').strip() != uid:
        return app_ctx.jsonify({'error': 'Forbidden'}), 403

    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        payload = {}
    study_features = shared_parsing.parse_study_features(payload.get('study_features', 'both'), runtime=app_ctx)
    if study_features == 'none':
        study_features = 'both'
    if not billing_credits.deduct_slides_credits(uid, 1, runtime=app_ctx):
        return app_ctx.jsonify({'error': 'Could not reserve a text extraction credit.'}), 402

    job_id = str(app_ctx.uuid.uuid4())
    runtime_jobs_store.set_job(
        job_id,
        {
            'status': 'queued',
            'step': 0,
            'step_description': 'Queued...',
            'total_steps': 1,
            'mode': 'voice-note-study-tools',
            'job_scope': 'study',
            'user_id': uid,
            'user_email': email,
            'started_at': app_ctx.time.time(),
            'finished_at': 0,
            'study_pack_id': pack_id,
            'study_pack_title': str(pack.get('title', '') or ''),
            'flashcards': [],
            'test_questions': [],
            'flashcard_selection': shared_parsing.parse_requested_amount(
                payload.get('flashcard_amount', '20'),
                {'10', '20', '30', 'auto'},
                '20',
                runtime=app_ctx,
            ),
            'question_selection': shared_parsing.parse_requested_amount(
                payload.get('question_amount', '10'),
                {'5', '10', '15', 'auto'},
                '10',
                runtime=app_ctx,
            ),
            'study_features': study_features,
            'output_language': str(pack.get('output_language', 'English') or 'English'),
            'extra_slides_refunded': 0,
            'error': '',
            'failed_stage': '',
            'provider_error_code': '',
            'retry_attempts': 0,
            'billing_receipt': billing_receipts.initialize_billing_receipt({'slides_credits': 1}, runtime=app_ctx),
        },
        runtime=app_ctx,
    )
    try:
        app_ctx.submit_background_job(
            ai_pipelines.regenerate_study_tools_for_pack,
            job_id,
            pack_id,
            runtime=app_ctx,
        )
    except JobQueueFullError:
        billing_credits.refund_slides_credits(uid, 1, runtime=app_ctx)
        runtime_jobs_store.delete_job(job_id, runtime=app_ctx)
        return app_ctx.jsonify({'error': upload_batch_support.queue_full_message()}), 429
    return app_ctx.jsonify({'ok': True, 'job_id': job_id, 'status': 'queued'}), 202
