from lecture_processor.domains.ai import batch_orchestrator
from tests.runtime_test_support import get_test_core
from tests.credit_test_support import make_credit_runtime
from types import SimpleNamespace

core = get_test_core()


class _FakeUuid:
    hex = 'grant1'

    def __str__(self):
        return 'grant-1'


def _patch_admin_credit_runtime(monkeypatch, store, *, admin=True):
    runtime, credit_store = make_credit_runtime(
        users=store['users'],
        documents={('admin_credit_grants', key): value for key, value in store['admin_credit_grants'].items()},
        unified_enabled=False,
    )

    def publish_committed_state(_operations):
        for collection in store:
            store[collection].clear()
            store[collection].update(credit_store.docs(collection))

    credit_store.after_commit = publish_committed_state
    monkeypatch.setattr(core, 'run_startup_recovery_once', lambda: None)
    monkeypatch.setattr(batch_orchestrator, 'run_startup_batch_recovery_once', lambda runtime=None: None)
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'admin-u', 'email': 'admin@example.com'})
    monkeypatch.setattr(core, 'is_admin_user', lambda _decoded: admin)
    monkeypatch.setattr(core, 'UNIFIED_CREDITS_ENABLED', False, raising=False)
    monkeypatch.setattr(core, 'db', runtime.db)
    monkeypatch.setattr(core.firestore, 'Increment', runtime.firestore.Increment, raising=False)
    monkeypatch.setattr(core.firestore, 'transactional', credit_store.transactional, raising=False)
    monkeypatch.setattr(core.firestore, 'Query', SimpleNamespace(DESCENDING='DESCENDING'), raising=False)
    monkeypatch.setattr(core.uuid, 'uuid4', lambda: _FakeUuid())
    monkeypatch.setattr(core.time, 'time', lambda: 1234.0)


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
