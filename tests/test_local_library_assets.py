"""HTTP-level checks for the pinned date picker and CSV parser distributions."""

import base64
import hashlib
from html.parser import HTMLParser
from urllib.parse import urlparse

import pytest


@pytest.mark.parametrize(('path', 'size', 'integrity', 'mime'), [
    (
        '/static/js/vendor/flatpickr-4.6.13/flatpickr.min.js', 50679,
        '5JqMv4L/Xa0hfvtF06qboNdhvuYXUku9ZrhZh3bSk8VXF0A/RuSLHpLsSV9Zqhl6',
        'text/javascript',
    ),
    (
        '/static/js/vendor/flatpickr-4.6.13/flatpickr.min.css', 16166,
        'RkASv+6KfBMW9eknReJIJ6b3UnjKOKC5bOUaNgIY778NFbQ8MtWq9Lr/khUgqtTt',
        'text/css',
    ),
    (
        '/static/js/vendor/papaparse-5.5.3/papaparse.min.js', 19419,
        'Jd2/X5FXVKahwaY2nivvw4LfSTg9idSj8yNXWtT4qef0fHSYr6M7M8bJAfbFYoMc',
        'text/javascript',
    ),
])
def test_local_distribution_response_preserves_upstream_bytes(client, path, size, integrity, mime):
    response = client.get(path)

    assert response.status_code == 200
    assert response.mimetype == mime
    assert len(response.data) == size
    assert base64.b64encode(hashlib.sha384(response.data).digest()).decode() == integrity
    assert response.headers['X-Content-Type-Options'] == 'nosniff'


def test_page_csp_allows_local_vendors_without_jsdelivr(client):
    response = client.get('/study')
    assert response.status_code == 200
    directives = {
        fields[0]: fields[1:]
        for part in response.headers['Content-Security-Policy'].split(';')
        if (fields := part.split())
    }

    assert "'self'" in directives['script-src']
    assert "'self'" in directives['style-src']
    assert 'https://cdn.jsdelivr.net' not in directives['script-src']
    assert 'https://cdn.jsdelivr.net' not in directives['style-src']
    assert 'https://www.gstatic.com' in directives['script-src']
    assert 'https://apis.google.com' in directives['script-src']
    assert 'https://browser.sentry-cdn.com' in directives['script-src']
    assert 'https://fonts.googleapis.com' in directives['style-src']
    assert 'https://fonts.gstatic.com' in directives['font-src']


@pytest.mark.parametrize('path', ['/plan', '/calendar'])
def test_legacy_planning_page_vendor_tags_use_verified_local_responses(client, core, monkeypatch, path):
    monkeypatch.setattr(core, 'STUDY_PLAN_V2', False)
    assets = []

    class VendorTags(HTMLParser):
        def handle_starttag(self, tag, attrs):
            attributes = dict(attrs)
            url = attributes.get('src' if tag == 'script' else 'href', '')
            if tag in {'script', 'link'} and 'flatpickr' in url:
                assets.append((url, attributes.get('integrity')))

    response = client.get(path)
    assert response.status_code == 200
    VendorTags().feed(response.get_data(as_text=True))
    assert len(assets) == 2
    for url, integrity in assets:
        assert not urlparse(url).netloc
        asset = client.get(url)
        assert asset.status_code == 200
        assert integrity == 'sha384-' + base64.b64encode(hashlib.sha384(asset.data).digest()).decode()
