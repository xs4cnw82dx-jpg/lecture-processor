"""Shared response security headers."""

from __future__ import annotations


def _security_policy_sources():
    return {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'none'"],
        'form-action': ["'self'"],
        'script-src': [
            "'self'",
            "'unsafe-inline'",
            'https://www.gstatic.com',
            'https://cdn.jsdelivr.net',
            'https://browser.sentry-cdn.com',
        ],
        'style-src': [
            "'self'",
            "'unsafe-inline'",
            'https://fonts.googleapis.com',
            'https://cdn.jsdelivr.net',
        ],
        'font-src': [
            "'self'",
            'https://fonts.gstatic.com',
            'data:',
        ],
        'img-src': [
            "'self'",
            'data:',
            'blob:',
            'https://www.gstatic.com',
        ],
        'connect-src': [
            "'self'",
            'https://www.gstatic.com',
            'https://browser.sentry-cdn.com',
        ],
        'media-src': [
            "'self'",
            'blob:',
            'data:',
        ],
        'object-src': ["'none'"],
    }


def build_content_security_policy():
    parts = []
    for directive, values in _security_policy_sources().items():
        unique_values = []
        for value in values:
            if value not in unique_values:
                unique_values.append(value)
        parts.append(f"{directive} {' '.join(unique_values)}")
    return '; '.join(parts)


def apply_security_headers(response, *, request_is_secure=False):
    response.headers.setdefault('Content-Security-Policy', build_content_security_policy())
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if request_is_secure:
        response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    return response
