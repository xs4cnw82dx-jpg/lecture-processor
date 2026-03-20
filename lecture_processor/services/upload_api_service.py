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
from lecture_processor.domains.rate_limit import quotas as rate_limit_quotas
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
    upload_runtime_service,
)


def _sanitize_tools_custom_prompt(raw_prompt, max_chars=6000):
    raw_text = str(raw_prompt or '')
    if not raw_text.strip():
        return ''
    normalized = raw_text.replace('\r\n', '\n').replace('\r', '\n')
    # Keep user phrasing verbatim (including line breaks) while stripping control chars.
    cleaned = ''.join(
        ch for ch in normalized
        if ch in {'\n', '\t'} or ord(ch) >= 32
    )
    return cleaned[:max_chars].strip()


def _sanitize_tools_template_key(raw_key, max_chars=80):
    key = str(raw_key or '').strip().lower()
    if not key:
        return ''
    normalized = ''.join(ch for ch in key[:max_chars] if ch.isalnum() or ch in {'-', '_'})
    return normalized


def _sanitize_study_pack_title(raw_title, max_chars=120):
    return upload_batch_support.sanitize_study_pack_title(raw_title, max_chars=max_chars)


def _sanitize_tools_source_url(raw_url, max_chars=2000):
    from lecture_processor.services import url_security

    candidate = str(raw_url or '').strip()
    if not candidate:
        return '', 'Please provide a URL to extract from.'
    if len(candidate) > max_chars:
        return '', 'URL is too long.'
    safe_url, error = url_security.validate_external_url_for_fetch(
        candidate,
        allowed_schemes=('http', 'https'),
        allow_credentials=False,
        allow_non_standard_ports=False,
        resolve_dns=True,
    )
    if error:
        return '', error
    return safe_url, None


def _extract_text_from_html_document(raw_html, max_chars=180000):
    import html as html_lib
    import re

    text = str(raw_html or '')
    if not text:
        return ''
    text = re.sub(r'(?is)<(script|style|noscript|svg|canvas|iframe).*?>.*?</\1>', ' ', text)
    text = re.sub(r'(?i)<br\s*/?>', '\n', text)
    text = re.sub(r'(?i)</(p|div|li|section|article|h1|h2|h3|h4|h5|h6|tr|td|th)>', '\n', text)
    text = re.sub(r'(?is)<[^>]+>', ' ', text)
    text = html_lib.unescape(text)
    lines = []
    for line in text.splitlines():
        compact = ' '.join(line.split())
        if compact:
            lines.append(compact)
    merged = '\n'.join(lines).strip()
    return merged[:max_chars]


def _extract_content_charset(content_type):
    import re

    header = str(content_type or '').strip().lower()
    if not header:
        return 'utf-8'
    match = re.search(r'charset=([\w\-]+)', header)
    if not match:
        return 'utf-8'
    return match.group(1).strip().lower() or 'utf-8'


def _fetch_tools_url_text(source_url, max_bytes=1_500_000, max_chars=180000):
    import urllib.error
    import urllib.request
    from lecture_processor.services import url_security

    def _validate_url(candidate_url):
        return url_security.validate_external_url_for_fetch(
            candidate_url,
            allowed_schemes=('http', 'https'),
            allow_credentials=False,
            allow_non_standard_ports=False,
            resolve_dns=True,
        )

    safe_url, validation_error = _validate_url(source_url)
    if validation_error:
        return '', validation_error, ''

    request = urllib.request.Request(
        safe_url,
        headers={
            'User-Agent': 'LectureProcessorTools/1.0',
            'Accept': 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5',
        },
    )
    opener = urllib.request.build_opener(
        url_security.ValidatingRedirectHandler(_validate_url),
    )
    try:
        with opener.open(request, timeout=20) as response:
            status_code = int(getattr(response, 'status', 200) or 200)
            if status_code >= 400:
                return '', f'Could not read URL (HTTP {status_code}).', ''
            content_type = str(response.headers.get('Content-Type', '') or '').lower()
            raw_bytes = response.read(max_bytes + 1)
    except urllib.error.HTTPError as error:
        return '', f'Could not read URL (HTTP {int(getattr(error, "code", 0) or 0)}).', ''
    except urllib.error.URLError as error:
        reason = str(getattr(error, 'reason', '') or '').lower()
        if 'restricted network address' in reason or 'not allowed' in reason:
            return '', 'This URL host is not allowed.', ''
        if 'could not resolve' in reason:
            return '', 'Could not resolve that URL host.', ''
        return '', 'Could not connect to that URL.', ''
    except Exception:
        return '', 'Could not read that URL right now. Please try again.', ''

    if len(raw_bytes) > max_bytes:
        return '', 'URL content is too large to process.', content_type

    charset = _extract_content_charset(content_type)
    try:
        decoded = raw_bytes.decode(charset, errors='replace')
    except Exception:
        decoded = raw_bytes.decode('utf-8', errors='replace')

    if 'text/html' in content_type or '<html' in decoded.lower():
        extracted = _extract_text_from_html_document(decoded, max_chars=max_chars)
    else:
        extracted = '\n'.join(' '.join(line.split()) for line in decoded.splitlines() if line.strip())[:max_chars]

    if not extracted.strip():
        return '', 'No readable text was found at this URL.', content_type

    return extracted.strip(), None, content_type


