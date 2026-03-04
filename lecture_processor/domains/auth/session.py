from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _extract_bearer_token(req, runtime=None):
    auth_header = req.headers.get('Authorization', '')
    if isinstance(auth_header, str) and auth_header.startswith('Bearer '):
        token = auth_header.split('Bearer ', 1)[1].strip()
        if token:
            return token
    payload = req.get_json(silent=True) or {}
    body_token = str(payload.get('id_token', '') or payload.get('idToken', '') or '').strip()
    if body_token:
        return body_token
    return ''


def verify_admin_session_cookie(req, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    session_cookie = req.cookies.get(resolved_runtime.ADMIN_SESSION_COOKIE_NAME, '')
    if not session_cookie:
        return None
    try:
        decoded_token = resolved_runtime.auth.verify_session_cookie(session_cookie, check_revoked=True)
    except Exception:
        return None
    if not resolved_runtime.is_admin_user(decoded_token):
        return None
    return decoded_token
