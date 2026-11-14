from __future__ import annotations

import base64
import os
import secrets
import uuid

from flask import g, jsonify, redirect, request, render_template
from werkzeug.exceptions import HTTPException, NotFound, RequestEntityTooLarge

from lecture_processor.calendar_observability import redact_calendar_url
from lecture_processor.runtime.environment import extract_hostname, normalize_public_base_url


def _set_sentry_tags(runtime, tags):
    sentry_sdk = getattr(runtime, 'sentry_sdk', None)
    if not sentry_sdk:
        return
    try:
        get_current_scope = getattr(sentry_sdk, 'get_current_scope', None)
        if callable(get_current_scope):
            scope = get_current_scope()
            if scope is not None:
                for key, value in (tags or {}).items():
                    scope.set_tag(key, value)
                return
        set_tag = getattr(sentry_sdk, 'set_tag', None)
        if callable(set_tag):
            for key, value in (tags or {}).items():
                set_tag(key, value)
    except Exception:
        return


def register_runtime_hooks(app, runtime) -> None:
    state = app.extensions.setdefault('lecture_processor', {})
    if state.get('hooks_registered'):
        return

    @app.before_request
    def _redirect_render_pages_to_public_origin():
        if request.method not in {'GET', 'HEAD'}:
            return None
        if request.blueprint != 'pages':
            if not isinstance(request.routing_exception, NotFound):
                return None
            # Unmatched pages have no blueprint. Keep API/webhook, health,
            # and asset errors on the origin that received the request.
            if any(request.path == prefix or request.path.startswith(prefix + '/')
                   for prefix in ('/api', '/healthz', '/static')):
                return None
        if request.endpoint in {'pages.service_worker', 'pages.workout_service_worker'}:
            return None
        render_host = extract_hostname(os.environ.get('RENDER_EXTERNAL_HOSTNAME', ''))
        public_origin = normalize_public_base_url(getattr(runtime, 'PUBLIC_BASE_URL', ''))
        public_host = extract_hostname(public_origin)
        if (render_host and public_host and public_host != render_host
                and extract_hostname(request.host) == render_host):
            target_path = request.full_path if request.query_string else request.path
            # Browsers cache 301 redirects even after configuration is fixed;
            # verify PUBLIC_BASE_URL before changing its deployed value.
            return redirect(public_origin + target_path, code=301)
        return None

    @app.before_request
    def _attach_csp_nonce():
        g.csp_nonce = base64.b64encode(secrets.token_bytes(16)).decode('ascii').rstrip('=')

    @app.before_request
    def _handle_api_options_preflight():
        if request.method == 'OPTIONS' and request.path.startswith('/api/'):
            return runtime.apply_cors_headers(app.make_default_options_response())

    @app.before_request
    def _attach_sentry_route_context():
        request_id = str(request.headers.get('X-Request-ID', '') or '').strip()[:120] or uuid.uuid4().hex
        g.request_id = request_id
        tags = {
            'request.id': request_id,
            'route.path': redact_calendar_url(request.path),
            'route.method': request.method,
            'route.endpoint': request.endpoint or '',
            'route.auth_header_present': 'true' if request.headers.get('Authorization') else 'false',
            'route.environment': runtime.SENTRY_ENVIRONMENT or 'production',
        }
        if request.content_type:
            tags['route.content_type'] = str(request.content_type).split(';')[0][:80]
        _set_sentry_tags(runtime, tags)

    @app.after_request
    def _attach_sentry_response_context(response):
        request_id = str(getattr(g, 'request_id', '') or '').strip()
        if request_id:
            response.headers['X-Request-ID'] = request_id
        _set_sentry_tags(runtime, {'route.status_code': str(response.status_code)})
        runtime.apply_security_headers(response)
        return runtime.apply_cors_headers(response)

    @app.errorhandler(RequestEntityTooLarge)
    def _handle_request_entity_too_large(_error):
        return jsonify({'error': 'Upload too large. Maximum total upload size is 560MB (up to 50MB PDF and 500MB audio).'}), 413

    @app.errorhandler(HTTPException)
    def _render_browser_error(error):
        # Preserve status/headers and existing API error semantics.
        response = error.get_response()
        if request.path.startswith('/api/') or request.method not in ('GET', 'HEAD'):
            return response
        messages = {
            403: ('This page is not available', 'Your account does not have access to this page.'),
            404: ('We could not find this page', 'The address may have changed, or this shared link may no longer be available.'),
            410: ('This link is no longer available', 'The owner may have removed it or turned sharing off.'),
            500: ('Something went wrong', 'We could not load this page. Please try again in a moment.'),
        }
        title, message = messages.get(error.code, ('We could not open this page', 'Please return to your workspace and try again.'))
        response.set_data(render_template('error.html', error_code=error.code, error_title=title, error_message=message))
        response.content_type = 'text/html; charset=utf-8'
        return response

    @app.context_processor
    def _inject_template_security_context():
        return {'csp_nonce': getattr(g, 'csp_nonce', '')}

    state['hooks_registered'] = True
