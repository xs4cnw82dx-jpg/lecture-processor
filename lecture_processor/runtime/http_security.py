"""Shared response security headers."""

from __future__ import annotations

from urllib.parse import urlparse


def _sentry_connect_source(sentry_frontend_dsn: str = '') -> str:
    parsed = urlparse(str(sentry_frontend_dsn or '').strip())
    scheme = str(parsed.scheme or '').strip().lower()
    hostname = str(parsed.hostname or '').strip()
    if scheme not in {'http', 'https'} or not hostname:
        return ''
    port = parsed.port
    if port:
        return f'{scheme}://{hostname}:{port}'
    return f'{scheme}://{hostname}'


def _security_policy_sources(*, sentry_frontend_dsn: str = ''):
    sources = {
        'default-src': ["'self'"],
        'base-uri': ["'self'"],
        'frame-ancestors': ["'none'"],
        'frame-src': [
            'https://lecture-processor-cdff6.firebaseapp.com',
            'https://accounts.google.com',
        ],
        'form-action': ["'self'"],
        'script-src': [
            "'self'",
            "'unsafe-inline'",
            'https://www.gstatic.com',
            'https://apis.google.com',
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
            'https://identitytoolkit.googleapis.com',
            'https://securetoken.googleapis.com',
            'https://browser.sentry-cdn.com',
        ],
        'media-src': [
            "'self'",
            'blob:',
            'data:',
        ],
        'object-src': ["'none'"],
    }
    sentry_connect_source = _sentry_connect_source(sentry_frontend_dsn)
    if sentry_connect_source:
        sources['connect-src'].append(sentry_connect_source)
    return sources


def build_content_security_policy(*, sentry_frontend_dsn: str = ''):
    parts = []
    for directive, values in _security_policy_sources(sentry_frontend_dsn=sentry_frontend_dsn).items():
        unique_values = []
        for value in values:
            if value not in unique_values:
                unique_values.append(value)
        parts.append(f"{directive} {' '.join(unique_values)}")
    return '; '.join(parts)


def apply_security_headers(response, *, request_is_secure=False, sentry_frontend_dsn: str = ''):
    response.headers.setdefault(
        'Content-Security-Policy',
        build_content_security_policy(sentry_frontend_dsn=sentry_frontend_dsn),
    )
    response.headers.setdefault('Referrer-Policy', 'strict-origin-when-cross-origin')
    response.headers.setdefault('X-Content-Type-Options', 'nosniff')
    response.headers.setdefault('X-Frame-Options', 'DENY')
    response.headers.setdefault('Permissions-Policy', 'camera=(), microphone=(), geolocation=()')
    if request_is_secure:
        response.headers.setdefault('Strict-Transport-Security', 'max-age=31536000; includeSubDomains')
    return response
