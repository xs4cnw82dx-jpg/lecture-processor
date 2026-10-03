"""Google onboarding security, restart-safe synchronization, and calendar correctness."""
from datetime import date, timedelta
from urllib.parse import parse_qs, urlsplit
import json
import time

from cryptography.fernet import Fernet
import pytest

from tests.test_study_plan_api import study_plan_runtime, _headers
from lecture_processor.services import calendar_sync_service as sync
from tests.runtime_test_support import get_test_core

core = get_test_core()


@pytest.fixture
def calendar_runtime(monkeypatch, study_plan_runtime, runtime):
    sync._MEMORY.clear()
    values = {
        'GOOGLE_CALENDAR_ENABLED': '1', 'GOOGLE_CALENDAR_CLIENT_ID': 'client-id',
        'GOOGLE_CALENDAR_CLIENT_SECRET': 'client-secret',
        'GOOGLE_CALENDAR_REDIRECT_URI': 'http://localhost/api/study-plan/calendar/google/callback',
        'CALENDAR_TOKEN_ENCRYPTION_KEYS': Fernet.generate_key().decode(),
        'CALENDAR_WORKER_SERVICE_ACCOUNT_EMAIL': 'worker@example.test',
        'CALENDAR_WORKER_AUDIENCE': 'https://example.test/internal/study-plan/calendar-sync/drain',
    }
    for key, value in values.items():
        monkeypatch.setenv(key, value)
    yield {**study_plan_runtime, 'ctx': runtime}
    sync._MEMORY.clear()


def connect(client, monkeypatch, uid, ctx):
    started = client.post('/api/study-plan/calendar/google/connect', headers=_headers(), json={})
    assert started.status_code == 200
    params = parse_qs(urlsplit(started.json['authorization_url']).query)
    state, nonce = params['state'][0], params['nonce'][0]
    monkeypatch.setattr(sync, '_token_request', lambda body: {'refresh_token': 'secret-refresh', 'id_token': 'identity', 'scope': sync.SCOPE})
    monkeypatch.setattr(sync.id_token, 'verify_oauth2_token', lambda *a: {'sub': 'google-sub', 'email': 'google@example.test', 'email_verified': True, 'nonce': nonce})
    response = client.get('/api/study-plan/calendar/google/callback?state=' + state + '&code=authorization')
    return response, state


def test_oauth_uses_narrow_scope_and_encrypts_credentials(client, monkeypatch, calendar_runtime):
    ctx, uid = calendar_runtime['ctx'], calendar_runtime['uid']
    response, state = connect(client, monkeypatch, uid, ctx)
    assert 'calendar_result=connected' in response.location
    stored = sync._get(ctx, sync.CONNECTIONS, uid)
    assert 'secret-refresh' not in json.dumps(stored)
    assert json.loads(sync._cipher().decrypt(stored['credentials'].encode()))['refresh_token'] == 'secret-refresh'
    visible = client.get('/api/study-plan/calendar/google', headers=_headers()).json
    assert visible['email'] == 'google@example.test'
    assert 'credentials' not in visible and 'google_sub' not in visible
    assert visible['pending'] is True
    # The consumed state cannot exchange the code again, even in the same browser.
    again = client.get('/api/study-plan/calendar/google/callback?state=' + state + '&code=authorization')
    assert 'calendar_result=error' in again.location


def test_oauth_state_is_browser_bound_and_expires(client, calendar_runtime):
    started = client.post('/api/study-plan/calendar/google/connect', headers=_headers(), json={})
    params = parse_qs(urlsplit(started.json['authorization_url']).query)
    assert params['scope'][0].split() == sync.SCOPES
    assert params['access_type'] == ['offline']
    state = params['state'][0]
    client.delete_cookie('lp_calendar_oauth', path='/api/study-plan/calendar/google')
    response = client.get('/api/study-plan/calendar/google/callback?state=' + state + '&code=x')
    assert 'calendar_result=error' in response.location
    assert not sync._get(calendar_runtime['ctx'], sync.CONNECTIONS, calendar_runtime['uid'])


