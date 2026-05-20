"""Helpers for validating externally fetched URLs and redirect targets."""

from __future__ import annotations

from dataclasses import dataclass
import http.client
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


@dataclass(frozen=True)
class ValidatedFetchTarget:
    """A normalized URL plus the public IPs vetted for its host and port."""

    url: str
    scheme: str
    host: str
    port: int
    resolved_ips: tuple[str, ...]


def _is_restricted_ip(raw_ip):
    try:
        ip = ipaddress.ip_address(str(raw_ip or '').strip())
    except ValueError:
        return True
    if ip.is_loopback or ip.is_private or ip.is_link_local:
        return True
    if ip.is_multicast or ip.is_reserved or ip.is_unspecified:
        return True
    if not ip.is_global:
        return True
    return False


def _host_cache_key(host):
    return str(host or '').strip().rstrip('.').lower()


def fetch_target_url(value):
    if isinstance(value, ValidatedFetchTarget):
        return value.url
    return str(value or '')


class PinnedFetchTargetRegistry:
    """Registry of validation-time IPs used by the fetch-time connection."""

    def __init__(self):
        self._targets = {}

    def add(self, target):
        if not isinstance(target, ValidatedFetchTarget):
            return
        if not target.resolved_ips:
            return
        key = (_host_cache_key(target.host), int(target.port or 0))
        existing = list(self._targets.get(key, ()))
        for ip_str in target.resolved_ips:
            if ip_str not in existing:
                existing.append(ip_str)
        self._targets[key] = tuple(existing)

    def resolve(self, host, port):
        try:
            safe_port = int(port or 0)
        except Exception:
            safe_port = 0
        return tuple(self._targets.get((_host_cache_key(host), safe_port), ()))


class _IPBoundConnectionMixin:
    _pinned_fetch_targets = None

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self._create_connection = self._create_ip_bound_connection

    def _create_ip_bound_connection(self, address, timeout=socket._GLOBAL_DEFAULT_TIMEOUT, source_address=None):
        host, port = address
        registry = self._pinned_fetch_targets
        pinned_ips = registry.resolve(host, port) if registry is not None else ()
        if not pinned_ips:
            raise OSError(f'No validated network address is pinned for {host}:{port}')

        last_error = None
        for ip_str in pinned_ips:
            if _is_restricted_ip(ip_str):
                continue
            try:
                return socket.create_connection((ip_str, int(port)), timeout, source_address)
            except OSError as exc:
                last_error = exc
        if last_error is not None:
            raise last_error
        raise OSError(f'No usable validated network address is pinned for {host}:{port}')


def _make_ip_bound_connection_class(base_connection_class, registry):
    class _IPBoundConnection(_IPBoundConnectionMixin, base_connection_class):
        _pinned_fetch_targets = registry

    return _IPBoundConnection


class IPBoundHTTPHandler(urllib.request.HTTPHandler):
    """HTTP handler that connects only to validation-pinned IP addresses."""

    def __init__(self, registry, debuglevel=0):
        super().__init__(debuglevel=debuglevel)
        self.registry = registry

    def http_open(self, req):
        connection_class = _make_ip_bound_connection_class(http.client.HTTPConnection, self.registry)
        return self.do_open(connection_class, req)


class IPBoundHTTPSHandler(urllib.request.HTTPSHandler):
    """HTTPS handler that preserves the URL host/SNI while pinning the socket IP."""

    def __init__(self, registry, debuglevel=0, context=None, check_hostname=None):
        super().__init__(debuglevel=debuglevel, context=context, check_hostname=check_hostname)
        self.registry = registry

    def https_open(self, req):
        connection_class = _make_ip_bound_connection_class(http.client.HTTPSConnection, self.registry)
        return self.do_open(
            connection_class,
            req,
            context=self._context,
            check_hostname=self._check_hostname,
        )


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
    return_fetch_target=False,
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

    resolved_ips = []
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
            if ip_str not in resolved_ips:
                resolved_ips.append(ip_str)

    normalized = urlunparse(parsed._replace(scheme=scheme, fragment=''))
    if return_fetch_target:
        if resolve_dns and not resolved_ips:
            return '', 'Could not resolve the URL host.'
        return ValidatedFetchTarget(
            url=normalized,
            scheme=scheme,
            host=host,
            port=int(effective_port or 0),
            resolved_ips=tuple(resolved_ips),
        ), None
    return normalized, None


class ValidatingRedirectHandler(urllib.request.HTTPRedirectHandler):
    """Redirect handler that validates each hop before following it."""

    def __init__(self, validate_url, on_validated_url=None):
        super().__init__()
        self._validate_url = validate_url
        self._on_validated_url = on_validated_url

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validated_url, error = self._validate_url(newurl)
        if error:
            raise urllib.error.URLError(error)
        if callable(self._on_validated_url):
            self._on_validated_url(validated_url)
        safe_url = fetch_target_url(validated_url)
        return super().redirect_request(req, fp, code, msg, headers, safe_url)
