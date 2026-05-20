"""Redaction helpers for upload/import source metadata and tool errors."""

import re
from urllib.parse import urlparse


_URL_RE = re.compile(r'https?://[^\s\'"<>]+', re.IGNORECASE)
_TRAILING_URL_PUNCTUATION = '.,;:)]}'


def redact_source_url(source_url, *, max_chars=500):
    """Return a stable source URL summary without private path/query data."""
    raw_url = str(getattr(source_url, 'url', source_url) or '').strip()
    if not raw_url:
        return ''
    try:
        parsed = urlparse(raw_url)
    except Exception:
        return '[redacted-url]'
    scheme = (parsed.scheme or 'https').lower()
    if scheme not in {'http', 'https'}:
        return '[redacted-url]'
    hostname = str(parsed.hostname or '').strip().lower()
    if not hostname:
        return '[redacted-url]'
    host = f'[{hostname}]' if ':' in hostname and not hostname.startswith('[') else hostname
    if parsed.port:
        host = f'{host}:{parsed.port}'
    has_private_parts = bool((parsed.path and parsed.path != '/') or parsed.query or parsed.fragment)
    suffix = '/[redacted]' if has_private_parts else ''
    return f'{scheme}://{host}{suffix}'[:max(1, int(max_chars or 500))]


def redact_urls_in_text(text, *, max_chars=None):
    """Replace http(s) URLs embedded in external tool text with redacted summaries."""
    value = str(text or '')
    if not value:
        return ''

    def _replace(match):
        url = match.group(0)
        trailing = ''
        while url and url[-1] in _TRAILING_URL_PUNCTUATION:
            trailing = url[-1] + trailing
            url = url[:-1]
        return redact_source_url(url) + trailing

    redacted = _URL_RE.sub(_replace, value)
    if max_chars is None:
        return redacted
    try:
        limit = int(max_chars)
    except Exception:
        limit = 0
    return redacted[:limit] if limit > 0 else ''


def redact_exception(error, *, max_chars=None):
    return redact_urls_in_text(str(error or ''), max_chars=max_chars)
