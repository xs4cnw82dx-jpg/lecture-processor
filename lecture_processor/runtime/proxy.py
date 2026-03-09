"""Trusted proxy and client identity helpers."""

from __future__ import annotations

from werkzeug.middleware.proxy_fix import ProxyFix


def apply_proxy_fix(app, trusted_proxy_hops=1):
    safe_hops = max(0, int(trusted_proxy_hops or 0))
    if safe_hops <= 0:
        return app
    state = app.extensions.setdefault('lecture_processor', {})
    if state.get('proxy_fix_applied'):
        return app
    app.wsgi_app = ProxyFix(app.wsgi_app, x_for=safe_hops, x_proto=safe_hops, x_host=safe_hops, x_port=safe_hops)
    state['proxy_fix_applied'] = True
    return app


def client_ip_from_request(request_obj):
    remote_addr = str(getattr(request_obj, 'remote_addr', '') or '').strip()
    if remote_addr:
        return remote_addr
    route = getattr(request_obj, 'access_route', None) or []
    if route:
        candidate = str(route[0] or '').strip()
        if candidate:
            return candidate
    return 'unknown'
