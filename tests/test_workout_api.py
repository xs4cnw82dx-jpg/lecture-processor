from lecture_processor.domains.auth import session as auth_session
from lecture_processor.repositories import workout_repo
def _patch_admin(monkeypatch, runtime, *, admin=True):
    monkeypatch.setattr(runtime, 'verify_firebase_token', lambda _request, check_revoked=False: {'uid': 'workout-admin', 'email': 'admin@example.com'}, raising=False)
    monkeypatch.setattr(runtime, 'is_admin_user', lambda _decoded: admin, raising=False)
    monkeypatch.setattr(runtime, 'db', None, raising=False)
    workout_repo.clear_memory_state()


def test_workout_page_requires_admin_cookie_and_renders_pwa(client, monkeypatch):
    monkeypatch.setattr(auth_session, 'verify_admin_session_cookie', lambda _request, runtime=None: {'uid': 'workout-admin'})
    response = client.get('/admin/workout')
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert 'workout-manifest.webmanifest' in html
    assert 'rel="apple-touch-icon"' in html
    assert 'rel="apple-touch-icon-precomposed"' in html
    assert 'workout-touch-v2-180.png' in html
    assert 'viewport-fit=cover' in html
    assert 'workout-bottom-nav' in html
    assert 'Workout · Private Admin' in html


def test_workout_api_rejects_non_admin(client, monkeypatch, runtime):
    _patch_admin(monkeypatch, runtime, admin=False)
    response = client.get('/api/admin/workout/bootstrap')
    assert response.status_code == 403


def test_workout_cycle_session_and_sanitized_share_flow(client, monkeypatch, runtime):
    _patch_admin(monkeypatch, runtime)
    bootstrap = client.get('/api/admin/workout/bootstrap')
    assert bootstrap.status_code == 200
    body = bootstrap.get_json()
    assert body['seed']['integrity']['prescription_rows'] == 300
    assert len(body['routines']) == 8

    profile = client.put('/api/admin/workout/profile', json={
        'base_revision': body['profile']['revision'],
        'setup_completed': True,
        'bodyweight_kg': 63,
    })
    assert profile.status_code == 200

    cycle = client.post('/api/admin/workout/cycles', json={'start_monday': '2026-07-13'})
    assert cycle.status_code == 200
    cycle_body = cycle.get_json()
    assert len(cycle_body['occurrences']) == 40
    occurrence = cycle_body['occurrences'][0]

    started = client.post('/api/admin/workout/sessions', json={'occurrence_id': occurrence['id']})
    assert started.status_code == 201
    session = started.get_json()['session']
    resumed = client.post('/api/admin/workout/sessions', json={'occurrence_id': cycle_body['occurrences'][1]['id']})
    assert resumed.status_code == 200
    assert resumed.get_json()['resumed'] is True
    assert resumed.get_json()['session']['id'] == session['id']
    session['exercises'][0]['notes'] = 'keep this private'
    session['exercises'][0]['sets'][0].update({'completed': True, 'kg': 5, 'reps': 8, 'rpe': 9})
    finished = client.post(f"/api/admin/workout/sessions/{session['id']}/finish", json={
        'base_revision': session['revision'],
        'elapsed_seconds': 1200,
        'exercises': session['exercises'],
    })
    assert finished.status_code == 200
    completed = finished.get_json()['session']
    assert completed['status'] == 'completed'
    assert completed['volume_kg'] > 0

    share = client.post('/api/admin/workout/shares', json={'kind': 'workout', 'source_id': session['id']})
    assert share.status_code == 201
    token = share.get_json()['share']['token']
    public = client.get(f'/api/workout-shares/{token}')
    assert public.status_code == 200
    assert client.get(f'/workout-shares/{token}').status_code == 200
    serialized = str(public.get_json())
    assert 'keep this private' not in serialized
    assert 'bodyweight_kg' not in serialized
    assert 'workout-admin' not in serialized

    revoked = client.delete(f'/api/admin/workout/shares/{token}')
    assert revoked.status_code == 200
    assert client.get(f'/api/workout-shares/{token}').status_code == 404
    assert client.get(f'/workout-shares/{token}').status_code == 404
    rotated = client.post('/api/admin/workout/shares', json={'kind': 'workout', 'source_id': session['id'], 'token': token})
    assert rotated.status_code == 201
    assert rotated.get_json()['share']['token'] != token


def test_missing_workout_share_page_returns_not_found(client, monkeypatch, runtime):
    monkeypatch.setattr(runtime, 'db', None, raising=False)
    workout_repo.clear_memory_state()

    response = client.get('/workout-shares/this-token-does-not-exist')

    assert response.status_code == 404


def test_workout_session_revision_conflict_returns_current_state(client, monkeypatch, runtime):
    _patch_admin(monkeypatch, runtime)
    started = client.post('/api/admin/workout/sessions', json={})
    assert started.status_code == 201
    session = started.get_json()['session']
    conflict = client.patch(f"/api/admin/workout/sessions/{session['id']}", json={
        'base_revision': session['revision'] + 99,
        'exercises': [],
    })
    assert conflict.status_code == 409
    assert conflict.get_json()['current']['id'] == session['id']


def test_workout_service_worker_is_narrow_and_never_caches_private_page(client):
    response = client.get('/admin/workout/service-worker.js')
    assert response.status_code == 200
    assert response.headers['Service-Worker-Allowed'] == '/admin/workout'
    source = response.get_data(as_text=True)
    assert "'/admin/workout'" not in source.split('STATIC_ASSETS', 1)[1].split('];', 1)[0]
    assert "url.pathname.startsWith('/api/')" in source
    assert "cache: 'no-store'" in source