def test_disabled_connection_preserves_subscription_alternative(client, calendar_runtime, monkeypatch):
    monkeypatch.delenv('CALENDAR_TOKEN_ENCRYPTION_KEYS')
    assert client.get('/api/study-plan/calendar/google', headers=_headers()).json['available'] is False
    assert client.post('/api/study-plan/calendar/google/connect', headers=_headers(), json={}).status_code == 503
    assert client.post('/api/study-plan/calendar-feeds', headers=_headers(), json={'provider': 'apple'}).status_code == 201


def seed_connection(ctx, uid):
    sync._set(ctx, sync.CONNECTIONS, uid, {
        'uid': uid, 'status': 'pending', 'calendar_name': 'Lecture Processor Study Plan',
        'connection_id': 'a' * 32, 'include_deadlines': True, 'reminder_offset_minutes': 30,
    }, merge=False)
    sync.mark_dirty(ctx, uid)


def fake_google(monkeypatch):
    events, calls = {}, []
    def api(method, path, token, payload=None):
        calls.append((method, path, payload))
        if path == '/calendars' and method == 'POST':
            return {'id': 'study@calendar.test'}
        if path == '/calendars/study%40calendar.test':
            return {'id': 'study@calendar.test'}
        if method == 'POST':
            event_id = payload['id']
            if event_id in events:
                raise sync.CalendarError('duplicate', 'duplicate')
            events[event_id] = payload
        elif method == 'PUT':
            events[path.rsplit('/', 1)[1]] = payload
        elif method == 'DELETE':
            events.pop(path.rsplit('/', 1)[1], None)
        return {}
    monkeypatch.setattr(sync, '_access_token', lambda c: 'access-token')
    monkeypatch.setattr(sync, '_google', api)
    return events, calls


def make_session(client, runtime, **overrides):
    payload = {'title': 'Anatomy study', 'date': date.today().isoformat(), 'time': '17:00',
               'duration': 45, 'pack_id': runtime['pack_id'], **overrides}
    response = client.put('/api/study-plan/items/calendar_item', headers=_headers(), json=payload)
    assert response.status_code in {200, 201}, response.json
    return response.json['session']


def test_worker_creates_updates_and_cancels_without_duplicates(client, calendar_runtime, monkeypatch):
    ctx, uid = calendar_runtime['ctx'], calendar_runtime['uid']
    seed_connection(ctx, uid)
    session = make_session(client, calendar_runtime)
    events, calls = fake_google(monkeypatch)
    result = sync.drain_user(ctx, uid)
    assert result['complete'] and len(events) == 1
    event_id, event = next(iter(events.items()))
    assert event['start']['dateTime'].endswith('17:00:00+00:00')
    assert event['end']['dateTime'].endswith('17:45:00+00:00')
    make_session(client, calendar_runtime, revision=session['revision'], time='18:15')
    sync.mark_dirty(ctx, uid)
    sync.drain_user(ctx, uid)
    assert list(events) == [event_id]
    assert events[event_id]['start']['dateTime'].endswith('18:15:00+00:00')
    make_session(client, calendar_runtime, status='cancelled')
    sync.mark_dirty(ctx, uid)
    sync.drain_user(ctx, uid)
    assert not events
    assert len([call for call in calls if call[:2] == ('POST', '/calendars')]) == 1


def test_leases_and_concurrent_dirty_generation_are_not_lost(calendar_runtime):
    ctx, uid = calendar_runtime['ctx'], calendar_runtime['uid']
    seed_connection(ctx, uid)
    queue = sync._lease(ctx, uid)
    assert sync._lease(ctx, uid) is None
    sync.mark_dirty(ctx, uid)
    sync._finish(ctx, uid, queue['lease'], {'completed_generation': queue['generation'], 'next_attempt_at': time.time() + 21600, 'attempts': 0})
    assert sync._get(ctx, sync.OUTBOX, uid)['next_attempt_at'] == 0
    assert sync._lease(ctx, uid) is not None


