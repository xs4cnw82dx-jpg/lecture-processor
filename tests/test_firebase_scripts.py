"""Pages that sign in load the pinned Firebase SDK once, with integrity, before the bootstrap."""
import re

import pytest

APP_SDK = 'https://www.gstatic.com/firebasejs/12.10.0/firebase-app-compat.js'
AUTH_SDK = 'https://www.gstatic.com/firebasejs/12.10.0/firebase-auth-compat.js'

SIGNED_IN_PAGES = [
    '/lecture-notes', '/study', '/plan', '/dashboard', '/settings', '/buy_credits', '/batch_mode', '/voice-notes',
    '/general-transcriber', '/lecture-downloader', '/document-reader', '/shared/demo-token', '/tools',
]


def _scripts(html):
    return [(m.group(1), m.group(0)) for m in re.finditer(r'<script\b[^>]*\bsrc="([^"]+)"[^>]*>', html)]


@pytest.mark.parametrize('path', SIGNED_IN_PAGES)
def test_signed_in_pages_load_firebase_once_with_integrity_before_the_bootstrap(client, path):
    response = client.get(path)
    assert response.status_code == 200
    scripts = _scripts(response.get_data(as_text=True))
    sources = [src for src, _tag in scripts]

    app = [tag for src, tag in scripts if src == APP_SDK]
    auth = [tag for src, tag in scripts if src == AUTH_SDK]
    bootstrap = [i for i, src in enumerate(sources) if '/static/js/firebase-bootstrap.js' in src]
    assert len(app) == 1 and len(auth) == 1 and len(bootstrap) == 1, sources
    for tag in app + auth:
        assert re.search(r'integrity="sha384-[A-Za-z0-9+/=]{64}"', tag), tag
        assert 'crossorigin="anonymous"' in tag, tag
    assert sources.index(APP_SDK) < sources.index(AUTH_SDK) < bootstrap[0]
