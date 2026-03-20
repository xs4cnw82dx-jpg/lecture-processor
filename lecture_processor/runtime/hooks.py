from __future__ import annotations

import base64
import secrets
import uuid

from flask import g, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge

from lecture_processor.domains.ai import batch_orchestrator


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
    def _run_startup_recovery_on_first_request():
        runtime.run_startup_recovery_once()
        batch_orchestrator.run_startup_batch_recovery_once(runtime=runtime)

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
            'route.path': request.path,
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

    @app.context_processor
    def _inject_template_security_context():
        return {'csp_nonce': getattr(g, 'csp_nonce', '')}

    state['hooks_registered'] = True
