"""Helpers for validating externally fetched URLs and redirect targets."""

from __future__ import annotations

import ipaddress
import socket
import urllib.error
import urllib.request
from urllib.parse import urlparse, urlunparse


_BLOCKED_LITERAL_HOSTS = {
    'localhost',
    'localhost.localdomain',
    '127.0.0.1',
    '::1',
}
_BLOCKED_HOST_SUFFIXES = ('.local', '.internal')
_DEFAULT_PORT_BY_SCHEME = {
    'http': 80,
    'https': 443,
}


def _is_restricted_ip(raw_ip):
    try:
        ip = ipaddress.ip_address(str(raw_ip or '').strip())
    except ValueError:
        return True
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return True
    return False


def _host_is_blocked(host):
    safe_host = str(host or '').strip().lower()
    if not safe_host:
        return True
    if safe_host in _BLOCKED_LITERAL_HOSTS:
        return True
    if safe_host.endswith(_BLOCKED_HOST_SUFFIXES):
        return True
    try:
        ipaddress.ip_address(safe_host)
    except ValueError:
        # Domain names are validated through DNS resolution in
        # ``validate_external_url_for_fetch``.
        return False
    except Exception:
        return True
    return _is_restricted_ip(safe_host)


def validate_external_url_for_fetch(
    raw_url,
    *,
    allowed_schemes=('https',),
    allow_credentials=False,
    allow_non_standard_ports=False,
    resolve_dns=True,
    resolver=socket.getaddrinfo,
):
    """Return ``(normalized_url, error_message)`` for an external URL."""

    candidate = str(raw_url or '').strip()
    if not candidate:
        return '', 'Please provide a URL.'

    try:
        parsed = urlparse(candidate)
    except Exception:
        return '', 'URL is invalid.'

    scheme = str(parsed.scheme or '').strip().lower()
    if scheme not in set(allowed_schemes or ()):
        allowed = '/'.join(sorted(set(allowed_schemes or ())))
        return '', f'Only {allowed} URLs are supported.'
    if parsed.username or parsed.password:
        if not allow_credentials:
            return '', 'URL credentials are not allowed.'
    host = str(parsed.hostname or '').strip().lower()
    if not host:
        return '', 'URL is missing a valid host.'
    if _host_is_blocked(host):
        return '', 'This URL host is not allowed.'

    try:
        parsed_port = parsed.port
    except ValueError:
        return '', 'URL port is invalid.'
    default_port = _DEFAULT_PORT_BY_SCHEME.get(scheme)
    effective_port = parsed_port or default_port
    if (
        parsed_port is not None
        and default_port is not None
        and parsed_port != default_port
        and not allow_non_standard_ports
    ):
        return '', 'Non-standard URL ports are not allowed.'

    if resolve_dns:
        try:
            resolved = resolver(host, int(effective_port or 0), proto=socket.IPPROTO_TCP)
        except socket.gaierror:
            return '', 'Could not resolve the URL host.'
        except Exception:
            resolved = []
        if not resolved:
            return '', 'Could not resolve the URL host.'
        for _family, _kind, _proto, _canonname, sockaddr in resolved:
            ip_str = sockaddr[0]
            if _is_restricted_ip(ip_str):
                return '', 'This URL host resolves to a restricted network address.'

    normalized = urlunparse(parsed._replace(fragment=''))
    return normalized, None


class ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Redirect handler that validates each hop before following it."""

    def __init__(self, validate_url):
        super().__init__()
        self._validate_url = validate_url

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        safe_url, error = self._validate_url(newurl)
        if error:
            raise urllib.error.URLError(error)
        return super().redirect_request(req, fp, code, msg, headers, safe_url)
