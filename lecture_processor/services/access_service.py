"""Shared authentication and allowlist guards for service handlers."""

from lecture_processor.domains.auth import policy as auth_policy


def require_authenticated_user(app_ctx, request, *, unauthorized_error='Unauthorized'):
    """Return a decoded Firebase token or an error response tuple."""
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return None, app_ctx.jsonify({'error': str(unauthorized_error or 'Unauthorized')}), 401
    return decoded_token, None, None


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
    if auth_policy.is_email_allowed(email, runtime=app_ctx):
        return decoded_token, None, None
    payload = {'error': str(email_not_allowed_error or 'Email not allowed')}
    message = str(email_not_allowed_message or '').strip()
    if message:
        payload['message'] = message
    return None, app_ctx.jsonify(payload), 403
