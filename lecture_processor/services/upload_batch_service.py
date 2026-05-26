"""Batch upload routes extracted from upload API service."""

import json
import re
import zipfile

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.ai import instant_batch_orchestrator
from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.shared import sanitize_csv_row
from lecture_processor.domains.shared import parsing as shared_parsing
from lecture_processor.domains.study import export as study_export
from lecture_processor.domains.upload import import_audio as upload_import_audio
from lecture_processor.runtime.job_dispatcher import JobQueueFullError

from lecture_processor.services import upload_batch_support, upload_quota_service, upload_redaction_service


BATCH_MODES = {'lecture-notes', 'slides-only', 'interview', 'audio-transcription', 'text-combine'}
STUDY_TOOL_BATCH_MODES = {'lecture-notes', 'slides-only'}
AUDIO_BATCH_MODES = {'lecture-notes', 'interview', 'audio-transcription'}
TEXT_COMBINE_BATCH_MODE = 'text-combine'
MAX_BATCH_TEXT_UPLOAD_BYTES_DEFAULT = 2 * 1024 * 1024
INSTANT_BATCH_MAX_ROWS_DEFAULT = 20
BATCH_MAX_ROWS_DEFAULT = 100
SAFE_BATCH_ROW_ID_RE = re.compile(r'^[A-Za-z0-9_-]{1,64}$')


def _safe_int(value, default=0):
    try:
        return int(value or default)
    except Exception:
        return int(default or 0)


def _safe_batch_row_id(app_ctx, raw_row_id, seen_row_ids, row_index):
    row_id = str(raw_row_id or '').strip()
    if not row_id:
        row_id = f'row-{row_index}-{str(app_ctx.uuid.uuid4()).split("-", 1)[0]}'
    if not SAFE_BATCH_ROW_ID_RE.fullmatch(row_id):
        raise ValueError(f'Row {row_index}: row identifier is invalid.')
    if row_id in seen_row_ids:
        raise ValueError(f'Row {row_index}: row identifier is duplicated.')
    seen_row_ids.add(row_id)
    return row_id


def _dedupe_paths(paths):
    seen = set()
    deduped = []
    for raw_path in paths or ():
        path = str(raw_path or '').strip()
        if not path or path in seen:
            continue
        seen.add(path)
        deduped.append(path)
    return deduped


def _cleanup_batch_local_files(app_ctx, cleanup_paths, consumed_import_paths):
    app_ctx.cleanup_files(_dedupe_paths(list(cleanup_paths or []) + list(consumed_import_paths or [])), [])


def _release_pending_import_tokens(app_ctx, uid, token_paths):
    for token in list((token_paths or {}).keys()):
        try:
            upload_import_audio.release_audio_import_token(uid, token, runtime=app_ctx)
        except Exception:
            app_ctx.logger.warning('Could not release pending batch audio import token for uid=%s', uid, exc_info=True)


def _refund_batch_charges(app_ctx, uid, charged_rows):
    for charged in charged_rows:
        credit_type = str(charged.get('credit_type', '') or '').strip()
        if credit_type:
            billing_credits.refund_credit(uid, credit_type, runtime=app_ctx)
        extras = int(charged.get('interview_features_cost', 0) or 0)
        if extras > 0:
            billing_credits.refund_slides_credits(uid, extras, runtime=app_ctx)


def _batch_requested_bytes_for_quota(app_ctx, request, row_plans):
    requested_bytes = upload_quota_service.request_content_length(request)
    direct_url_rows = sum(1 for row in row_plans if row.get('audio_source_type') == 'm3u8_url')
    if direct_url_rows > 0:
        requested_bytes += direct_url_rows * upload_quota_service.max_audio_upload_bytes(app_ctx)
    return requested_bytes


def _serialize_audio_fetch_target(fetch_target):
    resolved_ips = getattr(fetch_target, 'resolved_ips', ()) or ()
    try:
        port = int(getattr(fetch_target, 'port', 0) or 0)
    except Exception:
        port = 0
    return {
        'url': upload_import_audio.resolved_url(fetch_target),
        'scheme': str(getattr(fetch_target, 'scheme', '') or '').strip().lower(),
        'host': str(getattr(fetch_target, 'host', '') or '').strip().lower(),
        'port': port,
        'resolved_ips': [str(ip) for ip in resolved_ips if str(ip or '').strip()],
    }


def _has_uploaded_file(uploaded_file):
    return bool(uploaded_file and str(getattr(uploaded_file, 'filename', '') or '').strip())


def _read_batch_text_upload(app_ctx, uploaded_file, row_index, label):
    if not _has_uploaded_file(uploaded_file):
        return '', 0
    filename = str(getattr(uploaded_file, 'filename', '') or '').strip()
    if not app_ctx.allowed_file(filename, {'txt'}):
        raise ValueError(f'Row {row_index}: {label} must be a .txt file.')

    max_bytes = int(getattr(app_ctx, 'MAX_BATCH_TEXT_UPLOAD_BYTES', MAX_BATCH_TEXT_UPLOAD_BYTES_DEFAULT) or MAX_BATCH_TEXT_UPLOAD_BYTES_DEFAULT)
    data = uploaded_file.read(max_bytes + 1)
    if hasattr(uploaded_file, 'stream') and hasattr(uploaded_file.stream, 'seek'):
        try:
            uploaded_file.stream.seek(0)
        except Exception:
            pass
    if not data:
        raise ValueError(f'Row {row_index}: {label} text file is empty.')
    if len(data) > max_bytes:
        max_mb = max(1, int(max_bytes / (1024 * 1024)))
        raise ValueError(f'Row {row_index}: {label} text file exceeds the {max_mb} MB limit.')
    if b'\x00' in data:
        raise ValueError(f'Row {row_index}: {label} text file is not valid text.')

    decoded = ''
    for encoding in ('utf-8-sig', 'utf-8', 'cp1252'):
        try:
            decoded = data.decode(encoding)
            break
        except UnicodeDecodeError:
            continue
    if not decoded:
        raise ValueError(f'Row {row_index}: {label} text file could not be decoded.')
    decoded = decoded.replace('\r\n', '\n').replace('\r', '\n').strip()
    if not decoded:
        raise ValueError(f'Row {row_index}: {label} text file is empty.')
    return decoded, len(data)


