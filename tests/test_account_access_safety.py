"""Deleted-account requests and initialization stay blocked without live services."""

from copy import deepcopy
from types import SimpleNamespace

import pytest

from lecture_processor.domains.account import lifecycle, users
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.services import access_service


class _Database:
    def __init__(self):
        self.data = {}
        self.failed_collection = ''
        self.reads = []
        self.writes = []

    def collection(self, name):
        return SimpleNamespace(document=lambda uid: _Reference(self, (name, uid)))

    def transaction(self):
        return _Transaction(self)


class _Reference:
    def __init__(self, db, key):
        self.db, self.key = db, key

    def get(self, transaction=None):
        self.db.reads.append((self.key, transaction))
        if self.key[0] == self.db.failed_collection:
            raise RuntimeError('Database temporarily unavailable')
        payload = deepcopy(self.db.data.get(self.key))
        return SimpleNamespace(exists=payload is not None, to_dict=lambda: deepcopy(payload))


class _Transaction:
    def __init__(self, db):
        self.db = db

    def set(self, ref, payload):
        self.db.writes.append(ref.key)
        self.db.data[ref.key] = deepcopy(payload)

    def update(self, ref, payload):
        assert ref.key in self.db.data
        self.db.writes.append(ref.key)
        self.db.data[ref.key].update(deepcopy(payload))


@pytest.fixture
def account_runtime(runtime, monkeypatch):
    db = _Database()
    monkeypatch.setattr(runtime.core, 'db', db)
    monkeypatch.setattr(runtime.firestore, 'transactional', lambda operation: operation)
    monkeypatch.setattr(auth_policy, 'is_email_allowed', lambda _email, runtime=None: True)
    checks = []

    def verify(_token, check_revoked=False):
        checks.append(check_revoked)
        return {'uid': 'u1', 'email': 'student@example.com', 'email_verified': True, 'auth_time': runtime.time.time()}

    monkeypatch.setattr(runtime.auth, 'verify_id_token', verify)
    return runtime, db, checks


def _request():
    return SimpleNamespace(headers={'Authorization': 'Bearer old-but-unexpired-token'}, environ={})


@pytest.mark.parametrize('phase', ['requested', 'purging', 'retry_required', 'auth_delete_pending', 'auth_deleted', 'deleted'])
def test_deletion_tombstone_blocks_tokens_profiles_and_writes(account_runtime, phase):
    runtime, db, _ = account_runtime
    db.data[('account_deletions', 'u1')] = {'status': phase}

    assert runtime.verify_firebase_token(_request()) is None
    assert lifecycle.ensure_account_allows_writes('u1', runtime=runtime)[0] is False
    with pytest.raises(lifecycle.AccountUnavailableError):
        users.get_or_create_user('u1', 'student@example.com', runtime=runtime)
    assert ('users', 'u1') not in db.data
    assert db.writes == []


@pytest.mark.parametrize('method,path', [
    ('get', '/api/auth/user'),
    ('get', '/api/books'),
    ('get', '/api/study-packs'),
    ('post', '/api/study-packs/pack/images'),
    ('post', '/api/tools/extract'),
    ('post', '/api/tools/transcribe'),
    ('get', '/api/batch/jobs'),
    ('post', '/api/batch/jobs'),
    ('get', '/api/study-plan'),
    ('put', '/api/planner/settings'),
    ('post', '/api/create-checkout-session'),
])
def test_deleted_account_is_rejected_across_protected_api_families(client, account_runtime, method, path):
    _, db, _ = account_runtime
    db.data[('account_deletions', 'u1')] = {'status': 'deleted'}

    response = getattr(client, method)(path, json={}, headers=_request().headers)

    assert response.status_code == 401
    assert 'deleted' not in response.get_data(as_text=True).lower()
    assert db.writes == []


@pytest.mark.parametrize('cancelled', [False, True])
def test_legitimate_signup_and_cancelled_deletion_can_initialize_profile(account_runtime, cancelled):
    runtime, db, _ = account_runtime
    if cancelled:
        db.data[('account_deletions', 'u1')] = {'status': 'cancelled'}
    assert runtime.verify_firebase_token(_request())['uid'] == 'u1'

    profile = users.get_or_create_user('u1', 'student@example.com', runtime=runtime)

    assert profile['account_status'] == 'active'
    assert profile['lecture_credits_standard'] == 1
    assert profile['slides_credits'] == 2
    assert db.data[('users', 'u1')] == profile
    transactional_reads = [(key, txn) for key, txn in db.reads if txn is not None]
    assert [key for key, _ in transactional_reads] == [('account_deletions', 'u1'), ('users', 'u1')]
    assert transactional_reads[0][1] is transactional_reads[1][1]


