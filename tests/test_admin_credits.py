from lecture_processor.domains.ai import batch_orchestrator
from tests.runtime_test_support import get_test_core

core = get_test_core()


class _Increment:
    def __init__(self, amount):
        self.amount = amount


class _Snapshot:
    def __init__(self, doc_id, payload):
        self.id = doc_id
        self._payload = dict(payload) if payload is not None else None
        self.exists = payload is not None

    def to_dict(self):
        return dict(self._payload or {})


class _FakeUuid:
    hex = 'grant1'

    def __str__(self):
        return 'grant-1'


class _Doc:
    def __init__(self, doc_id, payload):
        self.id = doc_id
        self._payload = dict(payload)

    def to_dict(self):
        return dict(self._payload)


class _Ref:
    def __init__(self, store, collection_name, doc_id):
        self._store = store
        self.collection_name = collection_name
        self.id = doc_id

    def get(self, transaction=None):
        _ = transaction
        return _Snapshot(self.id, self._store[self.collection_name].get(self.id))

    def update(self, payload):
        current = dict(self._store[self.collection_name].get(self.id) or {})
        for key, value in dict(payload or {}).items():
            target = current
            parts = str(key).split('.')
            for part in parts[:-1]:
                target = target.setdefault(part, {})
            if isinstance(value, _Increment):
                target[parts[-1]] = int(target.get(parts[-1], 0) or 0) + value.amount
            else:
                target[parts[-1]] = value
        self._store[self.collection_name][self.id] = current

    def set(self, payload, merge=False):
        existing = dict(self._store[self.collection_name].get(self.id) or {}) if merge else {}
        self._store[self.collection_name][self.id] = dict(existing, **dict(payload or {}))


class _Transaction:
    def __init__(self):
        self._writes = []

    def update(self, ref, payload):
        self._writes.append(('update', ref, payload, False))

    def set(self, ref, payload, merge=False):
        self._writes.append(('set', ref, payload, merge))

    def commit(self):
        for action, ref, payload, merge in self._writes:
            if action == 'update':
                ref.update(payload)
            else:
                ref.set(payload, merge=merge)


class _DB:
    def transaction(self):
        return _Transaction()

    def batch(self):
        return _Transaction()


def _patch_admin_credit_runtime(monkeypatch, store, *, admin=True):
    monkeypatch.setattr(core, 'run_startup_recovery_once', lambda: None)
    monkeypatch.setattr(batch_orchestrator, 'run_startup_batch_recovery_once', lambda runtime=None: None)
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'admin-u', 'email': 'admin@example.com'})
    monkeypatch.setattr(core, 'is_admin_user', lambda _decoded: admin)
    monkeypatch.setattr(core, 'db', _DB())
    monkeypatch.setattr(core.firestore, 'Increment', lambda amount: _Increment(amount), raising=False)
    monkeypatch.setattr(core.firestore, 'transactional', lambda fn: fn, raising=False)
    monkeypatch.setattr(core.uuid, 'uuid4', lambda: _FakeUuid())
    monkeypatch.setattr(core.time, 'time', lambda: 1234.0)
    monkeypatch.setattr(core.users_repo, 'doc_ref', lambda _db, uid: _Ref(store, 'users', uid))
    monkeypatch.setattr(
        core.users_repo,
        'query_by_email_normalized',
        lambda _db, email, limit=5: [
            _Doc(uid, payload)
            for uid, payload in store['users'].items()
            if str(payload.get('email_normalized', '')).lower() == email
        ][:limit],
    )
    monkeypatch.setattr(
        core.users_repo,
        'query_by_email',
        lambda _db, email, limit=5: [
            _Doc(uid, payload)
            for uid, payload in store['users'].items()
            if str(payload.get('email', '')) == email
        ][:limit],
    )
    monkeypatch.setattr(core.admin_credit_grants_repo, 'doc_ref', lambda _db, grant_id: _Ref(store, 'admin_credit_grants', grant_id))
    monkeypatch.setattr(
        core.admin_credit_grants_repo,
        'list_by_email_recent',
        lambda _db, email, limit=20, firestore_module=None: [
            _Doc(grant_id, payload)
            for grant_id, payload in sorted(
                store['admin_credit_grants'].items(),
                key=lambda item: item[1].get('created_at', 0),
                reverse=True,
            )
            if payload.get('email_normalized') == email
        ][:limit],
    )
    monkeypatch.setattr(
        core.admin_credit_grants_repo,
        'list_recent',
        lambda _db, limit=20, firestore_module=None: [
            _Doc(grant_id, payload)
            for grant_id, payload in sorted(
                store['admin_credit_grants'].items(),
                key=lambda item: item[1].get('created_at', 0),
                reverse=True,
            )
        ][:limit],
    )