def _batch_credit_preflight_error(user, mode, row_plans, runtime=None):
    row_count = len(row_plans)
    if mode == 'lecture-notes':
        if not billing_credits.has_category_credit(user, 'lecture', row_count, runtime=runtime):
            return 'Not enough lecture credits to start this batch.', 402
    elif mode == 'slides-only':
        if not billing_credits.has_category_credit(user, 'slides', row_count, runtime=runtime):
            return 'Not enough text extraction credits to start this batch.', 402
    elif mode == 'interview':
        if not billing_credits.has_category_credit(user, 'interview', row_count, runtime=runtime):
            return 'Not enough interview credits to start this batch.', 402
        extras_needed = sum(_safe_int(row.get('interview_features_cost', 0)) for row in row_plans)
        if extras_needed > 0 and not billing_credits.has_category_credit(user, 'slides', extras_needed, runtime=runtime):
            return 'Not enough text extraction credits for interview extras in this batch.', 402
    elif mode == 'audio-transcription':
        if not billing_credits.has_category_credit(user, 'interview', row_count, runtime=runtime):
            return 'Not enough interview credits to start this batch.', 402
    elif mode == TEXT_COMBINE_BATCH_MODE:
        if not billing_credits.has_category_credit(user, 'lecture', row_count, runtime=runtime):
            return 'Not enough lecture credits to start this batch.', 402
    return '', 0


def _reserve_batch_upload_quota(app_ctx, uid, request, row_plans):
    active_jobs = account_lifecycle.count_active_jobs_for_user(uid, runtime=app_ctx)
    if active_jobs >= app_ctx.MAX_ACTIVE_JOBS_PER_USER:
        analytics_events.log_rate_limit_hit('upload', 10, runtime=app_ctx)
        return app_ctx.jsonify({
            'error': f'You already have {active_jobs} active processing job(s). Please wait for one to finish before starting another.'
        }), 429, None

    allowed_upload, retry_after = rate_limiter.check_rate_limit(
        key=f'upload:{uid}',
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
        ), 429, None

    requested_bytes = _batch_requested_bytes_for_quota(app_ctx, request, row_plans)
    quota_reservation, quota_response, quota_status = upload_quota_service.reserve_upload_quota(
        app_ctx,
        uid,
        requested_bytes,
        context='Batch upload',
    )
    if quota_response is not None:
        return quota_response, quota_status, quota_reservation
    return None, 0, quota_reservation


