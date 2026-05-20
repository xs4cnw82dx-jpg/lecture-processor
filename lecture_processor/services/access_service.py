"""Shared authentication and allowlist guards for service handlers."""

from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.services import auth_service


def _email_not_verified_response(app_ctx):
    return app_ctx.jsonify({
        'error': 'Email not verified',
        'error_code': auth_service.EMAIL_NOT_VERIFIED_AUTH_ERROR,
        'message': 'Please verify your email address before continuing.',
    }), 403


def require_authenticated_user(app_ctx, request, *, unauthorized_error='Unauthorized'):
    """Return a decoded Firebase token or an error response tuple."""
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        if auth_service.get_request_auth_error(request) == auth_service.EMAIL_NOT_VERIFIED_AUTH_ERROR:
            response, status = _email_not_verified_response(app_ctx)
            return None, response, status
        return None, app_ctx.jsonify({'error': str(unauthorized_error or 'Unauthorized')}), 401
    if auth_service.token_has_unverified_email(decoded_token):
        response, status = _email_not_verified_response(app_ctx)
        return None, response, status
    return decoded_token, None, None


def is_email_allowed(app_ctx, email):
    checker = getattr(app_ctx, 'is_email_allowed', None)
    if callable(checker):
        try:
            return bool(checker(email))
        except TypeError:
            return bool(checker(email, runtime=app_ctx))
    return auth_policy.is_email_allowed(email, runtime=app_ctx)


def require_allowed_user(
    app_ctx,
    request,
    *,
    unauthorized_error='Unauthorized',
    email_not_allowed_error='Email not allowed',
    email_not_allowed_message='Please use your university email.',
):
    """Return a decoded token only when the user is authenticated and allowlisted."""
    decoded_token, error_response, status = require_authenticated_user(
        app_ctx,
        request,
        unauthorized_error=unauthorized_error,
    )
    if error_response is not None:
        return None, error_response, status
    email = str(decoded_token.get('email', '') or '').strip()
    if is_email_allowed(app_ctx, email):
        return decoded_token, None, None
    payload = {'error': str(email_not_allowed_error or 'Email not allowed')}
    message = str(email_not_allowed_message or '').strip()
    if message:
        payload['message'] = message
    return None, app_ctx.jsonify(payload), 403