def test_profile_guard_catches_deletion_started_after_token_verification(account_runtime):
    runtime, db, _ = account_runtime
    assert runtime.verify_firebase_token(_request())['uid'] == 'u1'
    db.data[('account_deletions', 'u1')] = {'status': 'deleted'}

    with pytest.raises(lifecycle.AccountUnavailableError):
        users.get_or_create_user('u1', 'student@example.com', runtime=runtime)
    assert runtime.verify_firebase_token(_request()) is None
    assert db.writes == []


def test_existing_deleting_profile_cannot_be_normalized_without_tombstone(account_runtime):
    runtime, db, _ = account_runtime
    original = {'uid': 'u1', 'account_status': 'deleting', 'email': 'original@example.com'}
    db.data[('users', 'u1')] = dict(original)

    with pytest.raises(lifecycle.AccountUnavailableError):
        users.get_or_create_user('u1', 'changed@example.com', runtime=runtime)
    assert lifecycle.ensure_account_allows_writes('u1', runtime=runtime)[0] is False
    assert db.data[('users', 'u1')] == original
    assert db.writes == []


@pytest.mark.parametrize('profile', [None, {'uid': 'u1', 'account_status': 'active'}])
def test_tombstone_read_failure_cannot_authorize_or_create_or_normalize_profile(account_runtime, profile):
    runtime, db, _ = account_runtime
    if profile is not None:
        db.data[('users', 'u1')] = deepcopy(profile)
    db.failed_collection = 'account_deletions'

    assert runtime.verify_firebase_token(_request()) is None
    assert lifecycle.ensure_account_allows_writes('u1', runtime=runtime)[0] is False
    with pytest.raises(lifecycle.AccountUnavailableError):
        users.get_or_create_user('u1', 'student@example.com', runtime=runtime)
    assert db.data.get(('users', 'u1')) == profile
    assert db.writes == []


def test_profile_read_failure_blocks_writes(account_runtime):
    runtime, db, _ = account_runtime
    db.failed_collection = 'users'
    allowed, message = lifecycle.ensure_account_allows_writes('u1', runtime=runtime)
    assert allowed is False
    assert 'could not be verified' in message


def test_missing_database_blocks_account_access(account_runtime, monkeypatch):
    runtime, _, _ = account_runtime
    monkeypatch.setattr(runtime.core, 'db', None)
    assert runtime.verify_firebase_token(_request()) is None
    assert lifecycle.ensure_account_allows_writes('u1', runtime=runtime)[0] is False


@pytest.mark.parametrize('phase,allowed', [('requested', True), ('retry_required', True), ('auth_deleted', False), ('deleted', False)])
def test_only_live_recent_authentication_can_resume_unfinished_deletion(account_runtime, phase, allowed):
    runtime, db, checks = account_runtime
    db.data[('account_deletions', 'u1')] = {'status': phase}
    assert runtime.verify_firebase_token(_request(), allow_deleting_account=True) is None
    with runtime.app.app_context():
        decoded, _, status = access_service.require_recent_allowed_user(
            runtime, _request(), allow_deleting_account=True,
        )
    assert bool(decoded) is allowed
    assert status == (None if allowed else 401)
    assert checks == [False, True]


def test_deletion_endpoint_can_retry_but_ordinary_account_endpoint_cannot(client, account_runtime):
    _, db, checks = account_runtime
    db.data[('account_deletions', 'u1')] = {'status': 'retry_required'}
    assert client.get('/api/auth/user', headers=_request().headers).status_code == 401
    # Invalid confirmation stops before deletion writes while proving the live
    # account can reach the retry handler through its dedicated auth exception.
    result = client.post('/api/account/delete', json={}, headers=_request().headers)
    assert result.status_code == 400
    assert 'confirmation' in result.get_json()['error'].lower()
    assert checks == [False, True]
    assert db.writes == []
