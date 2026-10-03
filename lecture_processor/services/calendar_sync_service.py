"""Private Google Calendar connection and durable, one-way study-plan synchronization.

Firebase functions wake the bounded worker; Firestore owns its queue and leases.
OAuth credentials never form part of the public connection response.
"""
from __future__ import annotations

import hashlib
import hmac
import json
import os
import secrets
import threading
import time
from datetime import date, datetime, timedelta, timezone
from urllib.parse import urlencode

import requests
from cryptography.fernet import Fernet, MultiFernet
from flask import make_response, redirect
from google.auth.transport.requests import Request as GoogleRequest
from google.auth.exceptions import GoogleAuthError
from google.oauth2 import id_token

from lecture_processor.services import access_service
from lecture_processor.domains.account import lifecycle
from lecture_processor.repositories.query_utils import apply_where

SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
SCOPES = [SCOPE, 'openid', 'email']
CONNECTIONS = 'study_google_calendars'
OUTBOX = 'study_calendar_outbox'
STATES = 'study_calendar_oauth_states'
EVENTS = 'study_calendar_events'
_MEMORY = {}
_LOCK = threading.RLock()
API = 'https://www.googleapis.com/calendar/v3'


class CalendarError(Exception):
    def __init__(self, message, code='calendar_error', retry=False, retry_after=0):
        super().__init__(message)
        self.code, self.retry, self.retry_after = code, retry, retry_after


def _env(name):
    return os.environ.get(name, '').strip()


def _cipher():
    try:
        return MultiFernet([Fernet(key.strip()) for key in _env('CALENDAR_TOKEN_ENCRYPTION_KEYS').split(',') if key.strip()])
    except (ValueError, TypeError):
        raise CalendarError('Google Calendar encryption is not configured.', 'configuration') from None


def available():
    required = ('GOOGLE_CALENDAR_CLIENT_ID', 'GOOGLE_CALENDAR_CLIENT_SECRET', 'GOOGLE_CALENDAR_REDIRECT_URI',
                'CALENDAR_TOKEN_ENCRYPTION_KEYS', 'CALENDAR_WORKER_SERVICE_ACCOUNT_EMAIL', 'CALENDAR_WORKER_AUDIENCE')
    if _env('GOOGLE_CALENDAR_ENABLED').lower() not in {'1', 'true'} or not all(_env(key) for key in required):
        return False
    try:
        _cipher()
    except CalendarError:
        return False
    return True


def _get(ctx, collection, key):
    if ctx.db is None:
        return dict(_MEMORY.get((collection, key), {}))
    snapshot = ctx.db.collection(collection).document(key).get()
    return snapshot.to_dict() or {} if snapshot.exists else {}


def _set(ctx, collection, key, data, merge=True):
    if ctx.db is None:
        with _LOCK:
            _MEMORY[collection, key] = {**(_MEMORY.get((collection, key), {}) if merge else {}), **data}
    else:
        ctx.db.collection(collection).document(key).set(data, merge=merge)


def _delete(ctx, collection, key):
    if ctx.db is None:
        _MEMORY.pop((collection, key), None)
    else:
        ctx.db.collection(collection).document(key).delete()


def _atomic(ctx, collection, key, transform, account_uid=None):
    """Transform under a transaction; return a result independently of stored data."""
    if ctx.db is None:
        with _LOCK:
            if account_uid and not lifecycle.ensure_account_allows_writes(account_uid, runtime=ctx)[0]:
                raise lifecycle.AccountUnavailableError('Account unavailable')
            data, result = transform(_get(ctx, collection, key))
            if data is not None:
                _set(ctx, collection, key, data, merge=False)
            return result
    from google.cloud import firestore
    ref = ctx.db.collection(collection).document(key)
    @firestore.transactional
    def commit(transaction):
        if account_uid:
            lifecycle.require_account_access(account_uid, runtime=ctx, transaction=transaction)
        snapshot = ref.get(transaction=transaction)
        data, result = transform(snapshot.to_dict() or {} if snapshot.exists else {})
        if data is not None:
            transaction.set(ref, data)
        return result
    return commit(ctx.db.transaction())


