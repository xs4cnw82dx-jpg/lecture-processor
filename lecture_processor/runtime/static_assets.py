"""Content-versioned static URLs, so browsers can keep unchanged files for a year.

Every ``url_for('static', ...)`` URL gets ``?v=<content hash>``. A request whose ``v``
matches the file's current content is served as immutable; any other static request
keeps the default revalidation, so unversioned or outdated URLs never go stale.
"""
from __future__ import annotations

import hashlib
import os
import threading

from flask import request
from werkzeug.security import safe_join

IMMUTABLE_CACHE_CONTROL = 'public, max-age=31536000, immutable'
_HASH_LENGTH = 12
_CHUNK_BYTES = 1024 * 1024


class StaticVersions:
    """Lazily hashes static files, re-hashing only when size or mtime changes."""

    def __init__(self, root):
        self._root = os.path.realpath(str(root or ''))
        self._cache = {}
        self._lock = threading.Lock()

    def version(self, filename):
        if not self._root or not isinstance(filename, str) or not filename:
            return None
        path = safe_join(self._root, filename)
        if path is None:
            return None
        try:
            stat = os.stat(path)
        except OSError:
            return None
        if not os.path.isfile(path):
            return None
        key = (stat.st_mtime_ns, stat.st_size)
        with self._lock:
            cached = self._cache.get(path)
        if cached is not None and cached[0] == key:
            return cached[1]
        digest = hashlib.sha256()
        try:
            with open(path, 'rb') as handle:
                for chunk in iter(lambda: handle.read(_CHUNK_BYTES), b''):
                    digest.update(chunk)
        except OSError:
            return None
        value = digest.hexdigest()[:_HASH_LENGTH]
        with self._lock:
            self._cache[path] = (key, value)
        return value


def register_static_versioning(app):
    """Attach the URL default and the immutable-cache header to one Flask app."""
    state = app.extensions.setdefault('lecture_processor', {})
    if state.get('static_versioning'):
        return state['static_versioning']
    versions = StaticVersions(app.static_folder)

    @app.url_defaults
    def _add_static_version(endpoint, values):
        if endpoint != 'static' or 'v' in values:
            return
        version = versions.version(values.get('filename'))
        if version:
            values['v'] = version

    @app.after_request
    def _cache_versioned_static(response):
        if request.endpoint != 'static' or response.status_code not in (200, 304):
            return response
        requested = request.args.get('v', '')
        filename = (request.view_args or {}).get('filename')
        if requested and requested == versions.version(filename):
            response.headers['Cache-Control'] = IMMUTABLE_CACHE_CONTROL
        return response

    state['static_versioning'] = versions
    return versions