def _build_tools_prompt(source_type, custom_prompt=''):
    if source_type == 'image':
        base_prompt = (
            "You are a study extraction assistant.\n"
            "Read the uploaded image and return structured markdown only.\n"
            "Output sections in this order:\n"
            "1. # Raw Text (verbatim OCR where possible)\n"
            "2. # Structured Notes (clean bullet points)\n"
            "3. # Key Terms (term: concise definition)\n"
            "4. # Open Questions (uncertain or ambiguous parts)\n"
            "Do not fabricate details. If text is unreadable, say so explicitly.\n"
            "Use maximum available reasoning depth for Gemini 3.1 Flash-Lite Preview.\n"
            "Use clean markdown with valid headings and bullet lists only.\n"
            "Do not use malformed list markers like '- 1. item'."
        )
    elif source_type == 'url':
        base_prompt = (
            "You are a study extraction assistant.\n"
            "Read the extracted webpage text and return structured markdown only.\n"
            "Output sections in this order:\n"
            "1. # Source Summary\n"
            "2. # Extracted Outline\n"
            "3. # Key Terms (term: concise definition)\n"
            "4. # Review Questions\n"
            "Use only facts present in the source text.\n"
            "Use maximum available reasoning depth for Gemini 3.1 Flash-Lite Preview.\n"
            "Use clean markdown with valid headings and bullet lists only.\n"
            "Do not use malformed list markers like '- 1. item'."
        )
    else:
        base_prompt = (
            "You are a study extraction assistant.\n"
            "Read the uploaded document and return structured markdown only.\n"
            "Output sections in this order:\n"
            "1. # Extracted Outline\n"
            "2. # Detailed Notes\n"
            "3. # Key Terms (term: concise definition)\n"
            "4. # Review Questions\n"
            "Preserve important formulas, lists, and headings. Do not invent missing content.\n"
            "Use maximum available reasoning depth for Gemini 3.1 Flash-Lite Preview.\n"
            "Use clean markdown with valid headings and bullet lists only.\n"
            "Prefer '-' for bullet points and avoid malformed nested list markers.\n"
            "Do not use malformed list markers like '- 1. item'."
        )
    sanitized_custom = _sanitize_tools_custom_prompt(custom_prompt)
    if not sanitized_custom:
        return base_prompt
    return (
        f"{base_prompt}\n\n"
        "Additional user instruction (follow this if it does not conflict with source facts):\n"
        f"{sanitized_custom}"
    )


def _extract_docx_text(app_ctx, docx_path, max_chars=180000):
    try:
        document = app_ctx.Document(docx_path)
    except Exception:
        return '', 'Uploaded DOCX file is invalid or unreadable.'
    chunks = []
    total_chars = 0
    for paragraph in getattr(document, 'paragraphs', []) or []:
        text = str(getattr(paragraph, 'text', '') or '').strip()
        if not text:
            continue
        chunks.append(text)
        total_chars += len(text)
        if total_chars >= max_chars:
            break
    merged = '\n\n'.join(chunks).strip()
    if not merged:
        return '', 'DOCX appears to be empty. Please upload a document with readable text.'
    return merged[:max_chars], None


def _sum_retry_attempts(retry_tracker):
    return sum(int(v or 0) for v in (retry_tracker or {}).values())


def _require_ai_processing_ready(app_ctx):
    return upload_batch_support.require_ai_processing_ready(app_ctx)


def _account_write_guard_response(app_ctx, uid):
    return upload_batch_support.account_write_guard_response(app_ctx, uid)


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