def mark_dirty(ctx, uid, batch=None):
    connection = _get(ctx, CONNECTIONS, uid)
    if connection.get('status') not in {'pending', 'syncing', 'connected', 'retrying', 'disconnecting'}:
        return
    if batch is not None and ctx.db is not None:
        from google.cloud import firestore
        batch.set(ctx.db.collection(OUTBOX).document(uid), {
            'uid': uid, 'generation': firestore.Increment(1), 'next_attempt_at': 0,
        }, merge=True)
        return
    def dirty(current):
        return {**current, 'uid': uid, 'generation': int(current.get('generation', 0)) + 1, 'next_attempt_at': 0}, None
    try:
        _atomic(ctx, OUTBOX, uid, dirty, account_uid=uid)
    except lifecycle.AccountUnavailableError:
        return


def public_state(ctx, uid):
    raw = _get(ctx, CONNECTIONS, uid)
    fields = ('status', 'email', 'calendar_id', 'calendar_name', 'last_synced_at', 'error_code', 'message',
              'include_deadlines', 'reminder_offset_minutes', 'synced_count', 'created_at')
    result = {key: raw[key] for key in fields if key in raw}
    result.setdefault('status', 'disconnected')
    result['available'] = available()
    queue = _get(ctx, OUTBOX, uid)
    result['pending'] = int(queue.get('generation', 0)) > int(queue.get('completed_generation', 0))
    return result


def _settings(body):
    try:
        reminder = int(body.get('reminder_offset_minutes', 30))
    except (ValueError, TypeError):
        raise CalendarError('Choose a valid reminder.', 'invalid_settings') from None
    if reminder not in {0, 10, 30, 60, 1440}:
        raise CalendarError('Choose a valid reminder.', 'invalid_settings')
    return {'include_deadlines': bool(body.get('include_deadlines', True)), 'reminder_offset_minutes': reminder}


def handle(ctx, request, action):
    user, error, status = access_service.require_allowed_user(ctx, request)
    if error is not None:
        return error, status
    uid = user['uid']
    if action == 'status':
        return ctx.jsonify(public_state(ctx, uid))
    allowed, message = lifecycle.ensure_account_allows_writes(uid, runtime=ctx)
    if not allowed:
        return ctx.jsonify({'error': message}), 409
    body = request.get_json(silent=True) or {}
    if not isinstance(body, dict):
        return ctx.jsonify({'error': 'Expected a JSON object.'}), 400
    try:
        connection = _get(ctx, CONNECTIONS, uid)
        if action == 'connect':
            if not available():
                return ctx.jsonify({'error': 'Google connection is not configured yet. You can still subscribe with a link.'}), 503
            if connection.get('status') in {'disconnecting', 'pending', 'syncing'}:
                return ctx.jsonify({'error': 'Please wait for the current calendar operation to finish.'}), 409
            state, nonce = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            _set(ctx, STATES, hashlib.sha256(state.encode()).hexdigest(), {
                'uid': uid, 'expires_at': time.time() + 600, 'nonce_hash': hashlib.sha256(nonce.encode()).hexdigest(),
                'settings': _settings(body), 'used': False,
                'expected_epoch': connection.get('epoch', ''), 'expected_connection_id': connection.get('connection_id', ''),
            }, merge=False)
            params = {'client_id': _env('GOOGLE_CALENDAR_CLIENT_ID'), 'redirect_uri': _env('GOOGLE_CALENDAR_REDIRECT_URI'),
                      'response_type': 'code', 'scope': ' '.join(SCOPES), 'access_type': 'offline',
                      'prompt': 'consent select_account', 'state': state, 'nonce': nonce}
            response = ctx.jsonify({'authorization_url': 'https://accounts.google.com/o/oauth2/v2/auth?' + urlencode(params)})
            response.set_cookie('lp_calendar_oauth', nonce, max_age=600, secure=not request.host.startswith(('localhost', '127.0.0.1')),
                                httponly=True, samesite='Lax', path='/api/study-plan/calendar/google')
            response.headers['Cache-Control'] = 'no-store'
            return response
        if not connection or connection.get('status') == 'disconnected':
            return ctx.jsonify({'error': 'Connect Google Calendar first.'}), 409
        updates = {}
        if action == 'settings':
            updates = _settings(body)
        elif action == 'disconnect':
            updates = {'status': 'disconnecting', 'remove_synced_events': body.get('remove_synced_events', body.get('remove_calendar', False)) is True,
                       'epoch': secrets.token_hex(16), 'message': 'Disconnecting Google Calendar…', 'error_code': ''}
        elif action == 'sync':
            if connection.get('error_code') == 'creation_uncertain' and not body.get('confirm_recreate'):
                return ctx.jsonify({'error': 'Check Google Calendar for an empty study calendar before trying again.', 'code': 'creation_uncertain'}), 409
            if connection.get('status') == 'reconnect_required':
                return ctx.jsonify({'error': 'Reconnect your Google account first.'}), 409
            if body.get('confirm_recreate') is True:
                updates.update({'creation_state': '', 'calendar_id': '', 'epoch': secrets.token_hex(16)})
            updates.update({'status': 'pending', 'error_code': '', 'message': 'Waiting to sync…'})
        def mutate(current):
            if not _same_connection(current, connection) or (current.get('status') == 'disconnecting' and action != 'disconnect'):
                raise CalendarError('Calendar connection changed. Refresh and try again.', 'connection_changed')
            return {**current, **updates}, None
        _atomic(ctx, CONNECTIONS, uid, mutate, account_uid=uid)
        mark_dirty(ctx, uid)
        return ctx.jsonify(public_state(ctx, uid)), 202
    except lifecycle.AccountUnavailableError:
        return ctx.jsonify({'error': 'Account is unavailable.'}), 409
    except CalendarError as error:
        return ctx.jsonify({'error': str(error), 'code': error.code}), 409 if error.code == 'connection_changed' else 400


