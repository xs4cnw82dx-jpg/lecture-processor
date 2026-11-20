"""Static URLs carry a content version and only matching versions are cached long-term."""
import hashlib
import re
from pathlib import Path

from flask import url_for

from lecture_processor.runtime.static_assets import IMMUTABLE_CACHE_CONTROL, StaticVersions

STATIC = Path(__file__).resolve().parents[1] / 'static'


def expected_version(relative):
    return hashlib.sha256((STATIC / relative).read_bytes()).hexdigest()[:12]


def test_url_for_static_adds_the_content_version(client):
    app = client.application
    with app.test_request_context('/'):
        url = url_for('static', filename='css/theme.css')
        missing = url_for('static', filename='css/does-not-exist.css')
        explicit = url_for('static', filename='css/theme.css', v='pinned')
    assert url == f"/static/css/theme.css?v={expected_version('css/theme.css')}"
    assert missing == '/static/css/does-not-exist.css'
    assert explicit == '/static/css/theme.css?v=pinned'


def test_only_the_current_version_is_served_as_immutable(client):
    version = expected_version('css/theme.css')
    current = client.get(f'/static/css/theme.css?v={version}')
    assert current.status_code == 200
    assert current.headers['Cache-Control'] == IMMUTABLE_CACHE_CONTROL
    for url in ('/static/css/theme.css', '/static/css/theme.css?v=outdated000'):
        response = client.get(url)
        assert response.status_code == 200
        assert 'immutable' not in response.headers.get('Cache-Control', '')
    assert client.get(f'/static/css/does-not-exist.css?v={version}').status_code == 404


def test_rendered_pages_reference_versioned_static_files(client):
    html = client.get('/privacy').get_data(as_text=True)
    static_urls = re.findall(r'(?:src|href)="(/static/[^"]+)"', html)
    assert static_urls
    assert all(re.search(r'[?&]v=[0-9a-f]{12}', url) for url in static_urls)


def test_static_responses_skip_per_request_page_hooks(client):
    response = client.get('/static/css/theme.css')
    assert 'X-Request-ID' not in response.headers
    assert client.get('/privacy').headers.get('X-Request-ID')


def test_versions_follow_file_changes_and_reject_escapes(tmp_path):
    asset = tmp_path / 'app.js'
    asset.write_text('first', encoding='utf-8')
    versions = StaticVersions(tmp_path)
    first = versions.version('app.js')
    assert first == hashlib.sha256(b'first').hexdigest()[:12]
    asset.write_text('second version', encoding='utf-8')
    assert versions.version('app.js') == hashlib.sha256(b'second version').hexdigest()[:12]
    assert versions.version('../outside.js') is None
    assert versions.version('') is None and versions.version(None) is None
    (tmp_path / 'folder').mkdir()
    assert versions.version('folder') is None