def _normalize_tools_markdown_for_export(markdown_text):
    import re

    normalized_lines = []
    for raw_line in str(markdown_text or '').splitlines():
        line = raw_line.replace('\t', '    ').rstrip()
        stripped = line.strip()
        if not stripped:
            normalized_lines.append('')
            continue
        if stripped in {'*', '-', '•', '* *', '- -'}:
            continue

        line = re.sub(r'^(\s*)[-*•]\s+(\d+[\.)]\s+)', r'\1\2', line)
        line = re.sub(r'^(\s*)•\s+', r'\1- ', line)

        bullet_match = re.match(r'^(\s*)[-*•]\s+(.*)$', line)
        if bullet_match:
            base_indent = bullet_match.group(1)
            content = bullet_match.group(2).strip()
            extra_depth = 0
            while True:
                nested = re.match(r'^[-*•]\s+(.*)$', content)
                if not nested:
                    break
                content = nested.group(1).strip()
                extra_depth += 1
            if content:
                adjusted_indent = base_indent + ('  ' * extra_depth)
                line = f"{adjusted_indent}- {content}"
            else:
                continue

        heading_match = re.match(r'^\s*-\s+\*\*(.+?)\*\*:\s*$', line)
        if heading_match:
            heading_text = heading_match.group(1).strip()
            if heading_text:
                line = f"## {heading_text}"

        if re.match(r'^\s*[-*•]\s*$', line):
            continue
        normalized_lines.append(line)

    merged = '\n'.join(normalized_lines)
    merged = re.sub(r'\n{3,}', '\n\n', merged)
    return merged.strip()


def _normalize_export_base_name(raw_title):
    title = str(raw_title or '').strip() or 'tools-extract'
    safe = ''.join(ch if ch.isalnum() or ch in ('-', '_') else '-' for ch in title.lower())
    safe = '-'.join(part for part in safe.split('-') if part)
    return safe[:80] or 'tools-extract'


def _detect_tools_source_type(app_ctx, uploaded_file, requested_source):
    filename = str(getattr(uploaded_file, 'filename', '') or '') if uploaded_file else ''
    lower_name = filename.strip().lower()
    extension = lower_name.rsplit('.', 1)[-1] if '.' in lower_name else ''
    mime_type = str(getattr(uploaded_file, 'mimetype', '') or '').strip().lower() if uploaded_file else ''

    is_doc = extension in app_ctx.ALLOWED_TOOLS_DOC_EXTENSIONS
    is_image = extension in app_ctx.ALLOWED_TOOLS_IMAGE_EXTENSIONS
    requested = str(requested_source or 'auto').strip().lower()
    if requested not in {'auto', 'document', 'image', 'url'}:
        requested = 'auto'
    if requested == 'url':
        return 'url', extension, mime_type, None

    if requested == 'document':
        if not is_doc:
            return None, extension, mime_type, 'Please upload a PDF, PPTX, or DOCX document for Document Reader.'
        return 'document', extension, mime_type, None
    if requested == 'image':
        if not is_image:
            return None, extension, mime_type, 'Please upload an image file for Image Reader.'
        return 'image', extension, mime_type, None

    if is_doc:
        return 'document', extension, mime_type, None
    if is_image:
        return 'image', extension, mime_type, None
    if requested == 'auto' and not uploaded_file:
        return None, extension, mime_type, 'Please upload a file or switch to URL Reader.'
    return None, extension, mime_type, 'Unsupported file type. Upload PDF, PPTX, DOCX, PNG, JPG, JPEG, WEBP, HEIC, or HEIF.'


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