def callback(ctx, request):
    state = request.args.get('state', '')
    nonce = request.cookies.get('lp_calendar_oauth', '')
    key = hashlib.sha256(state.encode()).hexdigest()
    def consume(record):
        valid = state and nonce and record and not record.get('used') and record.get('expires_at', 0) > time.time()
        valid = valid and hmac.compare_digest(record.get('nonce_hash', ''), hashlib.sha256(nonce.encode()).hexdigest())
        return ({**record, 'used': True} if valid else None), (record if valid else None)
    record = _atomic(ctx, STATES, key, consume)
    outcome = 'error'
    if record:
        uid = record['uid']
        try:
            allowed, _ = lifecycle.ensure_account_allows_writes(uid, runtime=ctx)
            if not allowed:
                raise CalendarError('Account is unavailable.', 'account_unavailable')
            if request.args.get('error'):
                outcome = 'cancelled'
            else:
                token = _token_request({'code': request.args.get('code', ''), 'grant_type': 'authorization_code',
                                        'redirect_uri': _env('GOOGLE_CALENDAR_REDIRECT_URI')})
                claims = id_token.verify_oauth2_token(token.get('id_token', ''), GoogleRequest(), _env('GOOGLE_CALENDAR_CLIENT_ID'))
                if not claims.get('email_verified') or claims.get('nonce') != nonce:
                    raise CalendarError('Google identity could not be verified.', 'identity')
                if SCOPE not in token.get('scope', '').split():
                    raise CalendarError('Allow access to the study calendar to connect.', 'scope_missing')
                old = _get(ctx, CONNECTIONS, uid)
                if old.get('google_sub') and old['google_sub'] != claims['sub'] and old.get('status') != 'disconnected':
                    raise CalendarError('Reconnect the same Google account, or disconnect it before changing accounts.', 'account_mismatch')
                refresh = token.get('refresh_token')
                if not refresh and old.get('google_sub') == claims['sub'] and old.get('credentials'):
                    refresh = json.loads(_cipher().decrypt(old['credentials'].encode()))['refresh_token']
                if not refresh:
                    raise CalendarError('Google did not grant background access. Please connect again.', 'refresh_missing')
                credentials = _cipher().encrypt(json.dumps({'refresh_token': refresh}).encode()).decode()
                payload = {'uid': uid, 'google_sub': claims['sub'], 'email': claims['email'],
                           'credentials': credentials, 'status': 'pending', 'error_code': '', 'message': 'Adding your study sessions…',
                           'created_at': old.get('created_at', time.time()), 'calendar_name': 'Lecture Processor Study Plan',
                           'connection_id': old.get('connection_id') or secrets.token_hex(16), 'epoch': secrets.token_hex(16), **record['settings']}
                def install(current):
                    if (current.get('epoch', '') != record.get('expected_epoch', '')
                            or current.get('connection_id', '') != record.get('expected_connection_id', '')
                            or current.get('status') == 'disconnecting'):
                        raise CalendarError('Calendar connection changed. Please connect again.', 'connection_changed')
                    return {**current, **payload}, None
                _atomic(ctx, CONNECTIONS, uid, install, account_uid=uid)
                mark_dirty(ctx, uid)
                outcome = 'connected'
        except (CalendarError, lifecycle.AccountUnavailableError, ValueError, GoogleAuthError, requests.RequestException) as error:
            code = error.code if isinstance(error, CalendarError) else 'oauth_error'
            # Store only an allowlisted public error, never Google's response/token data.
            _atomic(ctx, STATES, key, lambda current: ({**current, 'error_code': code} if current else None, None))
            outcome = code
    response = make_response(redirect('/plan?calendar=google&calendar_result=' + outcome))
    response.delete_cookie('lp_calendar_oauth', path='/api/study-plan/calendar/google')
    response.headers['Cache-Control'] = 'no-store'
    response.headers['Referrer-Policy'] = 'no-referrer'
    return response