def _store():
    return {
        'users': {
            'u1': {
                'uid': 'u1',
                'email': 'target@example.com',
                'email_normalized': 'target@example.com',
                'lecture_credits_standard': 1,
                'lecture_credits_extended': 0,
                'slides_credits': 2,
                'interview_credits_short': 3,
                'interview_credits_medium': 0,
                'interview_credits_long': 0,
                'unlimited_credits': {'lecture': False, 'slides': False, 'interview': False},
                'account_status': 'active',
            }
        },
        'admin_credit_grants': {},
    }


def test_admin_user_search_finds_existing_user_by_normalized_email(client, monkeypatch):
    store = _store()
    _patch_admin_credit_runtime(monkeypatch, store)

    response = client.get('/api/admin/users/search?email=TARGET@example.com')

    assert response.status_code == 200
    body = response.get_json()
    assert body['user']['uid'] == 'u1'
    assert body['user']['credits'] == {'lecture': 1, 'slides': 2, 'interview': 3}
    assert body['user']['effective_unlimited'] == {'lecture': False, 'slides': False, 'interview': False}


def test_admin_credit_grant_increments_category_fields_and_writes_zero_euro_ledger(client, monkeypatch):
    store = _store()
    _patch_admin_credit_runtime(monkeypatch, store)

    response = client.post(
        '/api/admin/users/u1/credits/grant',
        json={'credits': {'lecture': 2, 'slides': 4, 'interview': 1}, 'note': 'Launch support'},
    )

    assert response.status_code == 200
    assert store['users']['u1']['lecture_credits_standard'] == 3
    assert store['users']['u1']['slides_credits'] == 6
    assert store['users']['u1']['interview_credits_short'] == 4
    grant = store['admin_credit_grants']['grant-1']
    assert grant['price_cents'] == 0
    assert grant['source'] == 'admin'
    assert grant['credit_categories'] == {'lecture': 2, 'slides': 4, 'interview': 1}
    assert grant['note'] == 'Launch support'


def test_admin_unlimited_update_sets_category_flags_and_ledger(client, monkeypatch):
    store = _store()
    _patch_admin_credit_runtime(monkeypatch, store)

    response = client.patch(
        '/api/admin/users/u1/credits/unlimited',
        json={'unlimited': {'lecture': True, 'slides': False, 'interview': True}, 'note': 'Manual override'},
    )

    assert response.status_code == 200
    assert store['users']['u1']['unlimited_credits'] == {'lecture': True, 'slides': False, 'interview': True}
    body = response.get_json()
    assert body['user']['effective_unlimited'] == {'lecture': True, 'slides': False, 'interview': True}
    grant = store['admin_credit_grants']['grant-1']
    assert grant['action'] == 'set_unlimited'
    assert grant['price_cents'] == 0
    assert grant['unlimited_after'] == {'lecture': True, 'slides': False, 'interview': True}


def test_configured_admin_user_is_effectively_unlimited(client, monkeypatch):
    store = _store()
    store['users']['u1']['email'] = 'ijacco2004@gmail.com'
    store['users']['u1']['email_normalized'] = 'ijacco2004@gmail.com'
    monkeypatch.setattr(core, 'ADMIN_EMAILS', {'ijacco2004@gmail.com'})
    _patch_admin_credit_runtime(monkeypatch, store)

    response = client.get('/api/admin/users/search?email=ijacco2004@gmail.com')

    assert response.status_code == 200
    body = response.get_json()
    assert body['user']['is_configured_admin'] is True
    assert body['user']['effective_unlimited'] == {'lecture': True, 'slides': True, 'interview': True}


def test_admin_credit_api_requires_admin(client, monkeypatch):
    store = _store()
    _patch_admin_credit_runtime(monkeypatch, store, admin=False)

    response = client.get('/api/admin/users/search?email=target@example.com')

    assert response.status_code == 403
