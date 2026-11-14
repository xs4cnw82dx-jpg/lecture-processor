import pytest


@pytest.fixture
def canonical_host(monkeypatch, core):
    monkeypatch.setenv('RENDER_EXTERNAL_HOSTNAME', 'preview.onrender.com')
    monkeypatch.setattr(core, 'PUBLIC_BASE_URL', 'https://lectureprocessor.com')
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: None)


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
@pytest.mark.parametrize('path', ['/', '/study?pack_id=pack%2Fone&tab=notes', '/buy_credits?payment=success', '/study?value=why?'])
def test_render_page_redirects_to_configured_origin(client, canonical_host, method, path):
    response = client.open(path, method=method, base_url='https://preview.onrender.com')

    assert response.status_code == 301
    assert response.headers['Location'] == 'https://lectureprocessor.com' + path
    if method == 'HEAD':
        assert response.data == b''


@pytest.mark.parametrize('host', ['lectureprocessor.com', 'localhost', 'unrelated.example', 'preview.onrender.com.evil.test'])
def test_other_hosts_are_not_redirected(client, canonical_host, host):
    response = client.get('/study', base_url='https://' + host)
    assert response.status_code == 200
    assert 'Location' not in response.headers


@pytest.mark.parametrize('method,path,status', [
    ('GET', '/healthz', 200),
    ('HEAD', '/healthz', 200),
    ('GET', '/api/runtime-jobs/active', 401),
    ('OPTIONS', '/api/runtime-jobs/active', 200),
    ('GET', '/api/stripe-webhook', 405),
    ('POST', '/study', 405),
    ('GET', '/static/css/theme.css', 200),
])
def test_non_page_requests_keep_their_behavior(client, canonical_host, method, path, status):
    response = client.open(path, method=method, base_url='https://preview.onrender.com')
    assert response.status_code == status
    assert 'Location' not in response.headers


@pytest.mark.parametrize('public_url', ['', 'https://preview.onrender.com', 'not-a-url', 'https://user:password@lectureprocessor.com'])
def test_missing_matching_or_invalid_public_origin_does_not_redirect(client, canonical_host, core, monkeypatch, public_url):
    monkeypatch.setattr(core, 'PUBLIC_BASE_URL', public_url)
    response = client.get('/study', base_url='https://preview.onrender.com')
    assert response.status_code == 200


def test_missing_render_hostname_does_not_redirect(client, canonical_host, monkeypatch):
    monkeypatch.delenv('RENDER_EXTERNAL_HOSTNAME')
    response = client.get('/study', base_url='https://preview.onrender.com')
    assert response.status_code == 200


@pytest.mark.parametrize('method', ['GET', 'HEAD'])
@pytest.mark.parametrize('path,scope', [
    ('/service-worker.js', '/voice-notes'),
    ('/admin/workout/service-worker.js', '/admin/workout'),
])
def test_service_workers_remain_on_their_registered_origin(client, canonical_host, method, path, scope):
    response = client.open(path, method=method, base_url='https://preview.onrender.com')
    assert response.status_code == 200
    assert response.mimetype == 'application/javascript'
    assert response.headers['Service-Worker-Allowed'] == scope
    assert 'Location' not in response.headers


@pytest.mark.parametrize('path', ['/api/processing-averages', '/api/processing-estimate'])
def test_retired_estimate_routes_do_not_authenticate_or_query(client, core, monkeypatch, path):
    calls = []
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: calls.append('auth'))
    response = client.get(path)
    assert response.status_code == 404
    assert calls == []