def _token_request(body):
    response = requests.post('https://oauth2.googleapis.com/token', data={**body,
        'client_id': _env('GOOGLE_CALENDAR_CLIENT_ID'), 'client_secret': _env('GOOGLE_CALENDAR_CLIENT_SECRET')}, timeout=12)
    if response.status_code != 200:
        retry = response.status_code == 429 or response.status_code >= 500
        raise CalendarError('Google access needs to be reconnected.' if not retry else 'Google is temporarily unavailable.',
                            'temporarily_unavailable' if retry else 'invalid_grant', retry=retry)
    return response.json()


def _access_token(connection):
    try:
        secret = json.loads(_cipher().decrypt(connection['credentials'].encode()))
    except Exception:
        raise CalendarError('Reconnect Google Calendar to restore secure access.', 'invalid_grant') from None
    result = _token_request({'grant_type': 'refresh_token', 'refresh_token': secret['refresh_token']})
    if not isinstance(result.get('access_token'), str) or not result['access_token']:
        raise CalendarError('Google returned an incomplete response. Please reconnect.', 'invalid_grant')
    return result['access_token']


def _google(method, path, token, payload=None):
    response = requests.request(method, API + path, headers={'Authorization': 'Bearer ' + token}, json=payload, timeout=12)
    if response.status_code < 300:
        return response.json() if response.content else {}
    if response.status_code in {404, 410}:
        raise CalendarError('The Google calendar or event is no longer available.', 'not_found')
    if response.status_code == 409:
        raise CalendarError('This event already exists.', 'duplicate')
    if response.status_code == 401:
        raise CalendarError('Reconnect Google Calendar.', 'invalid_grant')
    reason = ''
    try:
        reason = response.json().get('error', {}).get('errors', [{}])[0].get('reason', '')
    except (ValueError, AttributeError, IndexError):
        pass
    retry = response.status_code == 429 or response.status_code >= 500 or reason in {'rateLimitExceeded', 'userRateLimitExceeded'}
    try:
        delay = min(3600, int(response.headers.get('Retry-After', 0)))
    except ValueError:
        delay = 0
    raise CalendarError('Google is busy. Your changes are saved and will retry.' if retry else 'Google could not update your study calendar.',
                        ('backend_error' if response.status_code >= 500 else 'rate_limited') if retry else 'google_error', retry=retry, retry_after=delay)


def all_sessions(ctx, uid, start, end):
    """Read the entire bounded calendar horizon, including cancellation tombstones."""
    from lecture_processor.domains.planner import models
    if ctx.db is None:
        records = ctx.repositories.planner.list_planner_sessions_by_uid(None, uid, 100000, start_date=start)
    else:
        query = apply_where(ctx.db.collection('planner_sessions'), 'uid', '==', uid)
        query = apply_where(query, 'date', '>=', start)
        query = apply_where(query, 'date', '<=', end).order_by('date').order_by('time')
        records, cursor = [], None
        while True:
            page = list((query.start_after(cursor) if cursor else query).limit(200).stream())
            records.extend(doc.to_dict() or {} for doc in page)
            if len(page) < 200:
                break
            cursor = page[-1]
    result = []
    for record in records:
        if not start <= str(record.get('date', '')) <= end:
            continue
        safe, error = models.sanitize_session_payload(record, session_id=record.get('id', ''), existing=record,
                                                      now_ts=record.get('updated_at', 0), runtime=ctx)
        if safe and not error:
            result.append(safe)
    return result


