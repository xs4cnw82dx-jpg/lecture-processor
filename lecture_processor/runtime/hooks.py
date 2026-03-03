from __future__ import annotations

import uuid

from flask import g, jsonify, request
from werkzeug.exceptions import RequestEntityTooLarge


def register_runtime_hooks(app, runtime) -> None:
    state = app.extensions.setdefault('lecture_processor', {})
    if state.get('hooks_registered'):
        return

    @app.before_request
    def _run_startup_recovery_on_first_request():
        runtime.run_startup_recovery_once()

    @app.before_request
    def _handle_api_options_preflight():
        if request.method == 'OPTIONS' and request.path.startswith('/api/'):
            return runtime.apply_cors_headers(app.make_default_options_response())

    @app.before_request
    def _attach_sentry_route_context():
        request_id = str(request.headers.get('X-Request-ID', '') or '').strip()[:120] or uuid.uuid4().hex
        g.request_id = request_id
        if not runtime.sentry_sdk:
            return
        try:
            with runtime.sentry_sdk.configure_scope() as scope:
                scope.set_tag('request.id', request_id)
                scope.set_tag('route.path', request.path)
                scope.set_tag('route.method', request.method)
                scope.set_tag('route.endpoint', request.endpoint or '')
                scope.set_tag('route.auth_header_present', 'true' if request.headers.get('Authorization') else 'false')
                scope.set_tag('route.environment', runtime.SENTRY_ENVIRONMENT or 'production')
                if request.content_type:
                    scope.set_tag('route.content_type', str(request.content_type).split(';')[0][:80])
        except Exception:
            return

    @app.after_request
    def _attach_sentry_response_context(response):
        request_id = str(getattr(g, 'request_id', '') or '').strip()
        if request_id:
            response.headers['X-Request-ID'] = request_id
        if runtime.sentry_sdk:
            try:
                with runtime.sentry_sdk.configure_scope() as scope:
                    scope.set_tag('route.status_code', str(response.status_code))
            except Exception:
                pass
        return runtime.apply_cors_headers(response)

    @app.errorhandler(RequestEntityTooLarge)
    def _handle_request_entity_too_large(_error):
        return jsonify({'error': 'Upload too large. Maximum total upload size is 560MB (up to 50MB PDF and 500MB audio).'}), 413

    state['hooks_registered'] = True