def test_retry_preserves_queue_and_never_recreates_calendar(client, calendar_runtime, monkeypatch):
    ctx, uid = calendar_runtime['ctx'], calendar_runtime['uid']
    seed_connection(ctx, uid)
    sync._set(ctx, sync.CONNECTIONS, uid, {'calendar_id': 'existing'})
    make_session(client, calendar_runtime)
    monkeypatch.setattr(sync, '_access_token', lambda c: 'access')
    monkeypatch.setattr(sync, '_google', lambda *args: (_ for _ in ()).throw(sync.CalendarError('Rate limited', 'rate_limited', retry=True, retry_after=120)))
    result = sync.drain_user(ctx, uid)
    assert result['status'] == 'retrying'
    queue = sync._get(ctx, sync.OUTBOX, uid)
    assert queue['lease_until'] == 0 and queue['next_attempt_at'] >= time.time() + 115
    assert sync._get(ctx, sync.CONNECTIONS, uid)['calendar_id'] == 'existing'


def test_ambiguous_calendar_creation_requires_explicit_recovery(calendar_runtime, monkeypatch):
    ctx, uid = calendar_runtime['ctx'], calendar_runtime['uid']
    seed_connection(ctx, uid)
    sync._set(ctx, sync.CONNECTIONS, uid, {'creation_state': 'in_flight'})
    monkeypatch.setattr(sync, '_access_token', lambda c: 'access')
    monkeypatch.setattr(sync, '_google', lambda *args: pytest.fail('Must not retry calendar creation'))
    assert sync.drain_user(ctx, uid)['status'] == 'needs_attention'
    assert sync._get(ctx, sync.CONNECTIONS, uid)['error_code'] == 'creation_uncertain'


def test_disconnect_default_keeps_calendar_and_erases_tokens(client, calendar_runtime, monkeypatch):
    ctx, uid = calendar_runtime['ctx'], calendar_runtime['uid']
    seed_connection(ctx, uid)
    monkeypatch.setattr(sync, '_revoke', lambda c: None)
    monkeypatch.setattr(sync, '_google', lambda *args: pytest.fail('Default disconnect must keep calendar'))
    assert client.post('/api/study-plan/calendar/google/disconnect', headers=_headers(), json={}).status_code == 202
    assert sync.drain_user(ctx, uid)['disconnected']
    assert not sync._get(ctx, sync.CONNECTIONS, uid)
    assert not sync._get(ctx, sync.OUTBOX, uid)


def test_worker_oidc_rejects_wrong_identity(client, calendar_runtime, monkeypatch):
    monkeypatch.setattr(sync.id_token, 'verify_oauth2_token', lambda *args: {'email': 'attacker@example.test', 'email_verified': True})
    response = client.post('/internal/study-plan/calendar-sync/drain', json={'uid': calendar_runtime['uid']}, headers={'Authorization': 'Bearer attack'})
    assert response.status_code == 401


def test_feed_includes_more_than_400_records_with_stable_timestamp(client, calendar_runtime):
    uid = calendar_runtime['uid']
    day = date.today().isoformat()
    for index in range(450):
        core.planner_repo.set_planner_session(None, uid, 'many_' + str(index), {
            'id': 'many_' + str(index), 'uid': uid, 'date': day, 'time': '17:00', 'duration': 45,
            'title': 'Study ' + str(index), 'status': 'planned', 'updated_at': 1720000000,
        }, merge=False)
    feed = client.post('/api/study-plan/calendar-feeds', headers=_headers(), json={}).json
    url = urlsplit(feed['subscription_url']).path
    first, second = client.get(url), client.get(url)
    assert first.text.count('BEGIN:VEVENT') == 450
    assert first.data == second.data
    assert first.headers['ETag'] == second.headers['ETag']


def test_session_timezone_uses_saved_instant_across_dst():
    for day, expected in [('2026-10-24', '15:00:00+00:00'), ('2026-10-26', '16:00:00+00:00')]:
        instant = sync.session_start({'date': day, 'time': '17:00', 'timezone': 'Europe/Amsterdam'}, {'timezone': 'UTC'})
        assert instant.isoformat().endswith(expected)
    instant = sync.session_start({'date': '2026-10-24', 'time': '17:00', 'starts_at_utc': '2026-10-24T15:00:00Z'}, {'timezone': 'America/New_York'})
    assert instant.isoformat().endswith('15:00:00+00:00')