def create_batch_job(app_ctx, request, *, instant=False):
    uid, decoded_token, error_response, status = upload_batch_support.batch_user_guard(app_ctx, request)
    if error_response is not None:
        return error_response, status
    deletion_guard = upload_batch_support.account_write_guard_response(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard

    mode = str(request.form.get('mode', 'lecture-notes') or '').strip()
    if mode not in BATCH_MODES:
        return app_ctx.jsonify({'error': 'Invalid mode selected'}), 400

    rows = upload_batch_support.parse_batch_rows_payload(request)
    if rows is None:
        return app_ctx.jsonify({'error': 'Invalid rows payload'}), 400
    if len(rows) < 2:
        return app_ctx.jsonify({'error': 'Batch mode requires at least 2 rows.'}), 400
    max_rows_attr = 'INSTANT_BATCH_MAX_ROWS' if instant else 'BATCH_MAX_ROWS'
    max_rows_default = INSTANT_BATCH_MAX_ROWS_DEFAULT if instant else BATCH_MAX_ROWS_DEFAULT
    max_rows = int(getattr(app_ctx, max_rows_attr, max_rows_default) or max_rows_default)
    if len(rows) > max_rows:
        label = 'Instant Batch' if instant else 'Batch mode'
        return app_ctx.jsonify({'error': f'{label} supports up to {max_rows} rows at a time.'}), 400
    client_submission_id = str(request.form.get('client_submission_id', '') or '').strip()[:120]
    if client_submission_id:
        existing = batch_orchestrator.find_batch_by_submission_id(
            uid,
            client_submission_id,
            runtime=app_ctx,
        )
        existing_batch_id = str((existing or {}).get('batch_id', '') or '').strip()
        if existing_batch_id:
            return app_ctx.jsonify(
                {
                    'batch_id': existing_batch_id,
                    'deduplicated': True,
                    'status': str((existing or {}).get('status', 'queued') or 'queued'),
                }
            )

    batch_title = upload_batch_support.sanitize_study_pack_title(request.form.get('batch_title', ''))
    if not batch_title:
        return app_ctx.jsonify({'error': 'Batch title is required.'}), 400

    ai_unavailable = upload_batch_support.require_ai_processing_ready(app_ctx)
    if ai_unavailable is not None:
        return ai_unavailable

    decoded_email = str((decoded_token or {}).get('email', '') or '').strip()
    user = app_ctx.get_or_create_user(uid, decoded_email)
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
    default_study_features = shared_parsing.parse_study_features(request.form.get('study_features', 'none'), runtime=app_ctx)
    default_flashcards = shared_parsing.parse_requested_amount(
        request.form.get('flashcard_amount', '20'),
        {'10', '20', '30', 'auto'},
        '20',
        runtime=app_ctx,
    )
    default_questions = shared_parsing.parse_requested_amount(
        request.form.get('question_amount', '10'),
        {'5', '10', '15', 'auto'},
        '10',
        runtime=app_ctx,
    )
    include_combined_docx = upload_batch_support.parse_checkbox_value(request.form.get('include_combined_docx', '0'))

    batch_id = str(app_ctx.uuid.uuid4())
    row_plans = []
    prepared_rows = []
    cleanup_paths = []
    consumed_import_paths = []
    pending_import_token_paths = {}
    charged_rows = []
    created_folder_ref = None
    batch_created = False
    quota_reservation = None
    actual_upload_bytes = 0
    now_ts = app_ctx.time.time()

    try:
        upload_import_audio.cleanup_expired_audio_import_tokens(runtime=app_ctx)
        seen_row_ids = set()
        for idx, row_cfg in enumerate(rows, start=1):
            row_id = _safe_batch_row_id(app_ctx, row_cfg.get('row_id', ''), seen_row_ids, idx)
            slides_required = mode in {'lecture-notes', 'slides-only'}
            audio_required = mode in AUDIO_BATCH_MODES
            text_combine_required = mode == TEXT_COMBINE_BATCH_MODE

            slides_file = None
            slides_field = str(row_cfg.get('slides_file_field', f'row_{idx}_slides') or '').strip()
            if slides_required:
                slides_file = request.files.get(slides_field)
                if not slides_file or slides_file.filename == '':
                    raise ValueError(f'Row {idx}: slides file is required.')

            slide_text_file = None
            transcript_text_file = None
            slide_text_field = str(row_cfg.get('slide_text_file_field', f'row_{idx}_slide_text') or '').strip()
            transcript_text_field = str(row_cfg.get('transcript_text_file_field', f'row_{idx}_transcript_text') or '').strip()
            if text_combine_required:
                slide_text_file = request.files.get(slide_text_field)
                transcript_text_file = request.files.get(transcript_text_field)
                if not _has_uploaded_file(slide_text_file) and not _has_uploaded_file(transcript_text_file):
                    raise ValueError(f'Row {idx}: upload at least one .txt file for slide text or audio transcript.')

            audio_source_type = ''
            audio_import_token = str(row_cfg.get('audio_import_token', '') or '').strip()
            audio_url = str(row_cfg.get('audio_m3u8_url', '') or '').strip()
            audio_file = None
            audio_field = str(row_cfg.get('audio_file_field', f'row_{idx}_audio') or '').strip()
            if audio_required:
                if audio_import_token:
                    audio_source_type = 'import_token'
                elif audio_url:
                    audio_source_type = 'm3u8_url'
                else:
                    audio_file = request.files.get(audio_field)
                    if not audio_file or audio_file.filename == '':
                        raise ValueError(f'Row {idx}: audio file is required.')
                    if not app_ctx.allowed_file(audio_file.filename, app_ctx.ALLOWED_AUDIO_EXTENSIONS):
                        raise ValueError(f'Row {idx}: invalid audio file extension.')
                    if (audio_file.mimetype or '').lower() not in app_ctx.ALLOWED_AUDIO_MIME_TYPES:
                        raise ValueError(f'Row {idx}: invalid audio content type.')
                    audio_source_type = 'upload'

            row_study_features = default_study_features
            row_flashcards = default_flashcards
            row_questions = default_questions
            override = row_cfg.get('study_override', {})
            if isinstance(override, dict):
                if 'study_features' in override:
                    row_study_features = shared_parsing.parse_study_features(override.get('study_features', default_study_features), runtime=app_ctx)
                if 'flashcard_amount' in override:
                    row_flashcards = shared_parsing.parse_requested_amount(
                        override.get('flashcard_amount', default_flashcards),
                        {'10', '20', '30', 'auto'},
                        default_flashcards,
                        runtime=app_ctx,
                    )
                if 'question_amount' in override:
                    row_questions = shared_parsing.parse_requested_amount(
                        override.get('question_amount', default_questions),
                        {'5', '10', '15', 'auto'},
                        default_questions,
                        runtime=app_ctx,
                    )

            row_interview_features = []
            interview_features_cost = 0
            if mode == 'interview':
                raw_features = row_cfg.get('interview_features', [])
                if isinstance(raw_features, list):
                    raw_features_text = ','.join(str(item) for item in raw_features)
                else:
                    raw_features_text = str(raw_features or 'none')
                row_interview_features = shared_parsing.parse_interview_features(raw_features_text, runtime=app_ctx)
                interview_features_cost = len(row_interview_features)

            row_plans.append(
                {
                    'row_id': row_id,
                    'ordinal': idx,
                    'slides_required': slides_required,
                    'slides_file': slides_file,
                    'text_combine_required': text_combine_required,
                    'slide_text_file': slide_text_file,
                    'transcript_text_file': transcript_text_file,
                    'text_input_mode': '',
                    'slide_text': '',
                    'transcript': '',
                    'text_upload_bytes': 0,
                    'audio_required': audio_required,
                    'audio_file': audio_file,
                    'audio_file_field': audio_field,
                    'audio_import_token': audio_import_token,
                    'audio_url': audio_url,
                    'audio_source_type': audio_source_type,
                    'audio_source_url': '',
                    'audio_local_path': '',
                    'study_features': row_study_features,
                    'flashcard_selection': row_flashcards,
                    'question_selection': row_questions,
                    'interview_features': row_interview_features,
                    'interview_features_cost': interview_features_cost,
                    'charged_credit': '',
                }
            )

        credit_error, credit_status = _batch_credit_preflight_error(user, mode, row_plans, runtime=app_ctx)
        if credit_error:
            return app_ctx.jsonify({'error': credit_error}), credit_status

        quota_response, quota_status, quota_reservation = _reserve_batch_upload_quota(
            app_ctx,
            uid,
            request,
            row_plans,
        )
        if quota_response is not None:
            return quota_response, quota_status

        for plan in row_plans:
            idx = plan['ordinal']
            if plan.get('audio_source_type') == 'import_token':
                token = str(plan.get('audio_import_token', '') or '').strip()
                audio_local_path, token_error = upload_import_audio.get_audio_import_token_path(
                    uid,
                    token,
                    consume=False,
                    runtime=app_ctx,
                )
                if token_error:
                    raise ValueError(f'Row {idx}: {token_error}')
                pending_import_token_paths[token] = audio_local_path
                plan['audio_local_path'] = audio_local_path
            elif plan.get('audio_source_type') == 'm3u8_url':
                fetch_target, url_error = upload_import_audio.validate_video_import_fetch_target(plan.get('audio_url', ''), runtime=app_ctx)
                if not fetch_target:
                    raise ValueError(f'Row {idx}: {url_error}')
                serialized_fetch_target = _serialize_audio_fetch_target(fetch_target)
                plan['audio_source_url'] = upload_redaction_service.redact_source_url(
                    upload_import_audio.resolved_url(fetch_target)
                )
                batch_orchestrator.register_batch_audio_fetch_target(
                    batch_id,
                    plan['row_id'],
                    serialized_fetch_target,
                    runtime=app_ctx,
                )
                plan['audio_fetch_target_encrypted'] = batch_orchestrator.encrypt_batch_audio_fetch_target(
                    serialized_fetch_target,
                    runtime=app_ctx,
                )

            if plan.get('text_combine_required'):
                slide_text, slide_bytes = _read_batch_text_upload(
                    app_ctx,
                    plan.get('slide_text_file'),
                    idx,
                    'slide text',
                )
                transcript, transcript_bytes = _read_batch_text_upload(
                    app_ctx,
                    plan.get('transcript_text_file'),
                    idx,
                    'audio transcript',
                )
                if not slide_text and not transcript:
                    raise ValueError(f'Row {idx}: upload at least one .txt file for slide text or audio transcript.')
                if slide_text and transcript:
                    text_input_mode = 'both'
                elif slide_text:
                    text_input_mode = 'slides-only'
                else:
                    text_input_mode = 'transcript-only'
                plan['slide_text'] = slide_text
                plan['transcript'] = transcript
                plan['text_input_mode'] = text_input_mode
                plan['text_upload_bytes'] = int(slide_bytes or 0) + int(transcript_bytes or 0)
                actual_upload_bytes += plan['text_upload_bytes']

        for plan in row_plans:
            interview_features_cost = int(plan.get('interview_features_cost', 0) or 0)
            charged_credit = ''
            if mode == 'lecture-notes':
                charged_credit = billing_credits.deduct_credit(
                    uid,
                    'lecture_credits_standard',
                    'lecture_credits_extended',
                    runtime=app_ctx,
                )
                if not charged_credit:
                    raise ValueError('Not enough lecture credits to start this batch.')
            elif mode == 'slides-only':
                charged_credit = billing_credits.deduct_credit(uid, 'slides_credits', runtime=app_ctx)
                if not charged_credit:
                    raise ValueError('Not enough text extraction credits to start this batch.')
            elif mode == 'interview':
                charged_credit = billing_credits.deduct_interview_credit(uid, runtime=app_ctx)
                if not charged_credit:
                    raise ValueError('Not enough interview credits to start this batch.')
                if interview_features_cost > 0:
                    if not billing_credits.deduct_slides_credits(uid, interview_features_cost, runtime=app_ctx):
                        billing_credits.refund_credit(uid, charged_credit, runtime=app_ctx)
                        raise ValueError('Not enough text extraction credits for interview extras in this batch row.')
            elif mode == 'audio-transcription':
                charged_credit = billing_credits.deduct_interview_credit(uid, runtime=app_ctx)
                if not charged_credit:
                    raise ValueError('Not enough interview credits to start this batch.')
            elif mode == TEXT_COMBINE_BATCH_MODE:
                charged_credit = billing_credits.deduct_credit(
                    uid,
                    'lecture_credits_standard',
                    'lecture_credits_extended',
                    runtime=app_ctx,
                )
                if not charged_credit:
                    raise ValueError('Not enough lecture credits to start this batch.')
            plan['charged_credit'] = charged_credit

            charged_rows.append(
                {
                    'credit_type': charged_credit,
                    'interview_features_cost': interview_features_cost,
                }
            )

        for plan in row_plans:
            idx = plan['ordinal']
            row_id = plan['row_id']
            slides_local_path = ''
            if plan.get('slides_required'):
                slides_local_path, slides_error = app_ctx.resolve_uploaded_slides_to_pdf(
                    plan.get('slides_file'),
                    f'{batch_id}_{row_id}',
                )
                if slides_error:
                    raise ValueError(f'Row {idx}: {slides_error}')
                cleanup_paths.append(slides_local_path)
                slides_size = app_ctx.get_saved_file_size(slides_local_path)
                actual_upload_bytes += max(0, int(slides_size if slides_size > 0 else 0))

            audio_local_path = str(plan.get('audio_local_path', '') or '')
            audio_source_type = str(plan.get('audio_source_type', '') or '')
            audio_source_url = str(plan.get('audio_source_url', '') or '')
            audio_import_token = str(plan.get('audio_import_token', '') or '').strip()
            if plan.get('audio_required'):
                if audio_source_type == 'm3u8_url':
                    pass
                elif audio_source_type == 'upload':
                    audio_file = plan.get('audio_file')
                    audio_local_path = app_ctx.os.path.join(
                        app_ctx.UPLOAD_FOLDER,
                        f'{batch_id}_{row_id}_{app_ctx.secure_filename(audio_file.filename)}',
                    )
                    audio_file.save(audio_local_path)
                    cleanup_paths.append(audio_local_path)

                if audio_source_type == 'm3u8_url':
                    audio_size = 0
                    actual_upload_bytes += upload_quota_service.max_audio_upload_bytes(app_ctx)
                else:
                    audio_size = app_ctx.get_saved_file_size(audio_local_path)
                    if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
                        raise ValueError(f'Row {idx}: audio exceeds server limit or is empty.')
                    if not app_ctx.file_looks_like_audio(audio_local_path):
                        raise ValueError(f'Row {idx}: uploaded audio is invalid or unsupported.')
                    if audio_source_type == 'import_token':
                        actual_upload_bytes += upload_quota_service.chargeable_import_token_bytes(
                            app_ctx,
                            uid,
                            audio_import_token,
                            audio_size,
                        )
                    else:
                        actual_upload_bytes += max(0, int(audio_size if audio_size > 0 else 0))

            if audio_import_token:
                consumed_path, token_error = upload_import_audio.get_audio_import_token_path(
                    uid,
                    audio_import_token,
                    consume=True,
                    runtime=app_ctx,
                )
                if token_error:
                    pending_path = pending_import_token_paths.pop(audio_import_token, '')
                    if pending_path:
                        consumed_import_paths.append(pending_path)
                    raise ValueError(f'Row {idx}: {token_error}')
                pending_import_token_paths.pop(audio_import_token, None)
                consumed_import_paths.append(consumed_path or audio_local_path)

            charged_credit = str(plan.get('charged_credit', '') or '').strip()
            interview_features_cost = int(plan.get('interview_features_cost', 0) or 0)
            billing_receipt = billing_receipts.initialize_billing_receipt(
                {charged_credit: 1, 'slides_credits': interview_features_cost},
                runtime=app_ctx,
            )
            source_type = audio_source_type if audio_source_type else ('text-upload' if mode == TEXT_COMBINE_BATCH_MODE else ('upload' if slides_required else 'audio'))
            prepared_rows.append(
                {
                    'row_id': row_id,
                    'ordinal': idx,
                    'status': 'queued',
                    'uid': uid,
                    'source_type': source_type,
                    'source_url': audio_source_url,
                    'audio_fetch_target_encrypted': plan.get('audio_fetch_target_encrypted', ''),
                    'source_name': f'row-{idx}',
                    'slides_local_path': slides_local_path,
                    'audio_local_path': audio_local_path,
                    'text_input_mode': plan.get('text_input_mode', ''),
                    'slide_text': plan.get('slide_text', ''),
                    'transcript': plan.get('transcript', ''),
                    'audio_quota_reserved_bytes': upload_quota_service.max_audio_upload_bytes(app_ctx) if audio_source_type == 'm3u8_url' else 0,
                    'audio_quota_actual_bytes': 0,
                    'audio_quota_released': False,
                    'output_language': output_language,
                    'study_features': plan.get('study_features', 'none') if mode in STUDY_TOOL_BATCH_MODES else 'none',
                    'flashcard_selection': plan.get('flashcard_selection', default_flashcards),
                    'question_selection': plan.get('question_selection', default_questions),
                    'interview_features': plan.get('interview_features', []),
                    'interview_features_cost': interview_features_cost,
                    'credit_deducted': charged_credit,
                    'credit_refunded': False,
                    'billing_receipt': billing_receipt,
                    'processing_strategy': 'instant' if instant else 'batch',
                    'billing_mode': 'instant_batch' if instant else 'batch',
                    'billing_multiplier': 1.0 if instant else 0.5,
                    'token_usage_by_stage': {},
                    'token_input_total': 0,
                    'token_output_total': 0,
                    'token_total': 0,
                    'started_at': now_ts,
                    'created_at': now_ts,
                }
            )
        quota_error, quota_error_status = upload_quota_service.adjust_reserved_upload_bytes(
            app_ctx,
            quota_reservation,
            actual_upload_bytes,
            context='Batch upload',
        )
        if quota_error is not None:
            _refund_batch_charges(app_ctx, uid, charged_rows)
            _release_pending_import_tokens(app_ctx, uid, pending_import_token_paths)
            pending_import_token_paths.clear()
            _cleanup_batch_local_files(app_ctx, cleanup_paths, consumed_import_paths)
            return quota_error, quota_error_status

        folder_name = batch_title
        folder_id = ''
        if app_ctx.db is not None:
            created_folder_ref = app_ctx.study_repo.create_study_folder_doc_ref(app_ctx.db)
            created_folder_ref.set({
                'folder_id': created_folder_ref.id,
                'uid': uid,
                'name': folder_name,
                'course': '',
                'subject': '',
                'semester': '',
                'block': '',
                'exam_date': '',
                'created_at': now_ts,
                'updated_at': now_ts,
            })
            folder_id = created_folder_ref.id

        batch_payload = {
            'batch_id': batch_id,
            'uid': uid,
            'email': decoded_email or str(user.get('email', '') or '').strip(),
            'mode': mode,
            'status': 'queued',
            'processing_strategy': 'instant' if instant else 'batch',
            'batch_title': batch_title,
            'output_language': output_language,
            'study_defaults': {
                'study_features': default_study_features if mode in STUDY_TOOL_BATCH_MODES else 'none',
                'flashcard_amount': default_flashcards,
                'question_amount': default_questions,
            },
            'export_options': {
                'include_combined_docx': include_combined_docx,
            },
            'folder_id': folder_id,
            'folder_name': folder_name,
            'total_rows': len(prepared_rows),
            'completed_rows': 0,
            'failed_rows': 0,
            'token_input_total': 0,
            'token_output_total': 0,
            'token_total': 0,
            'external_batch_refs': {},
            'error_summary': '',
            'created_at': now_ts,
            'updated_at': now_ts,
            'finished_at': 0,
            'billing_mode': 'instant_batch' if instant else 'batch',
            'billing_multiplier': 1.0 if instant else 0.5,
            'instant_max_parallel_rows': int(getattr(app_ctx, 'INSTANT_BATCH_MAX_PARALLEL_ROWS', 2) or 2) if instant else 0,
            'instant_api_stagger_seconds': float(getattr(app_ctx, 'INSTANT_BATCH_API_STAGGER_SECONDS', 5.0) or 5.0) if instant else 0,
            'completion_email_status': 'pending',
            'completion_email_sent_at': 0,
            'completion_email_error': '',
            'current_stage': 'queued',
            'current_stage_state': 'queued',
            'stage_started_at': 0,
            'provider_state': 'JOB_STATE_PENDING',
            'submission_locked': True,
            'client_submission_id': client_submission_id,
            'last_heartbeat_at': now_ts,
            'credits_charged': sum(1 + int(item.get('interview_features_cost', 0) or 0) for item in charged_rows),
            'credits_refunded': 0,
            'credits_refund_pending': 0,
        }
        batch_orchestrator.create_batch_job(batch_payload, prepared_rows, runtime=app_ctx)
        batch_created = True

        try:
            submit_batch = getattr(app_ctx, 'submit_batch_background_job', None)
            if not callable(submit_batch):
                submit_batch = app_ctx.submit_background_job
            submit_batch(
                instant_batch_orchestrator.process_instant_batch_job if instant else batch_orchestrator.process_batch_job,
                batch_id,
                runtime=app_ctx,
            )
        except JobQueueFullError:
            batch_orchestrator.mark_batch_submission_error(
                batch_id,
                upload_batch_support.queue_full_message(),
                runtime=app_ctx,
                mark_audio_quota_released=True,
            )
            _release_pending_import_tokens(app_ctx, uid, pending_import_token_paths)
            pending_import_token_paths.clear()
            _cleanup_batch_local_files(app_ctx, cleanup_paths, consumed_import_paths)
            batch_orchestrator.clear_batch_audio_fetch_targets(batch_id, runtime=app_ctx)
            return upload_batch_support.queue_full_response(app_ctx, batch_id=batch_id)
        upload_quota_service.commit_upload_quota(quota_reservation)
        return app_ctx.jsonify({'batch_id': batch_id})
    except Exception as error:
        if created_folder_ref is not None:
            try:
                created_folder_ref.delete()
            except Exception:
                pass
        try:
            batch_exists = batch_created or bool(batch_orchestrator.get_batch(batch_id, runtime=app_ctx))
        except Exception:
            batch_exists = batch_created
        if batch_exists:
            batch_orchestrator.mark_batch_submission_error(
                batch_id,
                upload_redaction_service.redact_exception(error, max_chars=500),
                runtime=app_ctx,
                mark_audio_quota_released=True,
            )
        else:
            _refund_batch_charges(app_ctx, uid, charged_rows)
        _release_pending_import_tokens(app_ctx, uid, pending_import_token_paths)
        pending_import_token_paths.clear()
        _cleanup_batch_local_files(app_ctx, cleanup_paths, consumed_import_paths)
        batch_orchestrator.clear_batch_audio_fetch_targets(batch_id, runtime=app_ctx)
        return app_ctx.jsonify({'error': upload_redaction_service.redact_exception(error, max_chars=500)}), 400
    finally:
        upload_quota_service.release_uncommitted_upload_quota(app_ctx, quota_reservation)


def create_instant_batch_job(app_ctx, request):
    return create_batch_job(app_ctx, request, instant=True)


def list_batch_jobs(app_ctx, request, *, strategy_override=''):
    uid, _decoded_token, error_response, status = upload_batch_support.batch_user_guard(app_ctx, request)
    if error_response is not None:
        return error_response, status

    mode = str(request.args.get('mode', '') or '').strip()
    strategy = str(strategy_override or request.args.get('strategy', '') or '').strip().lower()
    status_filter = str(request.args.get('status', '') or '').strip()
    limit = 100
    try:
        limit = int(request.args.get('limit', 100) or 100)
    except Exception:
        limit = 100
    limit = max(1, min(200, limit))

    statuses = []
    if status_filter:
        statuses = [part.strip() for part in status_filter.split(',') if part.strip()]

    batches = batch_orchestrator.list_batches_for_uid(uid, statuses=statuses, limit=limit, runtime=app_ctx)
    if mode:
        batches = [item for item in batches if str(item.get('mode', '') or '') == mode]
    if strategy:
        batches = [item for item in batches if str(item.get('processing_strategy', 'batch') or 'batch').strip().lower() == strategy]
    return app_ctx.jsonify({'batches': batches})


def list_instant_batch_jobs(app_ctx, request):
    return list_batch_jobs(app_ctx, request, strategy_override='instant')


def get_batch_job_status(app_ctx, request, batch_id):
    batch, _decoded, error_response, status = upload_batch_support.get_batch_with_permission(
        app_ctx,
        request,
        batch_id,
        batch_orchestrator_module=batch_orchestrator,
    )
    if error_response is not None:
        return error_response, status
    try:
        rows_limit = int(request.args.get('rows_limit', getattr(app_ctx, 'BATCH_STATUS_ROWS_LIMIT', 100)) or 100)
    except Exception:
        rows_limit = 100
    rows_limit = max(1, min(500, rows_limit))
    status_payload = batch_orchestrator.get_batch_status(batch_id, runtime=app_ctx, rows_limit=rows_limit)
    if not status_payload:
        return app_ctx.jsonify({'error': 'Batch not found'}), 404
    return app_ctx.jsonify(status_payload)


def batch_row_docx_bytes(app_ctx, row, content_type='result'):
    if content_type == 'slides' and row.get('slide_text'):
        content, title = row.get('slide_text', ''), 'Slides Extracted'
    elif content_type == 'transcript' and row.get('transcript'):
        content, title = row.get('transcript', ''), 'Transcript'
    elif content_type == 'summary' and row.get('interview_summary'):
        content, title = row.get('interview_summary', ''), 'Interview Summary'
    elif content_type == 'sections' and row.get('interview_sections'):
        content, title = row.get('interview_sections', ''), 'Interview Sections'
    elif content_type == 'combined' and row.get('interview_combined'):
        content, title = row.get('interview_combined', ''), 'Interview Combined'
    else:
        content = row.get('result', '') or row.get('merged_notes', '') or row.get('transcript', '') or row.get('slide_text', '')
        title = 'Batch Output'
    doc = study_export.markdown_to_docx(content, title, runtime=app_ctx)
    docx_io = app_ctx.io.BytesIO()
    doc.save(docx_io)
    docx_io.seek(0)
    return docx_io.read()


def batch_row_csv_bytes(app_ctx, row, export_type='flashcards'):
    output = app_ctx.io.StringIO()
    writer = app_ctx.csv.writer(output)
    if export_type == 'test':
        writer.writerow(['Question', 'Option A', 'Option B', 'Option C', 'Option D', 'Correct Answer', 'Explanation'])
        for question in row.get('test_questions', []):
            options = question.get('options', ['', '', '', ''])
            while len(options) < 4:
                options.append('')
            writer.writerow(sanitize_csv_row([
                question.get('question', ''),
                options[0],
                options[1],
                options[2],
                options[3],
                question.get('answer', ''),
                question.get('explanation', ''),
            ]))
    else:
        writer.writerow(['Front', 'Back'])
        for card in row.get('flashcards', []):
            writer.writerow(sanitize_csv_row([card.get('front', ''), card.get('back', '')]))
    return output.getvalue().encode('utf-8')


def append_combined_markdown_section(parts, title, content):
    text = str(content or '').strip()
    if not text:
        return
    parts.append(f'## {title}')
    parts.append('')
    parts.append(text)
    parts.append('')


def batch_row_flashcards_markdown(row):
    cards = row.get('flashcards', []) if isinstance(row.get('flashcards', []), list) else []
    if not cards:
        return ''
    lines = []
    for index, card in enumerate(cards, start=1):
        front = str((card or {}).get('front', '') or '').strip() or f'Flashcard {index}'
        back = str((card or {}).get('back', '') or '').strip()
        lines.append(f'{index}. **{front}**')
        if back:
            lines.append(f'   - {back}')
    return '\n'.join(lines).strip()


def batch_row_questions_markdown(row):
    questions = row.get('test_questions', []) if isinstance(row.get('test_questions', []), list) else []
    if not questions:
        return ''
    lines = []
    letters = ['A', 'B', 'C', 'D']
    for index, question in enumerate(questions, start=1):
        question_text = str((question or {}).get('question', '') or '').strip() or f'Question {index}'
        lines.append(f'{index}. **{question_text}**')
        options = (question or {}).get('options', []) if isinstance((question or {}).get('options', []), list) else []
        for option_index, option in enumerate(options[:4]):
            option_text = str(option or '').strip()
            if option_text:
                lines.append(f'   - {letters[option_index]}: {option_text}')
        answer = str((question or {}).get('answer', '') or '').strip()
        if answer:
            lines.append(f'   - Correct answer: {answer}')
        explanation = str((question or {}).get('explanation', '') or '').strip()
        if explanation:
            lines.append(f'   - Explanation: {explanation}')
    return '\n'.join(lines).strip()


def batch_row_combined_markdown(batch, row):
    mode = str((batch or {}).get('mode', '') or '').strip().lower()
    row_label = str(row.get('source_name', '') or '').strip() or f'Row {int(row.get("ordinal", 0) or 0)}'
    status = str(row.get('status', 'queued') or 'queued').strip().lower()
    parts = [f'# {row_label}', '']

    if status != 'complete':
        parts.append(f'Status: {status}')
        parts.append('')
        parts.append('Output was unavailable when this ZIP was created.')
        error_text = str(row.get('error', '') or '').strip()
        if error_text:
            parts.append('')
            parts.append(f'Reason: {error_text}')
        parts.append('')
        return '\n'.join(parts).strip()

    result_text = str(row.get('result', '') or row.get('merged_notes', '') or '').strip()
    slide_text = str(row.get('slide_text', '') or '').strip()
    transcript_text = str(row.get('transcript', '') or '').strip()
    interview_summary = str(row.get('interview_summary', '') or '').strip()
    interview_sections = str(row.get('interview_sections', '') or '').strip()
    interview_combined = str(row.get('interview_combined', '') or '').strip()

    if mode == 'lecture-notes':
        append_combined_markdown_section(parts, 'Lecture Notes', result_text)
        append_combined_markdown_section(parts, 'Slide Extract', slide_text)
        append_combined_markdown_section(parts, 'Transcript', transcript_text)
    elif mode == 'slides-only':
        append_combined_markdown_section(parts, 'Slide Extract', slide_text or result_text)
    elif mode == 'interview':
        append_combined_markdown_section(parts, 'Transcript', transcript_text or result_text)
        append_combined_markdown_section(parts, 'Interview Summary', interview_summary)
        append_combined_markdown_section(parts, 'Structured Transcript', interview_sections)
        if interview_combined and not interview_summary and not interview_sections:
            append_combined_markdown_section(parts, 'Combined Output', interview_combined)
    elif mode == 'audio-transcription':
        append_combined_markdown_section(parts, 'Transcript', transcript_text or result_text)
    elif mode == TEXT_COMBINE_BATCH_MODE:
        append_combined_markdown_section(parts, 'Combined Lecture Notes', result_text)
        append_combined_markdown_section(parts, 'Slide Text', slide_text)
        append_combined_markdown_section(parts, 'Transcript', transcript_text)
    else:
        append_combined_markdown_section(parts, 'Output', result_text)

    flashcards_markdown = batch_row_flashcards_markdown(row)
    if flashcards_markdown:
        append_combined_markdown_section(parts, 'Flashcards', flashcards_markdown)

    questions_markdown = batch_row_questions_markdown(row)
    if questions_markdown:
        append_combined_markdown_section(parts, 'Practice Questions', questions_markdown)

    return '\n'.join(part for part in parts if part is not None).strip()


def batch_combined_docx_bytes(app_ctx, batch, rows):
    batch_title = str((batch or {}).get('batch_title', '') or (batch or {}).get('batch_id', '') or 'Batch Combined').strip()
    sections = []
    for row in rows:
        sections.append(batch_row_combined_markdown(batch, row))
    markdown_text = '\n\n'.join(section for section in sections if str(section or '').strip()).strip()
    if not markdown_text:
        markdown_text = '# Batch Output\n\nNo row output was available when this ZIP was created.'
    doc = study_export.markdown_to_docx(markdown_text, title=batch_title + ' Combined', runtime=app_ctx)
    output = app_ctx.io.BytesIO()
    doc.save(output)
    output.seek(0)
    return output.read()


def download_batch_row_docx(app_ctx, request, batch_id, row_id):
    _batch, _decoded, error_response, status = upload_batch_support.get_batch_with_permission(
        app_ctx,
        request,
        batch_id,
        batch_orchestrator_module=batch_orchestrator,
    )
    if error_response is not None:
        return error_response, status
    row = batch_orchestrator.get_batch_row(batch_id, row_id, runtime=app_ctx)
    if not row:
        return app_ctx.jsonify({'error': 'Row not found'}), 404
    if row.get('status') != 'complete':
        return app_ctx.jsonify({'error': 'Row is not complete'}), 400
    content_type = request.args.get('type', 'result')
    docx_bytes = batch_row_docx_bytes(app_ctx, row, content_type=content_type)
    return app_ctx.send_file(
        app_ctx.io.BytesIO(docx_bytes),
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        as_attachment=True,
        download_name=f'batch-{batch_id}-{row_id}-{content_type}.docx',
    )


def download_batch_row_flashcards_csv(app_ctx, request, batch_id, row_id):
    _batch, _decoded, error_response, status = upload_batch_support.get_batch_with_permission(
        app_ctx,
        request,
        batch_id,
        batch_orchestrator_module=batch_orchestrator,
    )
    if error_response is not None:
        return error_response, status
    row = batch_orchestrator.get_batch_row(batch_id, row_id, runtime=app_ctx)
    if not row:
        return app_ctx.jsonify({'error': 'Row not found'}), 404
    if row.get('status') != 'complete':
        return app_ctx.jsonify({'error': 'Row is not complete'}), 400
    export_type = request.args.get('type', 'flashcards').strip().lower()
    if export_type not in {'flashcards', 'test'}:
        export_type = 'flashcards'
    csv_bytes = batch_row_csv_bytes(app_ctx, row, export_type=export_type)
    return app_ctx.send_file(
        app_ctx.io.BytesIO(csv_bytes),
        mimetype='text/csv',
        as_attachment=True,
        download_name=f'batch-{batch_id}-{row_id}-{export_type}.csv',
    )


def download_batch_zip(app_ctx, request, batch_id):
    batch, _decoded, error_response, status = upload_batch_support.get_batch_with_permission(
        app_ctx,
        request,
        batch_id,
        batch_orchestrator_module=batch_orchestrator,
    )
    if error_response is not None:
        return error_response, status
    batch_status = batch_orchestrator.get_batch_status(batch_id, runtime=app_ctx) or {}
    if not bool(batch_status.get('can_download_zip', False)):
        return app_ctx.jsonify({'error': 'Batch ZIP is available after at least one row completes.'}), 400
    rows = batch_orchestrator.list_batch_rows(batch_id, runtime=app_ctx)
    export_options = batch.get('export_options', {}) if isinstance(batch.get('export_options', {}), dict) else {}
    include_combined_docx = bool(export_options.get('include_combined_docx', False))
    archive_bytes = app_ctx.io.BytesIO()
    with zipfile.ZipFile(archive_bytes, mode='w', compression=zipfile.ZIP_DEFLATED) as archive:
        summary = {
            'batch_id': batch.get('batch_id', batch_id),
            'mode': batch.get('mode', ''),
            'processing_strategy': batch.get('processing_strategy', 'batch'),
            'status': batch.get('status', ''),
            'total_rows': batch.get('total_rows', len(rows)),
            'completed_rows': batch.get('completed_rows', 0),
            'failed_rows': batch.get('failed_rows', 0),
            'token_input_total': batch.get('token_input_total', 0),
            'token_output_total': batch.get('token_output_total', 0),
            'token_total': batch.get('token_total', 0),
            'export_options': export_options,
        }
        archive.writestr('summary.json', json.dumps(summary, ensure_ascii=False, indent=2))
        if include_combined_docx:
            combined_name = study_export.sanitize_export_filename(
                batch.get('batch_title', '') or f'batch-{batch_id}',
                fallback=f'batch-{batch_id}',
            ) + '_Combined.docx'
            archive.writestr(combined_name, batch_combined_docx_bytes(app_ctx, batch, rows))
        for row in rows:
            row_id = str(row.get('row_id', '') or '')
            folder = f'rows/{row_id}'
            archive.writestr(
                f'{folder}/meta.json',
                json.dumps(
                    batch_orchestrator.build_batch_row_export_metadata(row, batch, runtime=app_ctx),
                    ensure_ascii=False,
                    indent=2,
                    default=str,
                ),
            )
            if row.get('status') != 'complete':
                continue
            try:
                archive.writestr(f'{folder}/result.docx', batch_row_docx_bytes(app_ctx, row, content_type='result'))
                if row.get('slide_text'):
                    archive.writestr(f'{folder}/slides.docx', batch_row_docx_bytes(app_ctx, row, content_type='slides'))
                if row.get('transcript'):
                    archive.writestr(f'{folder}/transcript.docx', batch_row_docx_bytes(app_ctx, row, content_type='transcript'))
                if row.get('interview_summary'):
                    archive.writestr(f'{folder}/summary.docx', batch_row_docx_bytes(app_ctx, row, content_type='summary'))
                if row.get('interview_sections'):
                    archive.writestr(f'{folder}/sections.docx', batch_row_docx_bytes(app_ctx, row, content_type='sections'))
                if row.get('flashcards'):
                    archive.writestr(f'{folder}/flashcards.csv', batch_row_csv_bytes(app_ctx, row, export_type='flashcards'))
                if row.get('test_questions'):
                    archive.writestr(f'{folder}/test_questions.csv', batch_row_csv_bytes(app_ctx, row, export_type='test'))
            except Exception as error:
                archive.writestr(f'{folder}/error.txt', str(error))
    archive_bytes.seek(0)
    filename = f'batch-{batch_id}.zip'
    return app_ctx.send_file(
        archive_bytes,
        mimetype='application/zip',
        as_attachment=True,
        download_name=filename,
    )
