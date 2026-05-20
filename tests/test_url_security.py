import http.client
import socket
import urllib.request

from lecture_processor.services import upload_api_service, url_security


def _public_resolver(_host, port, **_kwargs):
    return [
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('93.184.216.34', int(port))),
    ]


def _private_resolver(_host, port, **_kwargs):
    return [
        (socket.AF_INET, socket.SOCK_STREAM, socket.IPPROTO_TCP, '', ('10.0.0.8', int(port))),
    ]


def test_validate_external_url_for_fetch_rejects_localhost():
    _safe, error = url_security.validate_external_url_for_fetch(
        'https://localhost/private',
        resolver=_public_resolver,
    )
    assert error is not None
    assert 'not allowed' in error.lower()


def test_validate_external_url_for_fetch_rejects_link_local_literal_ip():
    _safe, error = url_security.validate_external_url_for_fetch(
        'https://169.254.169.254/latest/meta-data',
        resolver=_public_resolver,
    )
    assert error is not None
    assert 'not allowed' in error.lower()


def test_validate_external_url_for_fetch_rejects_private_dns_resolution():
    _safe, error = url_security.validate_external_url_for_fetch(
        'https://example.com/path',
        resolver=_private_resolver,
    )
    assert error is not None
    assert 'restricted network address' in error.lower()


def test_validate_external_url_for_fetch_rejects_non_standard_port():
    _safe, error = url_security.validate_external_url_for_fetch(
        'https://example.com:8443/path',
        resolver=_public_resolver,
    )
    assert error is not None
    assert 'non-standard' in error.lower()


def test_validate_external_url_for_fetch_accepts_public_https():
    safe, error = url_security.validate_external_url_for_fetch(
        'https://example.com/path?ok=1#frag',
        resolver=_public_resolver,
    )
    assert error is None
    assert safe == 'https://example.com/path?ok=1'


def test_validate_external_url_for_fetch_can_return_ip_bound_target():
    target, error = url_security.validate_external_url_for_fetch(
        'https://example.com/path?ok=1#frag',
        resolver=_public_resolver,
        return_fetch_target=True,
    )

    assert error is None
    assert target.url == 'https://example.com/path?ok=1'
    assert target.host == 'example.com'
    assert target.port == 443
    assert target.resolved_ips == ('93.184.216.34',)


def test_ip_bound_connection_uses_pinned_ip_without_resolving_host(monkeypatch):
    target = url_security.ValidatedFetchTarget(
        url='https://example.com/path',
        scheme='https',
        host='example.com',
        port=443,
        resolved_ips=('93.184.216.34',),
    )
    registry = url_security.PinnedFetchTargetRegistry()
    registry.add(target)
    connection_class = url_security._make_ip_bound_connection_class(http.client.HTTPConnection, registry)
    connection = connection_class('example.com', timeout=5)
    calls = []
    fake_socket = object()

    def _fake_create_connection(address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
        calls.append((address, timeout, source_address))
        return fake_socket

    monkeypatch.setattr(socket, 'create_connection', _fake_create_connection)

    assert connection._create_connection(('example.com', 443), 5) is fake_socket
    assert calls == [(('93.184.216.34', 443), 5, None)]


def test_redirect_handler_pins_validated_redirect_target(monkeypatch):
    target = url_security.ValidatedFetchTarget(
        url='https://redirect.example.com/next',
        scheme='https',
        host='redirect.example.com',
        port=443,
        resolved_ips=('93.184.216.34',),
    )
    registry = url_security.PinnedFetchTargetRegistry()

    def _fake_super_redirect(_self, _req, _fp, _code, _msg, _headers, newurl):
        return newurl

    monkeypatch.setattr(
        urllib.request.HTTPRedirectHandler,
        'redirect_request',
        _fake_super_redirect,
    )

    handler = url_security.ValidatingRedirectHandler(lambda _url: (target, None), on_validated_url=registry.add)

    redirected_url = handler.redirect_request(object(), None, 302, 'Found', {}, target.url)

    assert redirected_url == target.url
    assert registry.resolve('redirect.example.com', 443) == ('93.184.216.34',)


def test_tools_source_url_rejects_localhost_private_urls():
    safe, error = upload_api_service._sanitize_tools_source_url('https://localhost/private')
    assert safe == ''
    assert error is not None
    assert 'not allowed' in error.lower()
