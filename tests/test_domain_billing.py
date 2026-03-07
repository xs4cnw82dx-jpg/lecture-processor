from types import SimpleNamespace

from lecture_processor.domains.billing import credits
from lecture_processor.domains.billing import purchases
from lecture_processor.runtime.container import get_runtime


def test_grant_credits_to_user_updates_expected_credit_fields(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "CREDIT_BUNDLES", {"bundle_x": {"credits": {"slides_credits": 2}}})

    updates = []

    class _Doc:
        exists = True

    class _Ref:
        def get(self):
            return _Doc()

        def update(self, payload):
            updates.append(payload)

        def set(self, _payload):
            updates.append({"set": True})

    monkeypatch.setattr(runtime.users_repo, "doc_ref", lambda _db, _uid: _Ref())
    monkeypatch.setattr(runtime.firestore, "Increment", lambda value: ("inc", value))

    assert credits.grant_credits_to_user("u1", "bundle_x", runtime=runtime) is True
    assert updates == [{"slides_credits": ("inc", 2)}]


def test_refund_credit_handles_missing_document_update(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.users_repo, "get_doc", lambda _db, _uid: SimpleNamespace(exists=True))
    monkeypatch.setattr(runtime.firestore, "Increment", lambda value: ("inc", value))

    def _raise(*_args, **_kwargs):
        raise RuntimeError("No document to update")

    monkeypatch.setattr(runtime.users_repo, "update_doc", _raise)
    assert credits.refund_credit("u1", "slides_credits", runtime=runtime) is False


def test_process_checkout_session_credits_returns_already_processed(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(
        runtime,
        "CREDIT_BUNDLES",
        {
            "bundle_x": {
                "name": "Bundle X",
                "price_cents": 100,
                "currency": "eur",
                "credits": {"slides_credits": 2},
            }
        },
    )
    monkeypatch.setattr(
        purchases,
        "_grant_credits_and_record_purchase_atomic",
        lambda _session, runtime=None: (True, "already_processed"),
    )

    session = {
        "id": "sess_1",
        "status": "complete",
        "payment_status": "paid",
        "metadata": {"uid": "u1", "bundle_id": "bundle_x"},
    }
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, "already_processed")


def _configure_transactional_purchase_runtime(runtime, monkeypatch, store, fail_on_purchase=False):
    class _Snapshot:
        def __init__(self, payload):
            self._payload = dict(payload) if payload is not None else None
            self.exists = payload is not None

        def to_dict(self):
            return dict(self._payload or {})

    class _Ref:
        def __init__(self, collection_name, doc_id):
            self.collection_name = collection_name
            self.doc_id = doc_id
            self.id = doc_id

        def get(self, transaction=None):
            _ = transaction
            return _Snapshot(store[self.collection_name].get(self.doc_id))

        def set(self, payload, merge=False):
            existing = dict(store[self.collection_name].get(self.doc_id) or {})
            store[self.collection_name][self.doc_id] = dict(existing, **payload) if merge else dict(payload)

    class _Transaction:
        def __init__(self):
            self._pending = []

        def set(self, ref, payload, merge=False):
            if fail_on_purchase and ref.collection_name == 'purchases':
                raise RuntimeError('purchase write failed')
            self._pending.append((ref, dict(payload), merge))

        def commit(self):
            for ref, payload, merge in self._pending:
                existing = dict(store[ref.collection_name].get(ref.doc_id) or {})
                store[ref.collection_name][ref.doc_id] = dict(existing, **payload) if merge else dict(payload)

    class _DB:
        def transaction(self):
            return _Transaction()

    def _transactional(fn):
        def _wrapped(transaction, *args, **kwargs):
            result = fn(transaction, *args, **kwargs)
            transaction.commit()
            return result
        return _wrapped

    monkeypatch.setattr(runtime, 'db', _DB())
    monkeypatch.setattr(runtime.firestore, 'transactional', _transactional, raising=False)
    monkeypatch.setattr(runtime.users_repo, 'doc_ref', lambda _db, uid: _Ref('users', uid))
    monkeypatch.setattr(runtime.purchases_repo, 'doc_ref', lambda _db, session_id: _Ref('purchases', session_id))
    monkeypatch.setattr(purchases.analytics_events, 'log_analytics_event', lambda *_args, **_kwargs: True)


