"""Network guard for yt-dlp subprocesses.

The module is executed as ``python -m lecture_processor.services.ytdlp_network_guard``.
It pins the initially validated host to validation-time public IPs and rejects any
additional yt-dlp DNS resolution that points at restricted networks.
"""

from __future__ import annotations

import json
import os
import socket
import sys

from lecture_processor.services import url_security


def _load_config():
    try:
        payload = json.loads(os.environ.get("LECTURE_PROCESSOR_YTDLP_GUARD", "{}") or "{}")
    except Exception:
        payload = {}
    host = str(payload.get("host", "") or "").strip().rstrip(".").lower()
    try:
        port = int(payload.get("port", 0) or 0)
    except Exception:
        port = 0
    resolved_ips = []
    for raw_ip in payload.get("resolved_ips", []) or []:
        ip = str(raw_ip or "").strip()
        if ip and not url_security._is_restricted_ip(ip):
            resolved_ips.append(ip)
    return host, port, tuple(dict.fromkeys(resolved_ips))


def _guard_getaddrinfo(original_getaddrinfo, pinned_host, pinned_port, pinned_ips):
    def _getaddrinfo(host, port, family=0, type=0, proto=0, flags=0):
        safe_host = str(host or "").strip().rstrip(".").lower()
        try:
            safe_port = int(port or 0)
        except Exception:
            safe_port = 0
        if url_security._host_is_blocked(safe_host):
            raise socket.gaierror(f"Blocked restricted host: {safe_host}")
        if safe_host == pinned_host and safe_port == pinned_port and pinned_ips:
            results = []
            for ip_str in pinned_ips:
                try:
                    socket.inet_pton(socket.AF_INET, ip_str)
                    results.append((socket.AF_INET, type or socket.SOCK_STREAM, proto or socket.IPPROTO_TCP, "", (ip_str, safe_port)))
                    continue
                except OSError:
                    pass
                try:
                    socket.inet_pton(socket.AF_INET6, ip_str)
                    results.append((socket.AF_INET6, type or socket.SOCK_STREAM, proto or socket.IPPROTO_TCP, "", (ip_str, safe_port, 0, 0)))
                except OSError:
                    continue
            if results:
                return results
            raise socket.gaierror(f"No pinned public IPs for {safe_host}:{safe_port}")

        resolved = original_getaddrinfo(host, port, family, type, proto, flags)
        for _family, _kind, _proto, _canonname, sockaddr in resolved:
            if url_security._is_restricted_ip(sockaddr[0]):
                raise socket.gaierror(f"Blocked restricted network target for {safe_host}")
        return resolved

    return _getaddrinfo


def main(argv=None):
    pinned_host, pinned_port, pinned_ips = _load_config()
    original_getaddrinfo = socket.getaddrinfo
    socket.getaddrinfo = _guard_getaddrinfo(original_getaddrinfo, pinned_host, pinned_port, pinned_ips)
    try:
        from yt_dlp.__main__ import main as ytdlp_main
    except Exception as error:
        sys.stderr.write(f"yt-dlp is not installed on the server: {error}\n")
        return 1
    return int(ytdlp_main(list(argv if argv is not None else sys.argv[1:])) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
