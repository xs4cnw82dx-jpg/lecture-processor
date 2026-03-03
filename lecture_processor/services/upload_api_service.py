"""Business logic handlers for upload/status/download APIs."""


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


def _sanitize_tools_source_url(raw_url, max_chars=2000):
    from urllib.parse import urlparse

    candidate = str(raw_url or '').strip()
    if not candidate:
        return '', 'Please provide a URL to extract from.'
    if len(candidate) > max_chars:
        return '', 'URL is too long.'
    parsed = urlparse(candidate)
    if parsed.scheme not in {'http', 'https'}:
        return '', 'Only http:// or https:// URLs are supported.'
    if not parsed.netloc:
        return '', 'URL is missing a valid host.'
    host = str(parsed.hostname or '').strip().lower()
    if not host:
        return '', 'URL is missing a valid host.'
    blocked_hosts = {'localhost', '127.0.0.1', '::1'}
    if host in blocked_hosts or host.endswith('.local'):
        return '', 'Local/private URLs are not supported.'
    return candidate, None


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

    request = urllib.request.Request(
        source_url,
        headers={
            'User-Agent': 'LectureProcessorTools/1.0',
            'Accept': 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5',
        },
    )
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            status_code = int(getattr(response, 'status', 200) or 200)
            if status_code >= 400:
                return '', f'Could not read URL (HTTP {status_code}).', ''
            content_type = str(response.headers.get('Content-Type', '') or '').lower()
            raw_bytes = response.read(max_bytes + 1)
    except urllib.error.HTTPError as error:
        return '', f'Could not read URL (HTTP {int(getattr(error, "code", 0) or 0)}).', ''
    except urllib.error.URLError:
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
            "Use maximum available reasoning depth for Gemini 2.5 Flash Lite.\n"
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
            "Use maximum available reasoning depth for Gemini 2.5 Flash Lite.\n"
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
            "Use maximum available reasoning depth for Gemini 2.5 Flash Lite.\n"
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
            refunded = bool(app_ctx.refund_credit(uid, credit_type))
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
                app_ctx.refund_slides_credits(uid, 1)
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
    if not app_ctx.is_email_allowed(email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403

    allowed_import, retry_after = app_ctx.check_rate_limit(
        key=f"audio_import:{app_ctx.normalize_rate_limit_key_part(uid, fallback='anon_uid')}",
        limit=app_ctx.VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed_import:
        return app_ctx.build_rate_limited_response(
            'Too many video import attempts right now. Please wait and try again.',
            retry_after,
        )

    data = request.get_json(silent=True) or {}
    safe_url, error_message = app_ctx.validate_video_import_url(data.get('url', ''))
    if not safe_url:
        return app_ctx.jsonify({'error': error_message}), 400

    app_ctx.cleanup_expired_audio_import_tokens()
    prefix = f"urlimport_{app_ctx.uuid.uuid4().hex}"
    try:
        audio_path, output_name, size_bytes = app_ctx.download_audio_from_video_url(safe_url, prefix)
        token = app_ctx.register_audio_import_token(uid, audio_path, safe_url, output_name)
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
        app_ctx.release_audio_import_token(uid, token)
    return app_ctx.jsonify({'ok': True})


def upload_files(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not app_ctx.is_email_allowed(email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403
    active_jobs = app_ctx.count_active_jobs_for_user(uid)
    if active_jobs >= app_ctx.MAX_ACTIVE_JOBS_PER_USER:
        app_ctx.log_rate_limit_hit('upload', 10)
        return app_ctx.jsonify({
            'error': f'You already have {active_jobs} active processing job(s). Please wait for one to finish before starting another.'
        }), 429
    allowed_upload, retry_after = app_ctx.check_rate_limit(
        key=f"upload:{uid}",
        limit=app_ctx.UPLOAD_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.UPLOAD_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed_upload:
        app_ctx.log_rate_limit_hit('upload', retry_after)
        return app_ctx.build_rate_limited_response(
            'Too many upload attempts right now. Please wait and try again.',
            retry_after,
        )
    requested_bytes = int(request.content_length or 0)
    disk_ok, free_bytes, needed_bytes = app_ctx.has_sufficient_upload_disk_space(requested_bytes)
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
    reserved_daily, daily_retry_after = app_ctx.reserve_daily_upload_bytes(uid, requested_bytes)
    if not reserved_daily:
        app_ctx.log_rate_limit_hit('upload', daily_retry_after)
        return app_ctx.build_rate_limited_response(
            'Daily upload quota reached for your account. Please try again tomorrow.',
            daily_retry_after,
        )
    user = app_ctx.get_or_create_user(uid, email)
    mode = request.form.get('mode', 'lecture-notes')
    flashcard_selection = app_ctx.parse_requested_amount(request.form.get('flashcard_amount', '20'), {'10', '20', '30', 'auto'}, '20')
    question_selection = app_ctx.parse_requested_amount(request.form.get('question_amount', '10'), {'5', '10', '15', 'auto'}, '10')
    preferred_language_key = app_ctx.sanitize_output_language_pref_key(user.get('preferred_output_language', app_ctx.DEFAULT_OUTPUT_LANGUAGE_KEY))
    preferred_language_custom = app_ctx.sanitize_output_language_pref_custom(user.get('preferred_output_language_custom', ''))
    output_language = app_ctx.parse_output_language(
        request.form.get('output_language', preferred_language_key),
        request.form.get('output_language_custom', preferred_language_custom),
    )
    study_features = app_ctx.parse_study_features(request.form.get('study_features', 'none'))
    interview_features = app_ctx.parse_interview_features(request.form.get('interview_features', 'none'))
    audio_import_token = str(request.form.get('audio_import_token', '') or '').strip()
    app_ctx.cleanup_expired_audio_import_tokens()
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
                app_ctx.release_audio_import_token(uid, audio_import_token)
        else:
            audio_path, token_error = app_ctx.get_audio_import_token_path(uid, audio_import_token, consume=False)
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
        deducted = app_ctx.deduct_credit(uid, 'lecture_credits_standard', 'lecture_credits_extended')
        if not deducted:
            app_ctx.cleanup_files([pdf_path, audio_path], [])
            return app_ctx.jsonify({'error': 'No lecture credits remaining.'}), 402
        if imported_audio_used:
            _consumed_path, token_error = app_ctx.get_audio_import_token_path(uid, audio_import_token, consume=True)
            if token_error:
                app_ctx.cleanup_files([pdf_path, audio_path], [])
                app_ctx.refund_credit(uid, deducted)
                return app_ctx.jsonify({'error': token_error}), 400
        total_steps = 4 if study_features != 'none' else 3
        app_ctx.set_job(job_id, {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': total_steps, 'mode': 'lecture-notes', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': app_ctx.time.time(), 'result': None, 'slide_text': None, 'transcript': None, 'flashcard_selection': flashcard_selection, 'question_selection': question_selection, 'study_features': study_features, 'output_language': output_language, 'flashcards': [], 'test_questions': [], 'study_generation_error': None, 'study_pack_id': None, 'error': None, 'failed_stage': '', 'provider_error_code': '', 'retry_attempts': 0, 'file_size_mb': round(((pdf_size if pdf_size > 0 else 0) + audio_size) / (1024 * 1024), 2), 'billing_receipt': app_ctx.initialize_billing_receipt({deducted: 1})})
        thread = app_ctx.threading.Thread(target=app_ctx.process_lecture_notes, args=(job_id, pdf_path, audio_path))
        thread.start()

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
        deducted = app_ctx.deduct_credit(uid, 'slides_credits')
        if not deducted:
            app_ctx.cleanup_files([pdf_path], [])
            return app_ctx.jsonify({'error': 'No text extraction credits remaining.'}), 402
        total_steps = 2 if study_features != 'none' else 1
        app_ctx.set_job(job_id, {'status': 'starting', 'step': 0, 'step_description': 'Starting...', 'total_steps': total_steps, 'mode': 'slides-only', 'user_id': uid, 'user_email': email, 'credit_deducted': deducted, 'credit_refunded': False, 'started_at': app_ctx.time.time(), 'result': None, 'flashcard_selection': flashcard_selection, 'question_selection': question_selection, 'study_features': study_features, 'output_language': output_language, 'flashcards': [], 'test_questions': [], 'study_generation_error': None, 'study_pack_id': None, 'error': None, 'failed_stage': '', 'provider_error_code': '', 'retry_attempts': 0, 'file_size_mb': round((pdf_size if pdf_size > 0 else 0) / (1024 * 1024), 2), 'billing_receipt': app_ctx.initialize_billing_receipt({deducted: 1})})
        thread = app_ctx.threading.Thread(target=app_ctx.process_slides_only, args=(job_id, pdf_path))
        thread.start()

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
                app_ctx.release_audio_import_token(uid, audio_import_token)
        else:
            audio_path, token_error = app_ctx.get_audio_import_token_path(uid, audio_import_token, consume=False)
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
        deducted = app_ctx.deduct_interview_credit(uid)
        if not deducted:
            app_ctx.cleanup_files([audio_path], [])
            return app_ctx.jsonify({'error': 'No interview credits remaining.'}), 402
        interview_features_cost = len(interview_features)
        if interview_features_cost > 0:
            if user.get('slides_credits', 0) < interview_features_cost:
                app_ctx.refund_credit(uid, deducted)
                app_ctx.cleanup_files([audio_path], [])
                return app_ctx.jsonify({'error': f'Not enough text extraction credits for interview extras. You selected {interview_features_cost} option(s) and need {interview_features_cost} text extraction credits.'}), 402
            if not app_ctx.deduct_slides_credits(uid, interview_features_cost):
                app_ctx.refund_credit(uid, deducted)
                app_ctx.cleanup_files([audio_path], [])
                return app_ctx.jsonify({'error': 'Could not reserve text extraction credits for interview extras. Please try again.'}), 402
        if imported_audio_used:
            _consumed_path, token_error = app_ctx.get_audio_import_token_path(uid, audio_import_token, consume=True)
            if token_error:
                app_ctx.cleanup_files([audio_path], [])
                app_ctx.refund_credit(uid, deducted)
                if interview_features_cost > 0:
                    app_ctx.refund_slides_credits(uid, interview_features_cost)
                return app_ctx.jsonify({'error': token_error}), 400
        total_steps = 2 if interview_features_cost > 0 else 1
        app_ctx.set_job(job_id, {
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
            'billing_receipt': app_ctx.initialize_billing_receipt({deducted: 1, 'slides_credits': interview_features_cost}),
        })
        thread = app_ctx.threading.Thread(target=app_ctx.process_interview_transcription, args=(job_id, audio_path))
        thread.start()
    else:
        return app_ctx.jsonify({'error': 'Invalid mode selected'}), 400

    created_job = app_ctx.get_job_snapshot(job_id) or {}
    app_ctx.log_analytics_event(
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
    )

    return app_ctx.jsonify({'job_id': job_id})


def tools_extract(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not app_ctx.is_email_allowed(email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403

    allowed, retry_after = app_ctx.check_rate_limit(
        key=f"tools_extract:{app_ctx.normalize_rate_limit_key_part(uid, fallback='anon_uid')}",
        limit=app_ctx.TOOLS_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.TOOLS_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed:
        app_ctx.log_rate_limit_hit('tools', retry_after)
        return app_ctx.build_rate_limited_response(
            'Too many tools extraction attempts right now. Please wait and try again.',
            retry_after,
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
            if mime_type and mime_type not in app_ctx.ALLOWED_TOOLS_IMAGE_MIME_TYPES:
                return app_ctx.jsonify({'error': 'Unsupported image content type for tools extraction.'}), 400
            if not app_ctx.allowed_file(uploaded_file.filename, app_ctx.ALLOWED_TOOLS_IMAGE_EXTENSIONS):
                return app_ctx.jsonify({'error': 'Unsupported image file extension.'}), 400
            safe_name = app_ctx.secure_filename(uploaded_file.filename)
            image_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f"tools_{job_id}_{safe_name}")
            uploaded_file.save(image_path)
            local_paths.append(image_path)
            normalized_input_name = app_ctx.os.path.basename(image_path)
            saved_size = app_ctx.get_saved_file_size(image_path)
            if saved_size <= 0 or saved_size > app_ctx.MAX_TOOLS_IMAGE_BYTES:
                app_ctx.cleanup_files(local_paths, gemini_files)
                local_paths = []
                return app_ctx.jsonify({
                    'error': f'Image exceeds size limit ({int(app_ctx.MAX_TOOLS_IMAGE_BYTES / (1024 * 1024))} MB max) or is empty.'
                }), 400
            upload_mime_type = mime_type or app_ctx.get_mime_type(uploaded_file.filename) or 'image/jpeg'
            upload_path = image_path
            source_size_mb = round(saved_size / (1024 * 1024), 4)

        deducted_credit = app_ctx.deduct_credit(uid, 'slides_credits')
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
            response = app_ctx.generate_with_policy(
                app_ctx.MODEL_TOOLS,
                [app_ctx.types.Content(role='user', parts=[
                    app_ctx.types.Part.from_text(text=prompt),
                    app_ctx.types.Part.from_text(text=f"{source_block_title}\n\n{docx_text}"),
                ])],
                max_output_tokens=32768,
                retry_tracker=retry_tracker,
                operation_name=operation_name,
            )
        else:
            uploaded_provider_file = app_ctx.run_with_provider_retry(
                'tools_file_upload',
                lambda: app_ctx.client.files.upload(file=upload_path, config={'mime_type': upload_mime_type}),
                retry_tracker=retry_tracker,
            )
            gemini_files.append(uploaded_provider_file)

            app_ctx.run_with_provider_retry(
                'tools_file_processing',
                lambda: app_ctx.wait_for_file_processing(uploaded_provider_file),
                retry_tracker=retry_tracker,
            )

            response = app_ctx.generate_with_policy(
                app_ctx.MODEL_TOOLS,
                [app_ctx.types.Content(role='user', parts=[
                    app_ctx.types.Part.from_uri(file_uri=uploaded_provider_file.uri, mime_type=upload_mime_type),
                    app_ctx.types.Part.from_text(text=prompt),
                ])],
                max_output_tokens=32768,
                retry_tracker=retry_tracker,
                operation_name=f'tools_extract_{source_type}',
            )
        extracted_markdown = str(getattr(response, 'text', '') or '').strip()
        if not extracted_markdown:
            raise ValueError('Extraction returned empty output')

        usage = app_ctx.extract_token_usage(response)
        retry_attempts_total = _sum_retry_attempts(retry_tracker)
        app_ctx.log_analytics_event(
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
                'token_usage_by_stage': {f'tools_extract_{source_type}': usage},
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
        provider_error_code = app_ctx.classify_provider_error_code(error)
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
        app_ctx.log_analytics_event(
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
    if not app_ctx.is_email_allowed(email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403

    payload = request.get_json(silent=True) or {}
    export_format = str(payload.get('format', 'docx') or '').strip().lower()
    markdown = str(payload.get('content_markdown', '') or '').strip()
    title = str(payload.get('title', 'Tools Extract') or '').strip()

    if export_format != 'docx':
        return app_ctx.jsonify({'error': 'Unsupported export format.'}), 400
    if not markdown:
        return app_ctx.jsonify({'error': 'No extracted content to export.'}), 400
    if len(markdown) > 800000:
        return app_ctx.jsonify({'error': 'Export content is too large. Please shorten the result and retry.'}), 400

    export_markdown = _normalize_tools_markdown_for_export(markdown)
    doc = app_ctx.markdown_to_docx(export_markdown, title or 'Tools Extract')
    docx_io = app_ctx.io.BytesIO()
    doc.save(docx_io)
    docx_io.seek(0)
    base_name = _normalize_export_base_name(title)

    app_ctx.log_analytics_event(
        'tools_export_requested',
        source='backend',
        uid=uid,
        email=email,
        session_id=app_ctx.uuid.uuid4().hex,
        properties={'format': export_format},
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
    job = app_ctx.get_job_snapshot(job_id)
    if not job:
        app_ctx.cleanup_old_jobs()
        job = app_ctx.get_job_snapshot(job_id)
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
    billing_receipt = app_ctx.get_billing_receipt_snapshot(job)
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
    elif job['status'] == 'error':
        response['error'] = job['error']
        response['credit_refunded'] = job.get('credit_refunded', False)
    return app_ctx.jsonify(response)


def download_docx(app_ctx, request, job_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = app_ctx.get_job_snapshot(job_id)
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

    doc = app_ctx.markdown_to_docx(content, title)
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
    job = app_ctx.get_job_snapshot(job_id)
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
            writer.writerow([
                q.get('question', ''),
                padded[0],
                padded[1],
                padded[2],
                padded[3],
                q.get('answer', ''),
                q.get('explanation', ''),
            ])
        filename = f'practice-test-{job_id}.csv'
    else:
        flashcards = job.get('flashcards', [])
        if not flashcards:
            return app_ctx.jsonify({'error': 'No flashcards available for this job'}), 400
        writer.writerow(['question', 'answer'])
        for card in flashcards:
            writer.writerow([card.get('front', ''), card.get('back', '')])
        filename = f'flashcards-{job_id}.csv'

    csv_bytes = app_ctx.io.BytesIO(output.getvalue().encode('utf-8'))
    csv_bytes.seek(0)
    return app_ctx.send_file(csv_bytes, mimetype='text/csv', as_attachment=True, download_name=filename)
