"""Shared admin auth and numeric parsing helpers."""

from __future__ import annotations


def require_admin(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return None, app_ctx.jsonify({'error': 'Unauthorized'}), 401
    if not app_ctx.is_admin_user(decoded_token):
        return None, app_ctx.jsonify({'error': 'Forbidden'}), 403
    return decoded_token, None, None


def to_non_negative_float(value, default=0.0):
    try:
        parsed = float(value)
    except Exception:
        parsed = float(default)
    if parsed < 0:
        return 0.0
    return parsed


def to_non_negative_int(value, default=0):
    try:
        parsed = int(value)
    except Exception:
        parsed = int(default)
    if parsed < 0:
        return 0
    return parsed