def session_start(session, preferences):
    from lecture_processor.services.study_plan_service import _ics_timestamp
    if session.get('starts_at_utc'):
        try:
            value = datetime.fromisoformat(session['starts_at_utc'].replace('Z', '+00:00'))
            if value.tzinfo:
                return value.astimezone(timezone.utc)
        except ValueError:
            pass
    return _ics_timestamp(session['date'], session['time'], session.get('timezone') or preferences['timezone'])


def desired_events(ctx, uid, connection):
    from lecture_processor.services import study_plan_service as plan
    preferences = plan._preferences(ctx, uid)
    today = date.fromisoformat(plan._today_for_timezone(preferences['timezone']))
    start, end = (today - timedelta(days=30)).isoformat(), (today + timedelta(days=365)).isoformat()
    base = str(ctx.PUBLIC_BASE_URL).rstrip('/')
    result = {}
    for session in all_sessions(ctx, uid, start, end):
        if session.get('status') in {'cancelled', 'skipped'}:
            continue
        instant = session_start(session, preferences)
        reminder = int(connection.get('reminder_offset_minutes', 30))
        result['session:' + session['id']] = {
            'summary': session['title'], 'description': session.get('notes') or 'Open your study session in Lecture Processor.',
            'start': {'dateTime': instant.isoformat()},
            'end': {'dateTime': (instant + timedelta(minutes=session['duration'])).isoformat()},
            'source': {'title': 'Open study session', 'url': base + '/plan?view=today'},
            'reminders': {'useDefault': False, 'overrides': [{'method': 'popup', 'minutes': reminder}] if reminder and session['status'] == 'planned' else []},
        }
    if connection.get('include_deadlines', True):
        for raw in ctx.repositories.planner.list_study_goals_by_uid(ctx.db, uid, 10000):
            goal = plan._serialize_goal(raw)
            if goal.get('status') == 'archived' or not start <= goal['exam_date'] <= end:
                continue
            day = date.fromisoformat(goal['exam_date'])
            result['goal:' + goal['goal_id']] = {
                'summary': 'Exam: ' + goal['title'], 'start': {'date': day.isoformat()},
                'end': {'date': (day + timedelta(days=1)).isoformat()},
                'source': {'title': 'Open study plan', 'url': base + '/plan?view=schedule'},
                'reminders': {'useDefault': False},
            }
    return result


def _mappings(ctx, uid):
    if ctx.db is None:
        return {key: dict(value) for (collection, key), value in _MEMORY.items() if collection == EVENTS and value.get('uid') == uid}
    return {doc.id: doc.to_dict() for doc in apply_where(ctx.db.collection(EVENTS), 'uid', '==', uid).stream()}


def _event_id(connection, local_id):
    return hashlib.sha256((connection['connection_id'] + ':' + local_id).encode()).hexdigest()


def _lease(ctx, uid):
    now, nonce = time.time(), secrets.token_hex(16)
    def claim(queue):
        due = queue and queue.get('next_attempt_at', 0) <= now and queue.get('lease_until', 0) <= now
        if not due:
            return None, None
        return {**queue, 'lease_until': now + 120, 'lease': nonce}, {**queue, 'lease': nonce}
    return _atomic(ctx, OUTBOX, uid, claim)


def _finish(ctx, uid, lease, updates):
    def update(queue):
        if queue.get('lease') != lease:
            return None, None
        merged = {**queue, **updates, 'lease_until': 0, 'lease': ''}
        if int(queue.get('generation', 0)) > int(merged.get('completed_generation', 0)) and updates.get('attempts') == 0:
            merged['next_attempt_at'] = 0
        return merged, None
    _atomic(ctx, OUTBOX, uid, update)


def _same_connection(current, expected):
    return bool(current) and current.get('connection_id') == expected.get('connection_id') and current.get('epoch', '') == expected.get('epoch', '')


