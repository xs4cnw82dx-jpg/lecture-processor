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
    text = str(raw_title or '').strip()
    if not text:
        return ''
    collapsed = ' '.join(text.split())
    return collapsed[:max_chars].strip()


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
    text = re.sub(r'(?is)<(script|style|noscript|svg|canvas|iframe).*?>.*?</\\1>', ' ', text)
    text = re.sub(r'(?i)<br\\s*/?>', '\n', text)
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


def _fetch_tools_url_text(source_url, max_bytes=1_500_000, max_chars=180000):
    import re
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

    charset = 'utf-8'
    match = re.search(r'charset=([\\w\\-]+)', content_type)
    if match:
        charset = match.group(1).strip().lower() or 'utf-8'
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
    if getattr(app_ctx, 'client', None) is not None:
        return None
    app_ctx.logger.error('AI processing requested while Gemini client is not configured.')
    return app_ctx.jsonify({'error': 'AI processing is temporarily unavailable right now. Please try again later.'}), 503


def _account_write_guard_response(app_ctx, uid):
    allowed, message = account_lifecycle.ensure_account_allows_writes(uid, runtime=app_ctx)
    if allowed:
        return None
    return app_ctx.jsonify({'error': message, 'status': 'account_deletion_in_progress'}), 409


def _attempt_credit_refund(app_ctx, uid, credit_type, expected_floor=None):
    if not uid or not credit_type:
        return False, ''

    expected_floor_value = None
    if expected_floor is not None:
        try:
            expected_floor_value = max(0, int(expected_floor))
        except Exception:
            expected_floor_value = None

    for attempt in range(1, 4):
        try:
            refunded = bool(billing_credits.refund_credit(uid, credit_type, runtime=app_ctx))
        except Exception:
            refunded = False
        if refunded:
            if credit_type == 'slides_credits' and expected_floor_value is not None:
                try:
                    latest_user = app_ctx.get_or_create_user(uid, '')
                    latest_balance = int(latest_user.get('slides_credits', 0) or 0)
                    if latest_balance < expected_floor_value:
                        app_ctx.logger.warning(
                            "Refund reported success but balance verification failed for %s (balance=%s expected>=%s)",
                            uid,
                            latest_balance,
                            expected_floor_value,
                        )
                        if attempt < 3:
                            app_ctx.time.sleep(0.08 * attempt)
                            continue
                except Exception:
                    pass
            return True, 'refund_credit'
        if attempt < 3:
            app_ctx.time.sleep(0.08 * attempt)

    if credit_type == 'slides_credits':
        for fallback_attempt in range(1, 3):
            try:
                refunded = bool(billing_credits.refund_slides_credits(uid, 1, runtime=app_ctx))
                if not refunded:
                    if fallback_attempt < 2:
                        app_ctx.time.sleep(0.08 * fallback_attempt)
                    continue
                try:
                    user_ref = app_ctx.users_repo.doc_ref(app_ctx.db, uid)
                    user_ref.update({'total_processed': app_ctx.firestore.Increment(-1)})
                except Exception:
                    # Keep the refund even when total_processed adjustment fails.
                    pass
                return True, 'fallback_slides_refund'
            except Exception:
                if fallback_attempt < 2:
                    app_ctx.time.sleep(0.08 * fallback_attempt)

    return False, ''


def _queue_full_message():
    return 'The server is busy right now. Please try again in a minute.'


def _queue_full_response(app_ctx, *, job_id='', batch_id=''):
    retry_after_seconds = 15
    payload = {
        'error': _queue_full_message(),
        'status': 'queue_full',
        'retry_after_seconds': retry_after_seconds,
    }
    if job_id:
        payload['job_id'] = str(job_id)
    if batch_id:
        payload['batch_id'] = str(batch_id)
    try:
        queue_stats = app_ctx.get_background_queue_stats()
    except Exception:
        queue_stats = {}
    if isinstance(queue_stats, dict) and queue_stats:
        payload['queue'] = {
            'running': int(queue_stats.get('running', 0) or 0),
            'queued': int(queue_stats.get('queued', 0) or 0),
            'capacity': int(queue_stats.get('capacity', 0) or 0),
        }
    response = app_ctx.jsonify(payload)
    response.status_code = 503
    response.headers['Retry-After'] = str(retry_after_seconds)
    return response


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
    message = _queue_full_message()
    refund_methods = []
    credit_refunded = False
    if credit_type:
        refunded, method = _attempt_credit_refund(
            app_ctx,
            uid,
            credit_type,
            expected_floor=expected_credit_floor,
        )
        if refunded:
            credit_refunded = True
            if method:
                refund_methods.append(method)
    if int(extra_slides_credits or 0) > 0:
        try:
            extras_refunded = bool(
                billing_credits.refund_slides_credits(
                    uid,
                    int(extra_slides_credits or 0),
                    runtime=app_ctx,
                )
            )
        except Exception:
            extras_refunded = False
        if extras_refunded:
            credit_refunded = True
            refund_methods.append('refund_slides_credits')
    runtime_jobs_store.update_job_fields(
        job_id,
        runtime=app_ctx,
        status='error',
        error=message,
        failed_stage='queued',
        provider_error_code='queue_full',
        step_description='Queue full',
        credit_refunded=credit_refunded,
        credit_refund_method=', '.join(refund_methods),
    )
    app_ctx.cleanup_files(list(cleanup_paths or []), [])
    return _queue_full_response(app_ctx, job_id=job_id)


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

    allowed_import, retry_after = rate_limiter.check_rate_limit(
        key=f"audio_import:{rate_limiter.normalize_rate_limit_key_part(uid, fallback='anon_uid', runtime=app_ctx)}",
        limit=app_ctx.VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS,
        runtime=app_ctx,
    )
    if not allowed_import:
        return rate_limiter.build_rate_limited_response(
            'Too many video import attempts right now. Please wait and try again.',
            retry_after,
            runtime=app_ctx,
        )

    data = request.get_json(silent=True) or {}
    safe_url, error_message = upload_import_audio.validate_video_import_url(
        data.get('url', ''),
        runtime=app_ctx,
    )
    if not safe_url:
        return app_ctx.jsonify({'error': error_message}), 400

    upload_import_audio.cleanup_expired_audio_import_tokens(runtime=app_ctx)
    prefix = f"urlimport_{app_ctx.uuid.uuid4().hex}"
    try:
        audio_path, output_name, size_bytes = app_ctx.download_audio_from_video_url(safe_url, prefix)
        token = upload_import_audio.register_audio_import_token(
            uid,
            audio_path,
            safe_url,
            output_name,
            runtime=app_ctx,
        )
        return app_ctx.jsonify({
            'ok': True,
            'audio_import_token': token,
            'file_name': output_name,
            'size_bytes': int(size_bytes),
            'expires_in_seconds': app_ctx.AUDIO_IMPORT_TOKEN_TTL_SECONDS,
        })
    except Exception as e:
        app_ctx.logger.error(f"Error importing audio from URL for user {uid}: {e}")
        return app_ctx.jsonify({'error': 'Could not import audio from URL. Please check that the URL is accessible and try again.'}), 400


