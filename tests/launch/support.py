from tests.credit_test_support import make_credit_runtime
from tests.runtime_test_support import get_test_core

core = get_test_core()


def _install_dispatch_credit_store(monkeypatch, uid, user):
    runtime, store = make_credit_runtime(users={uid: {
        'uid': uid, 'account_status': 'active', 'total_processed': 0, **user,
    }}, unified_enabled=False)
    monkeypatch.setattr(core, 'db', runtime.db)
    monkeypatch.setattr(core, 'UNIFIED_CREDITS_ENABLED', False)
    monkeypatch.setattr(core.firestore, 'transactional', runtime.firestore.transactional)
    monkeypatch.setattr(core.firestore, 'Increment', runtime.firestore.Increment)
    monkeypatch.setattr(core, 'get_or_create_user', lambda requested_uid, _email: store.docs('users')[requested_uid])
    store.queued = []
    monkeypatch.setattr(core, 'submit_background_job', lambda target, *args, **kwargs: store.queued.append((target, args, kwargs)))
    return store