def _connection_update(ctx, uid, expected, updates):
    def update(current):
        if not _same_connection(current, expected):
            return None, False
        if current.get('status') == 'disconnecting' and 'status' in updates:
            return None, False
        return {**current, **updates}, True
    try:
        return _atomic(ctx, CONNECTIONS, uid, update, account_uid=uid)
    except lifecycle.AccountUnavailableError:
        return False


def _write_mapping(ctx, uid, expected, key, updates):
    """Fence writes after remote calls so deletion/reconnection cannot resurrect state."""
    def permitted(current):
        return _same_connection(current, expected)
    if ctx.db is None:
        with _LOCK:
            if not permitted(_get(ctx, CONNECTIONS, uid)) or not lifecycle.ensure_account_allows_writes(uid, runtime=ctx)[0]:
                return False
            _set(ctx, EVENTS, key, updates)
            return True
    from google.cloud import firestore
    connection_ref = ctx.db.collection(CONNECTIONS).document(uid)
    event_ref = ctx.db.collection(EVENTS).document(key)
    @firestore.transactional
    def commit(transaction):
        lifecycle.require_account_access(uid, runtime=ctx, transaction=transaction)
        snapshot = connection_ref.get(transaction=transaction)
        if not snapshot.exists or not permitted(snapshot.to_dict() or {}):
            return False
        transaction.set(event_ref, updates, merge=True)
        return True
    try:
        return commit(ctx.db.transaction())
    except lifecycle.AccountUnavailableError:
        return False


def _revoke(connection):
    try:
        token = json.loads(_cipher().decrypt(connection['credentials'].encode()))['refresh_token']
        requests.post('https://oauth2.googleapis.com/revoke', data={'token': token}, timeout=8)
    except Exception:
        pass  # Local access is erased even when Google cannot be reached.


def delete_account_connection(ctx, uid):
    connection = _get(ctx, CONNECTIONS, uid)
    if connection:
        # Keep a disconnecting marker while revocation runs: a new OAuth grant
        # must not race revocation of an older token for the same Google grant.
        def fence(current):
            if not _same_connection(current, connection):
                return None, False
            safe = {**current, 'status': 'disconnecting', 'epoch': secrets.token_hex(16), 'remove_synced_events': False}
            safe.pop('credentials', None)
            return safe, True
        if not _atomic(ctx, CONNECTIONS, uid, fence):
            return
        _revoke(connection)
    for key in _mappings(ctx, uid):
        _delete(ctx, EVENTS, key)
    _delete(ctx, CONNECTIONS, uid)
    _delete(ctx, OUTBOX, uid)