def test_disconnect_removes_only_managed_events_and_preserves_manual_events(client, calendar_runtime, monkeypatch):
    ctx, uid = calendar_runtime['ctx'], calendar_runtime['uid']
    seed_connection(ctx, uid)
    make_session(client, calendar_runtime)
    events, calls = fake_google(monkeypatch)
    monkeypatch.setattr(sync, '_revoke', lambda c: None)
    sync.drain_user(ctx, uid)
    events['my-personal-event'] = {'summary': 'My personal appointment'}
    response = client.post('/api/study-plan/calendar/google/disconnect', headers=_headers(), json={'remove_synced_events': True})
    assert response.status_code == 202
    assert sync.drain_user(ctx, uid)['disconnected']
    assert list(events) == ['my-personal-event']
    assert not any(method == 'DELETE' and '/events/' not in path for method, path, _ in calls)


def test_old_worker_cannot_write_after_reconnect_or_delete(calendar_runtime):
    ctx, uid = calendar_runtime['ctx'], calendar_runtime['uid']
    seed_connection(ctx, uid)
    old = sync._get(ctx, sync.CONNECTIONS, uid)
    sync._set(ctx, sync.CONNECTIONS, uid, {'epoch': 'new-oauth-generation'})
    assert sync._connection_update(ctx, uid, old, {'status': 'connected'}) is False
    assert sync._write_mapping(ctx, uid, old, 'some-event', {'uid': uid}) is False
    sync._delete(ctx, sync.CONNECTIONS, uid)
    assert sync._write_mapping(ctx, uid, old, 'some-event', {'uid': uid}) is False
    assert sync._get(ctx, sync.EVENTS, 'some-event') == {}


def test_callback_cannot_restore_connection_after_concurrent_disconnect(client, monkeypatch, calendar_runtime):
    ctx, uid = calendar_runtime['ctx'], calendar_runtime['uid']
    seed_connection(ctx, uid)
    sync._set(ctx, sync.CONNECTIONS, uid, {'status': 'reconnect_required', 'epoch': 'old'})
    started = client.post('/api/study-plan/calendar/google/connect', headers=_headers(), json={})
    params = parse_qs(urlsplit(started.json['authorization_url']).query)
    def token_request(body):
        sync._set(ctx, sync.CONNECTIONS, uid, {'status': 'disconnecting', 'epoch': 'disconnect'})
        return {'refresh_token': 'secret-refresh', 'id_token': 'identity', 'scope': sync.SCOPE}
    monkeypatch.setattr(sync, '_token_request', token_request)
    monkeypatch.setattr(sync.id_token, 'verify_oauth2_token', lambda *a: {'sub': 'google-sub', 'email': 'google@example.test', 'email_verified': True, 'nonce': params['nonce'][0]})
    response = client.get('/api/study-plan/calendar/google/callback?state=' + params['state'][0] + '&code=x')
    assert 'connection_changed' in response.location
    assert sync._get(ctx, sync.CONNECTIONS, uid)['status'] == 'disconnecting'
    assert 'credentials' not in sync._get(ctx, sync.CONNECTIONS, uid)


def test_event_insert_timeout_replays_same_id_using_reserved_mapping(client, calendar_runtime, monkeypatch):
    ctx, uid = calendar_runtime['ctx'], calendar_runtime['uid']
    seed_connection(ctx, uid)
    make_session(client, calendar_runtime)
    events, calls = fake_google(monkeypatch)
    original = sync._google
    interrupted = False
    def interrupted_insert(method, path, token, payload=None):
        nonlocal interrupted
        result = original(method, path, token, payload)
        if method == 'POST' and '/events' in path and not interrupted:
            interrupted = True
            raise sync.requests.Timeout('response lost')
        return result
    monkeypatch.setattr(sync, '_google', interrupted_insert)
    assert sync.drain_user(ctx, uid)['status'] == 'retrying'
    event_id = next(iter(events))
    sync.mark_dirty(ctx, uid)
    assert sync.drain_user(ctx, uid)['complete']
    assert list(events) == [event_id]
    assert any(method == 'PUT' and path.endswith(event_id) for method, path, _ in calls)