def list_batch_jobs(app_ctx, request):
    return upload_batch_service.list_batch_jobs(app_ctx, request)


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
    requested_bytes = int(request.content_length or 0)
    disk_ok, free_bytes, needed_bytes = rate_limit_quotas.has_sufficient_upload_disk_space(
        requested_bytes,
        runtime=app_ctx,
    )
    if not disk_ok:
        app_ctx.logger.warning(
            "Upload rejected due to low disk space: free=%s needed=%s uid=%s",
            free_bytes,
            needed_bytes,
            uid,
        )
        return app_ctx.jsonify({
            'error': 'Upload temporarily unavailable due to low server storage. Please try again later.'
        }), 503
    reserved_daily, daily_retry_after = rate_limit_quotas.reserve_daily_upload_bytes(
        uid,
        requested_bytes,
        runtime=app_ctx,
    )
    if not reserved_daily:
        analytics_events.log_rate_limit_hit('upload', daily_retry_after, runtime=app_ctx)
        return rate_limiter.build_rate_limited_response(
            'Daily upload quota reached for your account. Please try again tomorrow.',
            daily_retry_after,
            runtime=app_ctx,
        )
    daily_quota_committed = False
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
            total_lecture = user.get('lecture_credits_standard', 0) + user.get('lecture_credits_extended', 0)
            if total_lecture <= 0:
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
                app_ctx.cleanup_files([pdf_path, audio_path], [])
                return app_ctx.jsonify({'error': 'Audio exceeds server limit (max 500MB) or is empty.'}), 400
            if not app_ctx.file_looks_like_audio(audio_path):
                app_ctx.cleanup_files([pdf_path, audio_path], [])
                return app_ctx.jsonify({'error': 'Uploaded audio file is invalid or unsupported.'}), 400
            ai_unavailable = _require_ai_processing_ready(app_ctx)
            if ai_unavailable is not None:
                app_ctx.cleanup_files([pdf_path, audio_path], [])
                return ai_unavailable
            deducted = billing_credits.deduct_credit(
                uid,
                'lecture_credits_standard',
                'lecture_credits_extended',
                runtime=app_ctx,
            )
            if not deducted:
                app_ctx.cleanup_files([pdf_path, audio_path], [])
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
            runtime_jobs_store.set_job(job_id, {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': total_steps, 'mode': 'lecture-notes', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': app_ctx.time.time(), 'result': None, 'slide_text': None, 'transcript': None, 'flashcard_selection': flashcard_selection, 'question_selection': question_selection, 'study_features': study_features, 'output_language': output_language, 'flashcards': [], 'test_questions': [], 'study_generation_error': None, 'study_pack_id': None, 'study_pack_title': study_pack_title, 'error': None, 'failed_stage': '', 'provider_error_code': '', 'retry_attempts': 0, 'file_size_mb': round(((pdf_size if pdf_size > 0 else 0) + audio_size) / (1024 * 1024), 2), 'billing_receipt': billing_receipts.initialize_billing_receipt({deducted: 1}, runtime=app_ctx)}, runtime=app_ctx)
            try:
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

        elif mode == 'slides-only':
            if user.get('slides_credits', 0) <= 0:
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
            ai_unavailable = _require_ai_processing_ready(app_ctx)
            if ai_unavailable is not None:
                app_ctx.cleanup_files([pdf_path], [])
                return ai_unavailable
            deducted = billing_credits.deduct_credit(uid, 'slides_credits', runtime=app_ctx)
            if not deducted:
                app_ctx.cleanup_files([pdf_path], [])
                return app_ctx.jsonify({'error': 'No text extraction credits remaining.'}), 402
            total_steps = 2 if study_features != 'none' else 1
            runtime_jobs_store.set_job(job_id, {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': total_steps, 'mode': 'slides-only', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': app_ctx.time.time(), 'result': None, 'flashcard_selection': flashcard_selection, 'question_selection': question_selection, 'study_features': study_features, 'output_language': output_language, 'flashcards': [], 'test_questions': [], 'study_generation_error': None, 'study_pack_id': None, 'study_pack_title': study_pack_title, 'error': None, 'failed_stage': '', 'provider_error_code': '', 'retry_attempts': 0, 'file_size_mb': round((pdf_size if pdf_size > 0 else 0) / (1024 * 1024), 2), 'billing_receipt': billing_receipts.initialize_billing_receipt({deducted: 1}, runtime=app_ctx)}, runtime=app_ctx)
            try:
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

        elif mode == 'interview':
            total_interview = user.get('interview_credits_short', 0) + user.get('interview_credits_medium', 0) + user.get('interview_credits_long', 0)
            if total_interview <= 0:
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
                app_ctx.cleanup_files([audio_path], [])
                return app_ctx.jsonify({'error': 'Audio exceeds server limit (max 500MB) or is empty.'}), 400
            if not app_ctx.file_looks_like_audio(audio_path):
                app_ctx.cleanup_files([audio_path], [])
                return app_ctx.jsonify({'error': 'Uploaded audio file is invalid or unsupported.'}), 400
            ai_unavailable = _require_ai_processing_ready(app_ctx)
            if ai_unavailable is not None:
                app_ctx.cleanup_files([audio_path], [])
                return ai_unavailable
            deducted = billing_credits.deduct_interview_credit(uid, runtime=app_ctx)
            if not deducted:
                app_ctx.cleanup_files([audio_path], [])
                return app_ctx.jsonify({'error': 'No interview credits remaining.'}), 402
            interview_features_cost = len(interview_features)
            if interview_features_cost > 0:
                if user.get('slides_credits', 0) < interview_features_cost:
                    billing_credits.refund_credit(uid, deducted, runtime=app_ctx)
                    app_ctx.cleanup_files([audio_path], [])
                    return app_ctx.jsonify({'error': f'Not enough text extraction credits for interview extras. You selected {interview_features_cost} option(s) and need {interview_features_cost} text extraction credits.'}), 402
                if not billing_credits.deduct_slides_credits(uid, interview_features_cost, runtime=app_ctx):
                    billing_credits.refund_credit(uid, deducted, runtime=app_ctx)
                    app_ctx.cleanup_files([audio_path], [])
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
            try:
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
        else:
            return app_ctx.jsonify({'error': 'Invalid mode selected'}), 400

        daily_quota_committed = True
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
        if reserved_daily and not daily_quota_committed:
            rate_limit_quotas.release_daily_upload_bytes(uid, requested_bytes, runtime=app_ctx)


def tools_extract(app_ctx, request):
    from lecture_processor.services import tools_extraction_service

    return tools_extraction_service.tools_extract(app_ctx, request)


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
