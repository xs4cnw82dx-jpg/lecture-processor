"""Authentication utility helpers."""


EMAIL_NOT_VERIFIED_AUTH_ERROR = 'email_not_verified'


def _set_request_auth_error(request, error_code):
    environ = getattr(request, 'environ', None)
    if isinstance(environ, dict):
        value = str(error_code or '').strip()
        if value:
            environ['lecture_processor.auth_error'] = value
        else:
            environ.pop('lecture_processor.auth_error', None)


def get_request_auth_error(request):
    environ = getattr(request, 'environ', None)
    if not isinstance(environ, dict):
        return ''
    return str(environ.get('lecture_processor.auth_error', '') or '').strip()


def token_has_unverified_email(decoded_token):
    if not isinstance(decoded_token, dict):
        return False
    if not str(decoded_token.get('email', '') or '').strip():
        return False
    # Firebase email/password ID tokens include ``email_verified``. Tokens from
    # custom/non-email providers may omit it, so only an explicit false blocks.
    return decoded_token.get('email_verified') is False


def verify_firebase_token(request, auth_module, logger, *, check_revoked=False):
    """Return decoded Firebase token dict, or None when invalid/missing."""
    _set_request_auth_error(request, '')
    auth_header = request.headers.get('Authorization', '')
    if not auth_header.startswith('Bearer '):
        return None
    token = auth_header.split('Bearer ', 1)[1]
    try:
        try:
            decoded_token = auth_module.verify_id_token(token, check_revoked=bool(check_revoked))
        except TypeError as exc:
            if 'check_revoked' not in str(exc):
                raise
            decoded_token = auth_module.verify_id_token(token)
        if token_has_unverified_email(decoded_token):
            _set_request_auth_error(request, EMAIL_NOT_VERIFIED_AUTH_ERROR)
            if logger is not None:
                logger.info('Token verification rejected unverified email token for uid=%s', decoded_token.get('uid', ''))
            return None
        return decoded_token
    except Exception as exc:
        if logger is not None:
            logger.info(f"Token verification failed: {exc}")
        return None
