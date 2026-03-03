import socket

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


def test_tools_source_url_rejects_localhost_private_urls():
    safe, error = upload_api_service._sanitize_tools_source_url('https://localhost/private')
    assert safe == ''
    assert error is not None
    assert 'not allowed' in error.lower()