def release_imported_audio(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json(silent=True) or {}
    token = str(payload.get('audio_import_token', '') or '').strip()
    if token:
        upload_import_audio.release_audio_import_token(uid, token, runtime=app_ctx)
    return app_ctx.jsonify({'ok': True})


def _parse_batch_rows_payload(request):
    rows_raw = str(request.form.get('rows', '') or '').strip()
    if not rows_raw:
        return []
    try:
        parsed = json.loads(rows_raw)
    except Exception:
        return None
    if not isinstance(parsed, list):
        return None
    rows = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        rows.append(dict(item))
    return rows


def _parse_checkbox_value(raw_value):
    return str(raw_value or '').strip().lower() in {'1', 'true', 'yes', 'on'}


def _batch_user_guard(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return None, None, app_ctx.jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not auth_policy.is_email_allowed(email, runtime=app_ctx):
        return None, None, app_ctx.jsonify({'error': 'Email not allowed'}), 403
    return uid, decoded_token, None, None


def _get_batch_with_permission(app_ctx, request, batch_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return None, None, app_ctx.jsonify({'error': 'Unauthorized'}), 401
    batch = batch_orchestrator.get_batch(batch_id, runtime=app_ctx)
    if not batch:
        return None, None, app_ctx.jsonify({'error': 'Batch not found'}), 404
    uid = decoded_token.get('uid', '')
    if batch.get('uid', '') != uid and not app_ctx.is_admin_user(decoded_token):
        return None, None, app_ctx.jsonify({'error': 'Forbidden'}), 403
    return batch, decoded_token, None, None


def create_batch_job(app_ctx, request):
    uid, decoded_token, error_response, status = _batch_user_guard(app_ctx, request)
    if error_response is not None:
        return error_response, status
    deletion_guard = _account_write_guard_response(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard

    mode = str(request.form.get('mode', 'lecture-notes') or '').strip()
    if mode not in {'lecture-notes', 'slides-only', 'interview'}:
        return app_ctx.jsonify({'error': 'Invalid mode selected'}), 400

    rows = _parse_batch_rows_payload(request)
    if rows is None:
        return app_ctx.jsonify({'error': 'Invalid rows payload'}), 400
    if len(rows) < 2:
        return app_ctx.jsonify({'error': 'Batch mode requires at least 2 rows.'}), 400
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

    batch_title = _sanitize_study_pack_title(request.form.get('batch_title', ''))
    if not batch_title:
        return app_ctx.jsonify({'error': 'Batch title is required.'}), 400

    ai_unavailable = _require_ai_processing_ready(app_ctx)
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
    include_combined_docx = _parse_checkbox_value(request.form.get('include_combined_docx', '0'))

    batch_id = str(app_ctx.uuid.uuid4())
    prepared_rows = []
    cleanup_paths = []
    charged_rows = []
    created_folder_ref = None
    now_ts = app_ctx.time.time()

    try:
        for idx, row_cfg in enumerate(rows, start=1):
            row_id = str(row_cfg.get('row_id', '') or app_ctx.uuid.uuid4())
            slides_required = mode in {'lecture-notes', 'slides-only'}
            audio_required = mode in {'lecture-notes', 'interview'}

            slides_local_path = ''
            slides_field = str(row_cfg.get('slides_file_field', f'row_{idx}_slides') or '').strip()
            if slides_required:
                slides_file = request.files.get(slides_field)
                if not slides_file or slides_file.filename == '':
                    raise ValueError(f'Row {idx}: slides file is required.')
                slides_local_path, slides_error = app_ctx.resolve_uploaded_slides_to_pdf(slides_file, f'{batch_id}_{row_id}')
                if slides_error:
                    raise ValueError(f'Row {idx}: {slides_error}')
                cleanup_paths.append(slides_local_path)

            audio_local_path = ''
            audio_source_type = ''
            audio_source_url = ''
            audio_import_token = str(row_cfg.get('audio_import_token', '') or '').strip()
            audio_url = str(row_cfg.get('audio_m3u8_url', '') or '').strip()
            audio_field = str(row_cfg.get('audio_file_field', f'row_{idx}_audio') or '').strip()
            if audio_required:
                if audio_import_token:
                    audio_local_path, token_error = upload_import_audio.get_audio_import_token_path(
                        uid,
                        audio_import_token,
                        consume=False,
                        runtime=app_ctx,
                    )
                    if token_error:
                        raise ValueError(f'Row {idx}: {token_error}')
                    audio_source_type = 'import_token'
                elif audio_url:
                    safe_url, url_error = upload_import_audio.validate_video_import_url(audio_url, runtime=app_ctx)
                    if not safe_url:
                        raise ValueError(f'Row {idx}: {url_error}')
                    prefix = f'batch_{batch_id}_{row_id}'
                    audio_local_path, _output_name, _size_bytes = app_ctx.download_audio_from_video_url(safe_url, prefix)
                    cleanup_paths.append(audio_local_path)
                    audio_source_type = 'm3u8_url'
                    audio_source_url = safe_url
                else:
                    audio_file = request.files.get(audio_field)
                    if not audio_file or audio_file.filename == '':
                        raise ValueError(f'Row {idx}: audio file is required.')
                    if not app_ctx.allowed_file(audio_file.filename, app_ctx.ALLOWED_AUDIO_EXTENSIONS):
                        raise ValueError(f'Row {idx}: invalid audio file extension.')
                    if (audio_file.mimetype or '').lower() not in app_ctx.ALLOWED_AUDIO_MIME_TYPES:
                        raise ValueError(f'Row {idx}: invalid audio content type.')
                    audio_local_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f'{batch_id}_{row_id}_{app_ctx.secure_filename(audio_file.filename)}')
                    audio_file.save(audio_local_path)
                    cleanup_paths.append(audio_local_path)
                    audio_source_type = 'upload'

                audio_size = app_ctx.get_saved_file_size(audio_local_path)
                if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
                    raise ValueError(f'Row {idx}: audio exceeds server limit or is empty.')
                if not app_ctx.file_looks_like_audio(audio_local_path):
                    raise ValueError(f'Row {idx}: uploaded audio is invalid or unsupported.')

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

            charged_rows.append(
                {
                    'credit_type': charged_credit,
                    'interview_features_cost': interview_features_cost,
                }
            )

            if audio_import_token:
                _consumed_path, token_error = upload_import_audio.get_audio_import_token_path(
                    uid,
                    audio_import_token,
                    consume=True,
                    runtime=app_ctx,
                )
                if token_error:
                    raise ValueError(f'Row {idx}: {token_error}')

            billing_receipt = billing_receipts.initialize_billing_receipt(
                {charged_credit: 1, 'slides_credits': interview_features_cost},
                runtime=app_ctx,
            )
            prepared_rows.append(
                {
                    'row_id': row_id,
                    'ordinal': idx,
                    'status': 'queued',
                    'source_type': audio_source_type if audio_source_type else ('upload' if slides_required else 'audio'),
                    'source_url': audio_source_url,
                    'source_name': f'row-{idx}',
                    'slides_local_path': slides_local_path,
                    'audio_local_path': audio_local_path,
                    'output_language': output_language,
                    'study_features': row_study_features if mode != 'interview' else 'none',
                    'flashcard_selection': row_flashcards,
                    'question_selection': row_questions,
                    'interview_features': row_interview_features,
                    'interview_features_cost': interview_features_cost,
                    'credit_deducted': charged_credit,
                    'credit_refunded': False,
                    'billing_receipt': billing_receipt,
                    'billing_mode': 'batch',
                    'billing_multiplier': 0.5,
                    'token_usage_by_stage': {},
                    'token_input_total': 0,
                    'token_output_total': 0,
                    'token_total': 0,
                    'started_at': now_ts,
                    'created_at': now_ts,
                }
            )
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
            'batch_title': batch_title,
            'output_language': output_language,
            'study_defaults': {
                'study_features': default_study_features,
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
            'billing_mode': 'batch',
            'billing_multiplier': 0.5,
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

        try:
            app_ctx.submit_background_job(
                batch_orchestrator.process_batch_job,
                batch_id,
                runtime=app_ctx,
            )
        except JobQueueFullError:
            batch_orchestrator.mark_batch_submission_error(
                batch_id,
                _queue_full_message(),
                runtime=app_ctx,
            )
            for charged in charged_rows:
                credit_type = str(charged.get('credit_type', '') or '').strip()
                if credit_type:
                    billing_credits.refund_credit(uid, credit_type, runtime=app_ctx)
                extras = int(charged.get('interview_features_cost', 0) or 0)
                if extras > 0:
                    billing_credits.refund_slides_credits(uid, extras, runtime=app_ctx)
            app_ctx.cleanup_files(cleanup_paths, [])
            return _queue_full_response(app_ctx, batch_id=batch_id)
        return app_ctx.jsonify({'batch_id': batch_id})
    except Exception as error:
        if created_folder_ref is not None:
            try:
                created_folder_ref.delete()
            except Exception:
                pass
        for charged in charged_rows:
            credit_type = str(charged.get('credit_type', '') or '').strip()
            if credit_type:
                billing_credits.refund_credit(uid, credit_type, runtime=app_ctx)
            extras = int(charged.get('interview_features_cost', 0) or 0)
            if extras > 0:
                billing_credits.refund_slides_credits(uid, extras, runtime=app_ctx)
        app_ctx.cleanup_files(cleanup_paths, [])
        return app_ctx.jsonify({'error': str(error)}), 400


def list_batch_jobs(app_ctx, request):
    uid, _decoded_token, error_response, status = _batch_user_guard(app_ctx, request)
    if error_response is not None:
        return error_response, status

    mode = str(request.args.get('mode', '') or '').strip()
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
    return app_ctx.jsonify({'batches': batches})


def get_batch_job_status(app_ctx, request, batch_id):
    batch, _decoded, error_response, status = _get_batch_with_permission(app_ctx, request, batch_id)
    if error_response is not None:
        return error_response, status
    status_payload = batch_orchestrator.get_batch_status(batch_id, runtime=app_ctx)
    if not status_payload:
        return app_ctx.jsonify({'error': 'Batch not found'}), 404
    return app_ctx.jsonify(status_payload)


def _batch_row_docx_bytes(app_ctx, row, content_type='result'):
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


def _batch_row_csv_bytes(app_ctx, row, export_type='flashcards'):
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


def _append_combined_markdown_section(parts, title, content):
    text = str(content or '').strip()
    if not text:
        return
    parts.append(f'## {title}')
    parts.append('')
    parts.append(text)
    parts.append('')


def _batch_row_flashcards_markdown(row):
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


def _batch_row_questions_markdown(row):
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


def _batch_row_combined_markdown(batch, row):
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
        _append_combined_markdown_section(parts, 'Lecture Notes', result_text)
        _append_combined_markdown_section(parts, 'Slide Extract', slide_text)
        _append_combined_markdown_section(parts, 'Transcript', transcript_text)
    elif mode == 'slides-only':
        _append_combined_markdown_section(parts, 'Slide Extract', slide_text or result_text)
    elif mode == 'interview':
        _append_combined_markdown_section(parts, 'Transcript', transcript_text or result_text)
        _append_combined_markdown_section(parts, 'Interview Summary', interview_summary)
        _append_combined_markdown_section(parts, 'Structured Transcript', interview_sections)
        if interview_combined and not interview_summary and not interview_sections:
            _append_combined_markdown_section(parts, 'Combined Output', interview_combined)
    else:
        _append_combined_markdown_section(parts, 'Output', result_text)

    flashcards_markdown = _batch_row_flashcards_markdown(row)
    if flashcards_markdown:
        _append_combined_markdown_section(parts, 'Flashcards', flashcards_markdown)

    questions_markdown = _batch_row_questions_markdown(row)
    if questions_markdown:
        _append_combined_markdown_section(parts, 'Practice Questions', questions_markdown)

    return '\n'.join(part for part in parts if part is not None).strip()


def _batch_combined_docx_bytes(app_ctx, batch, rows):
    batch_title = str((batch or {}).get('batch_title', '') or (batch or {}).get('batch_id', '') or 'Batch Combined').strip()
    sections = []
    for row in rows:
        sections.append(_batch_row_combined_markdown(batch, row))
    markdown_text = '\n\n'.join(section for section in sections if str(section or '').strip()).strip()
    if not markdown_text:
        markdown_text = '# Batch Output\n\nNo row output was available when this ZIP was created.'
    doc = study_export.markdown_to_docx(markdown_text, title=batch_title + ' Combined', runtime=app_ctx)
    output = app_ctx.io.BytesIO()
    doc.save(output)
    output.seek(0)
    return output.read()


def download_batch_row_docx(app_ctx, request, batch_id, row_id):
    _batch, _decoded, error_response, status = _get_batch_with_permission(app_ctx, request, batch_id)
    if error_response is not None:
        return error_response, status
    row = batch_orchestrator.get_batch_row(batch_id, row_id, runtime=app_ctx)
    if not row:
        return app_ctx.jsonify({'error': 'Row not found'}), 404
    if row.get('status') != 'complete':
        return app_ctx.jsonify({'error': 'Row is not complete'}), 400
    content_type = request.args.get('type', 'result')
    docx_bytes = _batch_row_docx_bytes(app_ctx, row, content_type=content_type)
    return app_ctx.send_file(
        app_ctx.io.BytesIO(docx_bytes),
        mimetype='application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        as_attachment=True,
        download_name=f'batch-{batch_id}-{row_id}-{content_type}.docx',
    )


def download_batch_row_flashcards_csv(app_ctx, request, batch_id, row_id):
    _batch, _decoded, error_response, status = _get_batch_with_permission(app_ctx, request, batch_id)
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
    csv_bytes = _batch_row_csv_bytes(app_ctx, row, export_type=export_type)
    return app_ctx.send_file(
        app_ctx.io.BytesIO(csv_bytes),
        mimetype='text/csv',
        as_attachment=True,
        download_name=f'batch-{batch_id}-{row_id}-{export_type}.csv',
    )


def download_batch_zip(app_ctx, request, batch_id):
    batch, _decoded, error_response, status = _get_batch_with_permission(app_ctx, request, batch_id)
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
            archive.writestr(combined_name, _batch_combined_docx_bytes(app_ctx, batch, rows))
        for row in rows:
            row_id = str(row.get('row_id', '') or '')
            folder = f'rows/{row_id}'
            archive.writestr(f'{folder}/meta.json', json.dumps(row, ensure_ascii=False, indent=2, default=str))
            if row.get('status') != 'complete':
                continue
            try:
                archive.writestr(f'{folder}/result.docx', _batch_row_docx_bytes(app_ctx, row, content_type='result'))
                if row.get('slide_text'):
                    archive.writestr(f'{folder}/slides.docx', _batch_row_docx_bytes(app_ctx, row, content_type='slides'))
                if row.get('transcript'):
                    archive.writestr(f'{folder}/transcript.docx', _batch_row_docx_bytes(app_ctx, row, content_type='transcript'))
                if row.get('interview_summary'):
                    archive.writestr(f'{folder}/summary.docx', _batch_row_docx_bytes(app_ctx, row, content_type='summary'))
                if row.get('interview_sections'):
                    archive.writestr(f'{folder}/sections.docx', _batch_row_docx_bytes(app_ctx, row, content_type='sections'))
                if row.get('flashcards'):
                    archive.writestr(f'{folder}/flashcards.csv', _batch_row_csv_bytes(app_ctx, row, export_type='flashcards'))
                if row.get('test_questions'):
                    archive.writestr(f'{folder}/test_questions.csv', _batch_row_csv_bytes(app_ctx, row, export_type='test'))
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

    allowed, retry_after = rate_limiter.check_rate_limit(
        key=f"tools_extract:{rate_limiter.normalize_rate_limit_key_part(uid, fallback='anon_uid', runtime=app_ctx)}",
        limit=app_ctx.TOOLS_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.TOOLS_RATE_LIMIT_WINDOW_SECONDS,
        runtime=app_ctx,
    )
    if not allowed:
        analytics_events.log_rate_limit_hit('tools', retry_after, runtime=app_ctx)
        return rate_limiter.build_rate_limited_response(
            'Too many tools extraction attempts right now. Please wait and try again.',
            retry_after,
            runtime=app_ctx,
        )

    user = app_ctx.get_or_create_user(uid, email)
    if int(user.get('slides_credits', 0) or 0) <= 0:
        return app_ctx.jsonify({'error': 'No text extraction credits remaining. Please purchase more credits.'}), 402
    user_text_credits_before = int(user.get('slides_credits', 0) or 0)

    requested_source = request.form.get('source_type', request.form.get('source', 'auto'))
    custom_prompt = _sanitize_tools_custom_prompt(request.form.get('custom_prompt', ''))
    prompt_template_key = _sanitize_tools_template_key(request.form.get('prompt_template_key', ''))
    prompt_source = 'default'
    if prompt_template_key:
        prompt_source = 'template'
    elif custom_prompt:
        prompt_source = 'custom'
    source_url = ''
    uploaded_file = None
    uploaded_image_files = []
    source_type = ''
    extension = ''
    mime_type = ''

    if str(requested_source or '').strip().lower() == 'url':
        source_url, url_error = _sanitize_tools_source_url(request.form.get('source_url', ''))
        if url_error:
            return app_ctx.jsonify({'error': url_error}), 400
        source_type = 'url'
        mime_type = 'text/html'
    else:
        requested_source_key = str(requested_source or '').strip().lower()
        if requested_source_key == 'image':
            uploaded_image_files = [f for f in (request.files.getlist('files') or []) if f and str(f.filename or '').strip()]
            if not uploaded_image_files:
                single_image = request.files.get('file')
                if single_image and str(single_image.filename or '').strip():
                    uploaded_image_files = [single_image]
            if not uploaded_image_files:
                return app_ctx.jsonify({'error': 'Please choose at least one image before running extraction.'}), 400
            if len(uploaded_image_files) > 5:
                return app_ctx.jsonify({'error': 'You can upload up to 5 images per run.'}), 400
            uploaded_file = uploaded_image_files[0]
            source_type, extension, mime_type, detect_error = _detect_tools_source_type(
                app_ctx,
                uploaded_file,
                'image',
            )
        else:
            uploaded_file = request.files.get('file')
            if not uploaded_file or not str(uploaded_file.filename or '').strip():
                return app_ctx.jsonify({'error': 'Please choose a file before running extraction.'}), 400
            source_type, extension, mime_type, detect_error = _detect_tools_source_type(
                app_ctx,
                uploaded_file,
                requested_source,
            )
        if detect_error:
            return app_ctx.jsonify({'error': detect_error}), 400

    job_id = str(app_ctx.uuid.uuid4())
    local_paths = []
    gemini_files = []
    retry_tracker = {}
    deducted_credit = ''
    refunded_credit = False
    provider_error_code = ''
    extracted_markdown = ''
    effective_prompt_preview = ''
    credit_refund_method = ''
    normalized_input_name = ''
    normalized_input_names = []
    docx_text = ''
    upload_mime_type = ''
    upload_path = ''
    uploaded_provider_file = None
    source_size_mb = 0.0
    started_at_ts = app_ctx.time.time()

    try:
        if source_type == 'url':
            normalized_input_name = source_url
            docx_text, source_error, upload_mime_type = _fetch_tools_url_text(source_url)
            if source_error:
                return app_ctx.jsonify({'error': source_error}), 400
            source_size_mb = round(len(docx_text.encode('utf-8')) / (1024 * 1024), 4)
        elif source_type == 'document':
            if mime_type and mime_type not in app_ctx.ALLOWED_TOOLS_DOC_MIME_TYPES:
                return app_ctx.jsonify({'error': 'Unsupported document content type for tools extraction.'}), 400
            if extension == 'docx':
                safe_name = app_ctx.secure_filename(uploaded_file.filename)
                source_docx_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f"tools_{job_id}_{safe_name}")
                uploaded_file.save(source_docx_path)
                local_paths.append(source_docx_path)
                normalized_input_name = app_ctx.os.path.basename(source_docx_path)
                saved_size = app_ctx.get_saved_file_size(source_docx_path)
                if saved_size <= 0 or saved_size > app_ctx.MAX_TOOLS_DOCUMENT_BYTES:
                    app_ctx.cleanup_files(local_paths, gemini_files)
                    local_paths = []
                    return app_ctx.jsonify({
                        'error': f'Document exceeds size limit ({int(app_ctx.MAX_TOOLS_DOCUMENT_BYTES / (1024 * 1024))} MB max) or is empty.'
                    }), 400
                docx_text, docx_error = _extract_docx_text(app_ctx, source_docx_path)
                if docx_error:
                    app_ctx.cleanup_files(local_paths, gemini_files)
                    local_paths = []
                    return app_ctx.jsonify({'error': docx_error}), 400
                source_size_mb = round(saved_size / (1024 * 1024), 4)
            else:
                pdf_path, slides_error = app_ctx.resolve_uploaded_slides_to_pdf(uploaded_file, f"tools_{job_id}")
                if slides_error:
                    return app_ctx.jsonify({'error': slides_error}), 400
                local_paths.append(pdf_path)
                normalized_input_name = app_ctx.os.path.basename(pdf_path)
                saved_size = app_ctx.get_saved_file_size(pdf_path)
                if saved_size <= 0 or saved_size > app_ctx.MAX_TOOLS_DOCUMENT_BYTES:
                    app_ctx.cleanup_files(local_paths, gemini_files)
                    local_paths = []
                    return app_ctx.jsonify({
                        'error': f'Document exceeds size limit ({int(app_ctx.MAX_TOOLS_DOCUMENT_BYTES / (1024 * 1024))} MB max) or is empty.'
                    }), 400
                upload_mime_type = 'application/pdf'
                upload_path = pdf_path
                source_size_mb = round(saved_size / (1024 * 1024), 4)
        else:
            image_inputs = uploaded_image_files if uploaded_image_files else [uploaded_file]
            if len(image_inputs) > 5:
                return app_ctx.jsonify({'error': 'You can upload up to 5 images per run.'}), 400
            total_image_bytes = 0
            for idx, image_file in enumerate(image_inputs):
                image_mime_type = str(getattr(image_file, 'mimetype', '') or '').strip().lower()
                if image_mime_type and image_mime_type not in app_ctx.ALLOWED_TOOLS_IMAGE_MIME_TYPES:
                    app_ctx.cleanup_files(local_paths, gemini_files)
                    local_paths = []
                    return app_ctx.jsonify({'error': 'Unsupported image content type for tools extraction.'}), 400
                if not app_ctx.allowed_file(image_file.filename, app_ctx.ALLOWED_TOOLS_IMAGE_EXTENSIONS):
                    app_ctx.cleanup_files(local_paths, gemini_files)
                    local_paths = []
                    return app_ctx.jsonify({'error': 'Unsupported image file extension.'}), 400
                safe_name = app_ctx.secure_filename(image_file.filename)
                image_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f"tools_{job_id}_{idx + 1}_{safe_name}")
                image_file.save(image_path)
                local_paths.append(image_path)
                normalized_input_names.append(app_ctx.os.path.basename(image_path))
                saved_size = app_ctx.get_saved_file_size(image_path)
                if saved_size <= 0 or saved_size > app_ctx.MAX_TOOLS_IMAGE_BYTES:
                    app_ctx.cleanup_files(local_paths, gemini_files)
                    local_paths = []
                    return app_ctx.jsonify({
                        'error': f'Image exceeds size limit ({int(app_ctx.MAX_TOOLS_IMAGE_BYTES / (1024 * 1024))} MB max) or is empty.'
                    }), 400
                total_image_bytes += saved_size

            normalized_input_name = ', '.join(normalized_input_names)
            source_size_mb = round(total_image_bytes / (1024 * 1024), 4)

        deducted_credit = billing_credits.deduct_credit(uid, 'slides_credits', runtime=app_ctx)
        if not deducted_credit:
            return app_ctx.jsonify({'error': 'No text extraction credits remaining.'}), 402

        prompt = _build_tools_prompt(source_type, custom_prompt)
        effective_prompt_preview = prompt[:1400]
        if docx_text:
            if source_type == 'url':
                source_block_title = f"Source content extracted from URL ({source_url}):"
                operation_name = 'tools_extract_url'
            else:
                source_block_title = 'Source content extracted from DOCX:'
                operation_name = 'tools_extract_document_docx'
            response = ai_provider.generate_with_policy(
                app_ctx.MODEL_TOOLS,
                [app_ctx.types.Content(role='user', parts=[
                    app_ctx.types.Part.from_text(text=prompt),
                    app_ctx.types.Part.from_text(text=f"{source_block_title}\n\n{docx_text}"),
                ])],
                max_output_tokens=32768,
                retry_tracker=retry_tracker,
                operation_name=operation_name,
                runtime=app_ctx,
            )
        else:
            if source_type == 'image':
                image_parts = []
                for index, image_path in enumerate(local_paths):
                    image_mime_type = app_ctx.get_mime_type(image_path) or 'image/jpeg'
                    uploaded_provider_file = ai_provider.run_with_provider_retry(
                        f'tools_image_upload_{index + 1}',
                        lambda p=image_path, m=image_mime_type: app_ctx.client.files.upload(file=p, config={'mime_type': m}),
                        retry_tracker=retry_tracker,
                        runtime=app_ctx,
                    )
                    gemini_files.append(uploaded_provider_file)
                    ai_provider.run_with_provider_retry(
                        f'tools_image_processing_{index + 1}',
                        lambda uploaded=uploaded_provider_file: app_ctx.wait_for_file_processing(uploaded),
                        retry_tracker=retry_tracker,
                        runtime=app_ctx,
                    )
                    image_parts.append(app_ctx.types.Part.from_uri(file_uri=uploaded_provider_file.uri, mime_type=image_mime_type))

                image_parts.append(app_ctx.types.Part.from_text(text=prompt))
                response = ai_provider.generate_with_policy(
                    app_ctx.MODEL_TOOLS,
                    [app_ctx.types.Content(role='user', parts=image_parts)],
                    max_output_tokens=32768,
                    retry_tracker=retry_tracker,
                    operation_name='tools_extract_image',
                    runtime=app_ctx,
                )
            else:
                uploaded_provider_file = ai_provider.run_with_provider_retry(
                    'tools_file_upload',
                    lambda: app_ctx.client.files.upload(file=upload_path, config={'mime_type': upload_mime_type}),
                    retry_tracker=retry_tracker,
                    runtime=app_ctx,
                )
                gemini_files.append(uploaded_provider_file)

                ai_provider.run_with_provider_retry(
                    'tools_file_processing',
                    lambda: app_ctx.wait_for_file_processing(uploaded_provider_file),
                    retry_tracker=retry_tracker,
                    runtime=app_ctx,
                )

                response = ai_provider.generate_with_policy(
                    app_ctx.MODEL_TOOLS,
                    [app_ctx.types.Content(role='user', parts=[
                        app_ctx.types.Part.from_uri(file_uri=uploaded_provider_file.uri, mime_type=upload_mime_type),
                        app_ctx.types.Part.from_text(text=prompt),
                    ])],
                    max_output_tokens=32768,
                    retry_tracker=retry_tracker,
                    operation_name=f'tools_extract_{source_type}',
                    runtime=app_ctx,
                )
        extracted_markdown = str(getattr(response, 'text', '') or '').strip()
        if not extracted_markdown:
            raise ValueError('Extraction returned empty output')

        usage = ai_provider.extract_token_usage(response, runtime=app_ctx)
        stage_usage = {
            **usage,
            'model': app_ctx.MODEL_TOOLS,
            'billing_mode': 'standard',
            'input_modality': 'text' if source_type in {'document', 'url'} else 'image',
        }
        retry_attempts_total = _sum_retry_attempts(retry_tracker)
        analytics_events.log_analytics_event(
            'tools_extract_completed',
            source='backend',
            uid=uid,
            email=email,
            session_id=job_id,
            properties={
                'source_type': source_type,
                'file_name': normalized_input_name,
                'custom_prompt': custom_prompt,
                'prompt_template_key': prompt_template_key,
                'prompt_source': prompt_source,
                'custom_prompt_length': len(custom_prompt),
                'source_url': source_url,
                'retry_attempts': retry_attempts_total,
                'input_tokens': int(usage.get('input_tokens', 0) or 0),
                'output_tokens': int(usage.get('output_tokens', 0) or 0),
            },
            runtime=app_ctx,
        )

        app_ctx.save_job_log(
            job_id,
            {
                'user_id': uid,
                'user_email': email,
                'mode': 'tools',
                'source_type': source_type,
                'source_url': source_url,
                'source_name': normalized_input_name,
                'status': 'complete',
                'credit_deducted': deducted_credit,
                'credit_refunded': False,
                'error': '',
                'failed_stage': '',
                'provider_error_code': '',
                'retry_attempts': retry_attempts_total,
                'token_usage_by_stage': {f'tools_extract_{source_type}': stage_usage},
                'billing_mode': 'standard',
                'token_input_total': int(usage.get('input_tokens', 0) or 0),
                'token_output_total': int(usage.get('output_tokens', 0) or 0),
                'token_total': int(usage.get('total_tokens', 0) or 0),
                'file_size_mb': source_size_mb,
                'custom_prompt': custom_prompt,
                'prompt_template_key': prompt_template_key,
                'prompt_source': prompt_source,
                'custom_prompt_length': len(custom_prompt),
                'effective_prompt_preview': effective_prompt_preview,
                'started_at': started_at_ts,
            },
            app_ctx.time.time(),
        )

        return app_ctx.jsonify({
            'ok': True,
            'source_type': source_type,
            'file_name': normalized_input_name,
            'model': app_ctx.MODEL_TOOLS,
            'output_text': extracted_markdown,
            'content_markdown': extracted_markdown,
            'custom_prompt': custom_prompt,
            'prompt_template_key': prompt_template_key,
            'prompt_source': prompt_source,
            'source_url': source_url,
            'retry_attempts': retry_attempts_total,
            'provider_error_code': '',
            'billing_receipt': {
                'charged': {deducted_credit: 1},
                'refunded': {},
            },
        })
    except Exception as error:
        provider_error_code = ai_provider.classify_provider_error_code(error, runtime=app_ctx)
        app_ctx.logger.exception("Tools extraction failed for user %s source=%s", uid, source_type)
        if deducted_credit and not refunded_credit:
            expected_floor = user_text_credits_before if deducted_credit == 'slides_credits' else None
            refunded_credit, credit_refund_method = _attempt_credit_refund(
                app_ctx,
                uid,
                deducted_credit,
                expected_floor=expected_floor,
            )
        retry_attempts_total = _sum_retry_attempts(retry_tracker)
        analytics_events.log_analytics_event(
            'tools_extract_failed',
            source='backend',
            uid=uid,
            email=email,
            session_id=job_id,
            properties={
                'source_type': source_type or 'unknown',
                'provider_error_code': provider_error_code,
                'custom_prompt': custom_prompt,
                'prompt_template_key': prompt_template_key,
                'prompt_source': prompt_source,
                'custom_prompt_length': len(custom_prompt),
                'source_url': source_url,
                'retry_attempts': retry_attempts_total,
                'credit_refund_method': credit_refund_method,
            },
            runtime=app_ctx,
        )
        app_ctx.save_job_log(
            job_id,
            {
                'user_id': uid,
                'user_email': email,
                'mode': 'tools',
                'source_type': source_type or 'unknown',
                'source_url': source_url,
                'source_name': normalized_input_name,
                'status': 'error',
                'credit_deducted': deducted_credit,
                'credit_refunded': bool(refunded_credit),
                'error': str(error)[:1200],
                'failed_stage': 'tools_extract',
                'provider_error_code': provider_error_code,
                'retry_attempts': retry_attempts_total,
                'token_usage_by_stage': {},
                'billing_mode': 'standard',
                'token_input_total': 0,
                'token_output_total': 0,
                'token_total': 0,
                'file_size_mb': source_size_mb,
                'custom_prompt': custom_prompt,
                'prompt_template_key': prompt_template_key,
                'prompt_source': prompt_source,
                'custom_prompt_length': len(custom_prompt),
                'effective_prompt_preview': effective_prompt_preview,
                'credit_refund_method': credit_refund_method,
                'started_at': started_at_ts,
            },
            app_ctx.time.time(),
        )
        if refunded_credit:
            error_message = 'Tools extraction failed. Your text extraction credit has been refunded.'
        else:
            error_message = 'Tools extraction failed. Refund could not be confirmed automatically, so support has been notified.'
        return app_ctx.jsonify({
            'error': error_message,
            'error_code': 'TOOLS_EXTRACTION_FAILED',
            'provider_error_code': provider_error_code,
            'retry_attempts': retry_attempts_total,
            'refund_confirmed': bool(refunded_credit),
            'credit_refund_method': credit_refund_method,
            'billing_receipt': {
                'charged': {deducted_credit: 1} if deducted_credit else {},
                'refunded': {deducted_credit: 1} if (deducted_credit and refunded_credit) else {},
            },
        }), 502
    finally:
        if local_paths or gemini_files:
            app_ctx.cleanup_files(local_paths, gemini_files)


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
                if (
                    existing is None
                    or float(serialized.get('started_at', 0) or 0) >= float(existing.get('started_at', 0) or 0)
                ):
                    jobs_by_id[serialized['job_id']] = serialized
        except Exception as error:
            app_ctx.logger.warning('Could not load active runtime jobs for user %s: %s', uid, error)

    jobs = sorted(
        jobs_by_id.values(),
        key=lambda row: (
            -float(row.get('started_at', 0) or 0),
            str(row.get('job_id', '') or ''),
        ),
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
        for q in test_questions:
            options = q.get('options', [])
            padded = (options + ['', '', '', ''])[:4]
            writer.writerow(sanitize_csv_row([
                q.get('question', ''),
                padded[0],
                padded[1],
                padded[2],
                padded[3],
                q.get('answer', ''),
                q.get('explanation', ''),
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

    response = {
        'mode': mode,
        'range': {
            'low_seconds': int(low),
            'high_seconds': int(high),
            'typical_seconds': int(typical),
        },
        'sample_count': len(sample),
        'source': source,
    }
    return app_ctx.jsonify(response)


def processing_averages(app_ctx, request):
    from collections import defaultdict

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