def test_process_checkout_session_credits_rejects_unpaid_session(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(
        runtime,
        'CREDIT_BUNDLES',
        {
            'bundle_x': {
                'name': 'Bundle X',
                'price_cents': 100,
                'currency': 'eur',
                'credits': {'slides_credits': 2},
            }
        },
    )
    called = []
    monkeypatch.setattr(
        purchases,
        '_grant_credits_and_record_purchase_atomic',
        lambda *_args, **_kwargs: called.append(True) or (True, 'granted'),
    )

    session = {
        'id': 'sess_unpaid',
        'status': 'complete',
        'payment_status': 'unpaid',
        'metadata': {'uid': 'u1', 'bundle_id': 'bundle_x'},
    }

    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (False, 'pending_payment')
    assert called == []


def test_process_checkout_session_credits_is_idempotent_in_transaction(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(
        runtime,
        'CREDIT_BUNDLES',
        {
            'bundle_x': {
                'name': 'Bundle X',
                'price_cents': 100,
                'currency': 'eur',
                'credits': {'slides_credits': 2},
            }
        },
    )
    store = {'users': {}, 'purchases': {}}
    _configure_transactional_purchase_runtime(runtime, monkeypatch, store)

    session = {
        'id': 'sess_once',
        'status': 'complete',
        'payment_status': 'paid',
        'metadata': {'uid': 'u1', 'bundle_id': 'bundle_x'},
        'customer_email': 'u1@example.com',
    }

    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, 'granted')
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, 'already_processed')
    expected_slides_credits = credits.build_default_user_data('u1', 'u1@example.com', runtime=runtime)['slides_credits'] + 2
    assert store['users']['u1']['slides_credits'] == expected_slides_credits
    assert store['purchases']['sess_once']['payment_status'] == 'paid'
    assert len(store['purchases']) == 1


def test_process_checkout_session_credits_blocks_deleting_account(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(
        runtime,
        'CREDIT_BUNDLES',
        {
            'bundle_x': {
                'name': 'Bundle X',
                'price_cents': 100,
                'currency': 'eur',
                'credits': {'slides_credits': 2},
            }
        },
    )
    store = {
        'users': {
            'u1': {
                'uid': 'u1',
                'email': 'u1@example.com',
                'account_status': 'deleting',
                'slides_credits': 0,
            }
        },
        'purchases': {},
    }
    _configure_transactional_purchase_runtime(runtime, monkeypatch, store)

    session = {
        'id': 'sess_blocked',
        'status': 'complete',
        'payment_status': 'paid',
        'metadata': {'uid': 'u1', 'bundle_id': 'bundle_x'},
    }

    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (False, 'account_deletion_in_progress')
    assert store['users']['u1']['slides_credits'] == 0
    assert store['purchases'] == {}


def test_atomic_purchase_failure_does_not_partially_grant_credits(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(
        runtime,
        'CREDIT_BUNDLES',
        {
            'bundle_x': {
                'name': 'Bundle X',
                'price_cents': 100,
                'currency': 'eur',
                'credits': {'slides_credits': 2},
            }
        },
    )
    store = {'users': {}, 'purchases': {}}
    _configure_transactional_purchase_runtime(runtime, monkeypatch, store, fail_on_purchase=True)

    session = {
        'id': 'sess_fail',
        'status': 'complete',
        'payment_status': 'paid',
        'metadata': {'uid': 'u1', 'bundle_id': 'bundle_x'},
        'customer_email': 'u1@example.com',
    }

    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (False, 'could_not_grant_credits')
    assert store['users'] == {}
    assert store['purchases'] == {}
