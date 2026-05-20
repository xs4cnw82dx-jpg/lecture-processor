import os
import uuid
from urllib.parse import urlparse

from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _host_matches_allowed_suffix(hostname, allowed_suffixes):
    if not hostname:
        return False
    host = hostname.strip().lower()
    return any((host == suffix or host.endswith('.' + suffix) for suffix in allowed_suffixes))


def validate_video_import_fetch_target(raw_url, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    url_security = resolved_runtime.url_security
    url = str(raw_url or '').strip()
    if not url:
        return ('', 'Please paste a video URL.')
    if len(url) > resolved_runtime.VIDEO_IMPORT_MAX_URL_LENGTH:
        return ('', 'Video URL is too long.')

    fetch_target, validation_error = url_security.validate_external_url_for_fetch(
        url,
        allowed_schemes=('https',),
        allow_credentials=False,
        allow_non_standard_ports=False,
        resolve_dns=True,
        return_fetch_target=True,
    )
    if validation_error:
        if 'resolves to a restricted network address' in validation_error:
            return ('', 'This video host resolves to a restricted network address.')
        if 'not allowed' in validation_error:
            return ('', 'This video host is not allowed.')
        return ('', validation_error)

    host = str(getattr(fetch_target, 'host', '') or '').strip().lower()
    if not host:
        host = str(urlparse(resolved_url(fetch_target)).hostname or '').strip().lower()
    if not host:
        return ('', 'Video URL host is missing.')
    allowed_suffixes = tuple(getattr(resolved_runtime, 'VIDEO_IMPORT_ALLOWED_HOST_SUFFIXES', ()) or ())
    if allowed_suffixes and (not _host_matches_allowed_suffix(host, allowed_suffixes)):
        return ('', 'Only supported LMS/Kaltura video hosts are allowed for automatic import.')
    return (fetch_target, '')


def validate_video_import_url(raw_url, runtime=None):
    fetch_target, error = validate_video_import_fetch_target(raw_url, runtime=runtime)
    if error:
        return ('', error)
    return (resolved_url(fetch_target), '')


def resolved_url(fetch_target):
    return str(getattr(fetch_target, 'url', fetch_target) or '')


def cleanup_expired_audio_import_tokens(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    now_ts = resolved_runtime.time.time()
    expired = []
    with resolved_runtime.AUDIO_IMPORT_LOCK:
        for token, data in list(resolved_runtime.AUDIO_IMPORT_TOKENS.items()):
            if now_ts > float(data.get('expires_at', 0) or 0):
                expired.append(data.get('path', ''))
                resolved_runtime.AUDIO_IMPORT_TOKENS.pop(token, None)
    for path in expired:
        try:
            if path and os.path.exists(path):
                os.remove(path)
        except Exception:
            pass


def register_audio_import_token(uid, file_path, source_url='', original_name='', runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    token = str(uuid.uuid4())
    with resolved_runtime.AUDIO_IMPORT_LOCK:
        resolved_runtime.AUDIO_IMPORT_TOKENS[token] = {
            'uid': str(uid or ''),
            'path': str(file_path or ''),
            'source_url': str(source_url or '')[:resolved_runtime.VIDEO_IMPORT_MAX_URL_LENGTH],
            'original_name': str(original_name or '')[:240],
            'created_at': resolved_runtime.time.time(),
            'expires_at': resolved_runtime.time.time() + resolved_runtime.AUDIO_IMPORT_TOKEN_TTL_SECONDS,
        }
    return token


def get_audio_import_token_path(uid, token, consume=False, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    cleanup_expired_audio_import_tokens(runtime=resolved_runtime)
    safe_uid = str(uid or '')
    safe_token = str(token or '').strip()
    if not safe_token:
        return ('', 'Missing imported audio token.')
    with resolved_runtime.AUDIO_IMPORT_LOCK:
        entry = resolved_runtime.AUDIO_IMPORT_TOKENS.get(safe_token)
        if not entry:
            return ('', 'Imported audio token expired or invalid. Please import again.')
        if entry.get('uid', '') != safe_uid:
            return ('', 'Imported audio token does not belong to this account.')
        file_path = str(entry.get('path', '') or '').strip()
        if consume:
            resolved_runtime.AUDIO_IMPORT_TOKENS.pop(safe_token, None)
    if not file_path or not os.path.exists(file_path):
        return ('', 'Imported audio file is no longer available. Please import again.')
    return (file_path, '')


def release_audio_import_token(uid, token, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    safe_uid = str(uid or '')
    safe_token = str(token or '').strip()
    if not safe_token:
        return False
    file_path = ''
    with resolved_runtime.AUDIO_IMPORT_LOCK:
        entry = resolved_runtime.AUDIO_IMPORT_TOKENS.get(safe_token)
        if not entry or entry.get('uid', '') != safe_uid:
            return False
        file_path = str(entry.get('path', '') or '').strip()
        resolved_runtime.AUDIO_IMPORT_TOKENS.pop(safe_token, None)
    try:
        if file_path and os.path.exists(file_path):
            os.remove(file_path)
    except Exception:
        pass
    return True


def release_audio_import_tokens_for_uid(uid, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    safe_uid = str(uid or '')
    removed_paths = []
    removed_tokens = 0
    if not safe_uid:
        return {'tokens': 0, 'files': 0}
    with resolved_runtime.AUDIO_IMPORT_LOCK:
        for token, entry in list(resolved_runtime.AUDIO_IMPORT_TOKENS.items()):
            if entry.get('uid', '') != safe_uid:
                continue
            removed_tokens += 1
            removed_paths.append(str(entry.get('path', '') or '').strip())
            resolved_runtime.AUDIO_IMPORT_TOKENS.pop(token, None)
    removed_files = 0
    for path in removed_paths:
        try:
            if path and os.path.exists(path):
                os.remove(path)
                removed_files += 1
        except Exception:
            pass
    return {'tokens': removed_tokens, 'files': removed_files}