def drain_user(ctx, uid, budget_seconds=40):
    queue = _lease(ctx, uid)
    if not queue:
        return {'processed': False}
    lease, generation = queue['lease'], int(queue.get('generation', 0))
    started = time.monotonic()
    connection = _get(ctx, CONNECTIONS, uid)
    if not connection or connection.get('status') in {'disconnected', 'reconnect_required', 'needs_attention'}:
        _finish(ctx, uid, lease, {'completed_generation': generation, 'next_attempt_at': time.time() + 86400})
        return {'processed': False}
    try:
        allowed, _ = lifecycle.ensure_account_allows_writes(uid, runtime=ctx)
        if not allowed:
            # A transient profile/tombstone read failure must not revoke valid consent.
            # The account-deletion workflow performs the actual credential erasure.
            _finish(ctx, uid, lease, {'next_attempt_at': time.time() + 300})
            return {'processed': False, 'status': 'account_unavailable'}
        if connection.get('status') == 'disconnecting' and not connection.get('remove_synced_events', connection.get('remove_calendar', False)):
            delete_account_connection(ctx, uid)
            return {'processed': True, 'disconnected': True}
        token = _access_token(connection)
        refreshed_once = False
        def call_google(method, path, ignored_token, payload=None):
            nonlocal token, refreshed_once
            try:
                return _google(method, path, token, payload)
            except CalendarError as error:
                if error.code != 'invalid_grant' or refreshed_once:
                    raise
                refreshed_once = True
                token = _access_token(connection)
                return _google(method, path, token, payload)
        from urllib.parse import quote
        if connection.get('status') == 'disconnecting':
            for key, mapping in _mappings(ctx, uid).items():
                if mapping.get('deleted') or mapping.get('calendar_id') != connection.get('calendar_id'):
                    continue
                if time.monotonic() - started > budget_seconds:
                    _finish(ctx, uid, lease, {'next_attempt_at': 0})
                    return {'processed': True, 'complete': False}
                if not _same_connection(_get(ctx, CONNECTIONS, uid), connection):
                    _finish(ctx, uid, lease, {'next_attempt_at': 0})
                    return {'processed': False}
                try:
                    call_google('DELETE', '/calendars/' + quote(mapping['calendar_id'], safe='') + '/events/' + mapping['event_id'], token)
                except CalendarError as error:
                    if error.code != 'not_found':
                        raise
                if not _write_mapping(ctx, uid, connection, key, {'deleted': True}):
                    _finish(ctx, uid, lease, {'next_attempt_at': 0})
                    return {'processed': False}
            delete_account_connection(ctx, uid)
            return {'processed': True, 'disconnected': True}
        if not connection.get('calendar_id'):
            if connection.get('creation_state') == 'in_flight':
                raise CalendarError('Calendar setup could not be confirmed. Check Google Calendar for an empty study calendar before trying again.', 'creation_uncertain')
            if not _connection_update(ctx, uid, connection, {'creation_state': 'in_flight'}):
                return {'processed': False}
            try:
                calendar = call_google('POST', '/calendars', token, {'summary': connection['calendar_name'],
                                                               'description': 'Study sessions managed by Lecture Processor. Edit your schedule in Lecture Processor.'})
            except CalendarError as error:
                if error.code in {'invalid_grant', 'google_error', 'rate_limited', 'not_found'}:
                    _connection_update(ctx, uid, connection, {'creation_state': ''})
                    raise
                raise CalendarError('Calendar setup could not be confirmed. Check Google Calendar for an empty study calendar before trying again.', 'creation_uncertain') from None
            except requests.RequestException:
                raise CalendarError('Calendar setup could not be confirmed. Check Google Calendar for an empty study calendar before trying again.', 'creation_uncertain') from None
            connection['calendar_id'] = calendar['id']
            if not _connection_update(ctx, uid, connection, {'calendar_id': calendar['id'], 'creation_state': 'created'}):
                return {'processed': False}
        path = '/calendars/' + quote(connection['calendar_id'], safe='')
        try:
            call_google('GET', path, token)
        except CalendarError as error:
            if error.code == 'not_found':
                raise CalendarError('Your study calendar was removed in Google. Recreate it to resume syncing.', 'calendar_missing') from None
            raise
        if not _connection_update(ctx, uid, connection, {'status': 'syncing', 'message': 'Updating your study calendar…'}):
            _finish(ctx, uid, lease, {'next_attempt_at': 0})
            return {'processed': False}
        desired, mappings = desired_events(ctx, uid, connection), _mappings(ctx, uid)
        complete, changed = True, 0
        for local_id, event in desired.items():
            if time.monotonic() - started > budget_seconds:
                complete = False
                break
            latest = _get(ctx, CONNECTIONS, uid)
            if latest.get('status') == 'disconnecting' or not _same_connection(latest, connection):
                complete = False
                break
            event_id = _event_id(connection, local_id)
            key = uid + '__' + event_id
            digest = hashlib.sha256(json.dumps(event, sort_keys=True).encode()).hexdigest()
            old = mappings.pop(key, {})
            if (old.get('hash') == digest and not old.get('deleted')
                    and old.get('calendar_id') == connection['calendar_id']
                    and old.get('refreshed_at', 0) > time.time() - 21600):
                continue
            if not _write_mapping(ctx, uid, connection, key, {'uid': uid, 'event_id': event_id, 'local_id': local_id, 'calendar_id': connection['calendar_id'], 'hash': '', 'deleted': False, 'pending': True}):
                complete = False
                break
            payload = {**event, 'id': event_id, 'status': 'confirmed', 'extendedProperties': {'private': {'lectureProcessor': connection['connection_id'], 'localId': local_id}}}
            if old:
                try:
                    call_google('PUT', path + '/events/' + event_id, token, payload)
                except CalendarError as error:
                    if error.code != 'not_found':
                        raise
                    old = {}
            if not old:
                try:
                    call_google('POST', path + '/events', token, payload)
                except CalendarError as error:
                    if error.code != 'duplicate':
                        raise
                    call_google('PUT', path + '/events/' + event_id, token, payload)
            if not _write_mapping(ctx, uid, connection, key, {'uid': uid, 'event_id': event_id, 'local_id': local_id, 'hash': digest, 'deleted': False, 'calendar_id': connection['calendar_id'], 'refreshed_at': time.time(), 'pending': False}):
                complete = False
                break
            changed += 1
        if complete:
            for key, mapping in mappings.items():
                if mapping.get('deleted') or mapping.get('calendar_id') != connection['calendar_id']:
                    continue
                if time.monotonic() - started > budget_seconds:
                    complete = False
                    break
                if not _same_connection(_get(ctx, CONNECTIONS, uid), connection) or _get(ctx, CONNECTIONS, uid).get('status') == 'disconnecting':
                    complete = False
                    break
                try:
                    call_google('DELETE', path + '/events/' + mapping['event_id'], token)
                except CalendarError as error:
                    if error.code != 'not_found':
                        raise
                if not _write_mapping(ctx, uid, connection, key, {'deleted': True}):
                    complete = False
                    break
        latest = _get(ctx, CONNECTIONS, uid)
        if latest.get('status') != 'disconnecting':
            _connection_update(ctx, uid, connection, {'status': 'connected' if complete else 'syncing', 'synced_count': len(desired),
                'message': 'Your study calendar is up to date.' if complete else 'Adding your study sessions…', 'error_code': '',
                **({'last_synced_at': time.time()} if complete else {})})
        _finish(ctx, uid, lease, {'completed_generation': generation if complete else int(queue.get('completed_generation', 0)),
                                 'next_attempt_at': time.time() + (21600 if complete else 1), 'attempts': 0})
        return {'processed': True, 'complete': complete, 'changed': changed}
    except (CalendarError, requests.RequestException) as error:
        if not isinstance(error, CalendarError):
            error = CalendarError('Google could not be reached. Your changes will retry.', 'network_error', retry=True)
        attempts = int(queue.get('attempts', 0)) + 1
        status = 'retrying' if error.retry else ('reconnect_required' if error.code == 'invalid_grant' else 'needs_attention')
        if _get(ctx, CONNECTIONS, uid).get('status') == 'disconnecting':
            _connection_update(ctx, uid, connection, {'error_code': error.code, 'message': 'Could not remove the synced events yet. Retry, or disconnect without removing them and remove them in Google Calendar yourself.'})
        else:
            _connection_update(ctx, uid, connection, {'status': status, 'error_code': error.code, 'message': str(error)})
        delay = max(error.retry_after, min(3600, 15 * 2 ** min(attempts, 8))) + secrets.randbelow(15)
        _finish(ctx, uid, lease, {'attempts': attempts, 'next_attempt_at': time.time() + (delay if error.retry else 86400)})
        return {'processed': True, 'status': status}
    except Exception:
        # Always release the lease. Unknown failures must remain recoverable after deploys.
        _finish(ctx, uid, lease, {'next_attempt_at': time.time() + 300})
        raise


def internal_drain(ctx, request):
    expected = _env('CALENDAR_WORKER_SERVICE_ACCOUNT_EMAIL')
    audience = _env('CALENDAR_WORKER_AUDIENCE')
    if not expected or not audience:
        return ctx.jsonify({'error': 'Worker is not configured.'}), 503
    try:
        bearer = request.headers.get('Authorization', '')
        if not bearer.startswith('Bearer '):
            raise ValueError('Missing bearer')
        claims = id_token.verify_oauth2_token(bearer[7:], GoogleRequest(), audience)
        if claims.get('email') != expected or claims.get('email_verified') is not True:
            raise ValueError('Unexpected worker')
    except (ValueError, GoogleAuthError, requests.RequestException):
        return ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = str((request.get_json(silent=True) or {}).get('uid', ''))
    if not uid or '/' in uid or len(uid) > 128:
        return ctx.jsonify({'error': 'Invalid user'}), 400
    return ctx.jsonify(drain_user(ctx, uid))
