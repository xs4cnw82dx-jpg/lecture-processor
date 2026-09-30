from lecture_processor.domains.auth import session as auth_session
from lecture_processor.repositories import workout_repo


def _patch_admin(monkeypatch, runtime, *, admin=True):
    monkeypatch.setitem(runtime.__dict__, 'verify_firebase_token', lambda _request, check_revoked=False: {'uid': 'workout-admin', 'email': 'admin@example.com'})
    monkeypatch.setitem(runtime.__dict__, 'is_admin_user', lambda _decoded: admin)
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


def test_workout_cycle_session_and_sanitized_share_flow(allow_account_writes, client, monkeypatch, runtime):
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


def test_workout_session_revision_conflict_returns_current_state(allow_account_writes, client, monkeypatch, runtime):
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


def test_workout_service_worker_only_caches_verified_workout_shell(client):
    response = client.get('/admin/workout/service-worker.js')
    assert response.status_code == 200
    assert response.headers['Service-Worker-Allowed'] == '/admin/workout'
    source = response.get_data(as_text=True)
    assert "'/admin/workout'" not in source.split('STATIC_ASSETS', 1)[1].split('];', 1)[0]
    assert "url.pathname.startsWith('/api/')" in source
    assert "url.pathname.includes('/shares/')" in source
    assert "cache: 'no-store'" in source
    assert "response.ok" in source
    assert "response.redirected" in source
    assert "responseUrl.origin === self.location.origin" in source
    assert "responseUrl.pathname === WORKOUT_SHELL" in source
    assert "contentType.includes('text/html')" in source
    assert "cache.put(WORKOUT_SHELL, response.clone())" in source
    assert "cachedShell || caches.match(OFFLINE_PAGE)" in source
    assert "FIREBASE_ASSETS.includes(url.href)" in source
    assert "Promise.allSettled(FIREBASE_ASSETS.map" in source
    assert "event.data.type === 'SKIP_WAITING'" in source
    assert "event.data.type === 'CACHE_WORKOUT_SHELL'" in source
    assert "credentials: 'same-origin'" in source
    install_handler = source.split("self.addEventListener('install'", 1)[1].split("self.addEventListener('message'", 1)[0]
    assert "skipWaiting" not in install_handler


def _stored_session(session_id, timestamp, *, status='completed', kg=10, exercise_id='curl'):
    return {
        'id': session_id, 'name': session_id, 'status': status, 'routine_id': 'same-routine',
        'updated_at': timestamp, 'finished_at': timestamp, 'date': timestamp[:10],
        'elapsed_seconds': 60, 'revision': 1,
        'exercises': [{
            'exercise_id': exercise_id, 'exercise_name': exercise_id, 'tracking_type': 'weight_reps',
            'muscle_group': 'Biceps', 'target_sets': 1, 'rep_min': 8, 'rep_max': 10,
            'sets': [{'type': 'normal', 'kg': kg, 'reps': 10, 'rpe': 9, 'completed': True}],
        }],
    }


def test_large_workout_history_keeps_totals_records_and_an_old_paused_session(allow_account_writes, client, monkeypatch, runtime):
    from datetime import datetime, timedelta, timezone

    _patch_admin(monkeypatch, runtime)
    uid = 'workout-admin'
    for index in range(1105):
        timestamp = (datetime(2020, 1, 1, tzinfo=timezone.utc) + timedelta(days=index)).isoformat()
        workout_repo.set_record(None, workout_repo.SESSION_COLLECTION, uid, f'history-{index}', _stored_session(f'history-{index}', timestamp))
    # Insert both records after the old history cap; their dates are older too.
    workout_repo.set_record(None, workout_repo.SESSION_COLLECTION, uid, 'old-best', _stored_session('old-best', '2019-01-01T00:00:00+00:00', kg=50))
    workout_repo.set_record(None, workout_repo.SESSION_COLLECTION, uid, 'rare-exercise', _stored_session('rare-exercise', '2019-02-01T00:00:00+00:00', exercise_id='rare-curl', kg=15))
    workout_repo.set_record(None, workout_repo.SESSION_COLLECTION, uid, 'paused', _stored_session('paused', '2018-01-01T00:00:00+00:00', status='paused', kg=20))

    bootstrap = client.get('/api/admin/workout/bootstrap')
    assert bootstrap.status_code == 200
    body = bootstrap.get_json()
    assert len(body['history']) == 30
    assert [item['id'] for item in body['history'][:3]] == ['history-1104', 'history-1103', 'history-1102']
    assert body['statistics']['summary']['completed_workouts'] == 1107
    assert body['statistics']['records']['curl']['heaviest_kg'] == 50
    assert body['previous_values']['rare-curl'][0]['kg'] == 15
    assert body['active_session']['id'] == 'paused'
    recent = client.get('/api/admin/workout/sessions?status=completed&limit=2')
    assert [item['id'] for item in recent.get_json()['sessions']] == ['history-1104', 'history-1103']
    filtered = client.get('/api/admin/workout/sessions?status=paused&limit=1')
    assert [item['id'] for item in filtered.get_json()['sessions']] == ['paused']
    resumed = client.post('/api/admin/workout/sessions', json={})
    assert resumed.status_code == 200
    assert resumed.get_json()['resumed'] is True
    assert resumed.get_json()['session']['id'] == 'paused'
    finished = client.post('/api/admin/workout/sessions/paused/finish', json={'base_revision': 1})
    assert finished.status_code == 200
    assert finished.get_json()['session']['personal_records'] == []
    statistics = client.get('/api/admin/workout/statistics')
    assert statistics.status_code == 200
    assert statistics.get_json()['summary']['completed_workouts'] == 1108


def test_workout_bootstrap_keeps_all_weights_and_only_active_cycle_occurrences(client, monkeypatch, runtime):
    from datetime import date, timedelta

    _patch_admin(monkeypatch, runtime)
    uid = 'workout-admin'
    for index in range(505):
        day = (date(2020, 1, 1) + timedelta(days=index)).isoformat()
        workout_repo.set_record(None, workout_repo.BODYWEIGHT_COLLECTION, uid, day, {'date': day, 'kg': 65})
    for index in range(55):
        workout_repo.set_record(None, workout_repo.CYCLE_COLLECTION, uid, f'archived-{index}', {'created_at': f'2026-{index:02d}', 'status': 'archived'})
    workout_repo.set_record(None, workout_repo.CYCLE_COLLECTION, uid, 'active-old', {'created_at': '2019-01-01', 'status': 'active'})
    workout_repo.set_profile(None, uid, {'active_cycle_id': 'active-old'})
    for index in range(805):
        workout_repo.set_record(None, workout_repo.OCCURRENCE_COLLECTION, uid, f'old-{index}', {'cycle_id': 'archived-0', 'date': '2020-01-01'})
    workout_repo.set_record(None, workout_repo.OCCURRENCE_COLLECTION, uid, 'current', {'cycle_id': 'active-old', 'date': '2026-01-01', 'exercises': []})

    response = client.get('/api/admin/workout/bootstrap')
    assert response.status_code == 200
    body = response.get_json()
    assert body['active_cycle']['id'] == 'active-old'
    assert [item['id'] for item in body['occurrences']] == ['current']
    assert len(body['bodyweight']) == 505
    assert len(body['statistics']['bodyweight']) == 505
    weights = client.get('/api/admin/workout/bodyweight')
    assert weights.status_code == 200
    assert len(weights.get_json()['entries']) == 505
