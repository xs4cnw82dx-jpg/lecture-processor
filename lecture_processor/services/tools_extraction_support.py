"""Support helpers for the Tools extraction flow."""


def sanitize_tools_custom_prompt(raw_prompt, max_chars=6000):
    raw_text = str(raw_prompt or '')
    if not raw_text.strip():
        return ''
    normalized = raw_text.replace('\r\n', '\n').replace('\r', '\n')
    # Keep user phrasing verbatim while stripping control chars.
    cleaned = ''.join(
        ch for ch in normalized
        if ch in {'\n', '\t'} or ord(ch) >= 32
    )
    return cleaned[:max_chars].strip()


def sanitize_tools_template_key(raw_key, max_chars=80):
    key = str(raw_key or '').strip().lower()
    if not key:
        return ''
    normalized = ''.join(ch for ch in key[:max_chars] if ch.isalnum() or ch in {'-', '_'})
    return normalized


def sanitize_tools_source_url(raw_url, max_chars=2000):
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


def extract_text_from_html_document(raw_html, max_chars=180000):
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


def extract_content_charset(content_type):
    import re

    header = str(content_type or '').strip().lower()
    if not header:
        return 'utf-8'
    match = re.search(r'charset=([\w\-]+)', header)
    if not match:
        return 'utf-8'
    return match.group(1).strip().lower() or 'utf-8'


def fetch_tools_url_text(source_url, max_bytes=1_500_000, max_chars=180000):
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
            return_fetch_target=True,
        )

    fetch_target, validation_error = _validate_url(source_url)
    if validation_error:
        return '', validation_error, ''
    safe_url = url_security.fetch_target_url(fetch_target)
    pinned_targets = url_security.PinnedFetchTargetRegistry()
    pinned_targets.add(fetch_target)

    request = urllib.request.Request(
        safe_url,
        headers={
            'User-Agent': 'LectureProcessorTools/1.0',
            'Accept': 'text/html,text/plain,application/xhtml+xml;q=0.9,*/*;q=0.5',
        },
    )
    opener = urllib.request.build_opener(
        urllib.request.ProxyHandler({}),
        url_security.IPBoundHTTPHandler(pinned_targets),
        url_security.IPBoundHTTPSHandler(pinned_targets),
        url_security.ValidatingRedirectHandler(_validate_url, on_validated_url=pinned_targets.add),
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

    charset = extract_content_charset(content_type)
    try:
        decoded = raw_bytes.decode(charset, errors='replace')
    except Exception:
        decoded = raw_bytes.decode('utf-8', errors='replace')

    if 'text/html' in content_type or '<html' in decoded.lower():
        extracted = extract_text_from_html_document(decoded, max_chars=max_chars)
    else:
        extracted = '\n'.join(' '.join(line.split()) for line in decoded.splitlines() if line.strip())[:max_chars]

    if not extracted.strip():
        return '', 'No readable text was found at this URL.', content_type

    return extracted.strip(), None, content_type


def build_tools_prompt(source_type, custom_prompt=''):
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
    sanitized_custom = sanitize_tools_custom_prompt(custom_prompt)
    if not sanitized_custom:
        return base_prompt
    return (
        f"{base_prompt}\n\n"
        "Additional user instruction (follow this if it does not conflict with source facts):\n"
        f"{sanitized_custom}"
    )


def extract_docx_text(app_ctx, docx_path, max_chars=180000):
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


def sum_retry_attempts(retry_tracker):
    return sum(int(v or 0) for v in (retry_tracker or {}).values())


def normalize_tools_markdown_for_export(markdown_text):
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


def normalize_export_base_name(raw_title):
    title = str(raw_title or '').strip() or 'tools-extract'
    safe = ''.join(ch if ch.isalnum() or ch in ('-', '_') else '-' for ch in title.lower())
    safe = '-'.join(part for part in safe.split('-') if part)
    return safe[:80] or 'tools-extract'


def detect_tools_source_type(app_ctx, uploaded_file, requested_source):
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
