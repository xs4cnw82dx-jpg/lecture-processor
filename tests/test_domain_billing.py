from types import SimpleNamespace

from lecture_processor.domains.billing import credits
from lecture_processor.domains.billing import purchases
from lecture_processor.runtime.container import get_runtime


def _paid_checkout_session(
    *,
    session_id='sess_1',
    uid='u1',
    bundle_id='bundle_x',
    price_cents=100,
    currency='eur',
    payment_status='paid',
    status='complete',
    mode='payment',
    firebase_email='u1@example.com',
    **overrides,
):
    session = {
        'id': session_id,
        'mode': mode,
        'status': status,
        'payment_status': payment_status,
        'amount_total': price_cents,
        'currency': currency,
        'livemode': False,
        'metadata': {'uid': uid, 'bundle_id': bundle_id, 'firebase_email': firebase_email},
        'line_items': {
            'data': [
                {
                    'quantity': 1,
                    'amount_total': price_cents,
                    'currency': currency,
                }
            ]
        },
    }
    session.update(overrides)
    return session


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


def _configure_credit_transaction_runtime(runtime, monkeypatch, store):
    class _Increment:
        def __init__(self, amount):
            self.amount = amount

    class _Snapshot:
        def __init__(self, payload):
            self._payload = dict(payload) if payload is not None else None
            self.exists = payload is not None

        def to_dict(self):
            return dict(self._payload or {})

    class _Ref:
        def __init__(self, uid):
            self.uid = uid

        def get(self, transaction=None):
            _ = transaction
            return _Snapshot(store.get(self.uid))

        def update(self, payload):
            current = dict(store.get(self.uid) or {})
            for key, value in dict(payload or {}).items():
                if isinstance(value, _Increment):
                    current[key] = int(current.get(key, 0) or 0) + value.amount
                else:
                    current[key] = value
            store[self.uid] = current

    class _Transaction:
        def update(self, ref, payload):
            ref.update(payload)

    class _DB:
        def transaction(self):
            return _Transaction()

    monkeypatch.setattr(runtime, 'db', _DB())
    monkeypatch.setattr(runtime.firestore, 'Increment', lambda amount: _Increment(amount), raising=False)
    monkeypatch.setattr(runtime.firestore, 'transactional', lambda fn: fn, raising=False)
    monkeypatch.setattr(runtime.users_repo, 'doc_ref', lambda _db, uid: _Ref(uid))
    monkeypatch.setattr(runtime.users_repo, 'get_doc', lambda _db, uid: _Snapshot(store.get(uid)))
    monkeypatch.setattr(runtime.users_repo, 'update_doc', lambda _db, uid, payload: _Ref(uid).update(payload))


def test_unlimited_lecture_deducts_and_refunds_without_changing_finite_balance(app, monkeypatch):
    runtime = get_runtime(app)
    store = {
        'u1': {
            'uid': 'u1',
            'email': 'user@example.com',
            'lecture_credits_standard': 0,
            'lecture_credits_extended': 0,
            'unlimited_credits': {'lecture': True, 'slides': False, 'interview': False},
            'total_processed': 0,
        }
    }
    _configure_credit_transaction_runtime(runtime, monkeypatch, store)

    deducted = credits.deduct_credit('u1', 'lecture_credits_standard', 'lecture_credits_extended', runtime=runtime)
    assert deducted == 'lecture_credits_standard'
    assert store['u1']['lecture_credits_standard'] == 0
    assert store['u1']['total_processed'] == 1

    assert credits.refund_credit('u1', 'lecture_credits_standard', runtime=runtime) is True
    assert store['u1']['lecture_credits_standard'] == 0
    assert store['u1']['total_processed'] == 0


def test_unlimited_slides_extra_charge_and_refund_are_noops_for_balance(app, monkeypatch):
    runtime = get_runtime(app)
    store = {
        'u1': {
            'uid': 'u1',
            'email': 'user@example.com',
            'slides_credits': 0,
            'unlimited_credits': {'lecture': False, 'slides': True, 'interview': False},
            'total_processed': 0,
        }
    }
    _configure_credit_transaction_runtime(runtime, monkeypatch, store)

    assert credits.deduct_slides_credits('u1', 2, runtime=runtime) is True
    assert store['u1']['slides_credits'] == 0
    assert credits.refund_slides_credits('u1', 2, runtime=runtime) is True
    assert store['u1']['slides_credits'] == 0


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

    session = _paid_checkout_session(session_id="sess_1")
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, "already_processed")


def test_save_purchase_record_updates_admin_purchase_rollups(app, monkeypatch):
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
    purchase_writes = []
    rollup_calls = []

    def _set_purchase(_db, purchase_id, payload, merge=True):
        purchase_writes.append((purchase_id, dict(payload), merge))

    monkeypatch.setattr(runtime.purchases_repo, 'set_doc', _set_purchase)
    monkeypatch.setattr(
        purchases.admin_rollups,
        'increment_purchase_rollups',
        lambda payload, runtime=None: rollup_calls.append(dict(payload)),
    )

    purchases.save_purchase_record(
        'u1',
        'bundle_x',
        'sess_direct',
        runtime=runtime,
        payment_status='paid',
        fulfilled_at=2000.0,
        created_at=1000.0,
    )

    assert purchase_writes == [
        (
            'sess_direct',
            {
                'uid': 'u1',
                'bundle_id': 'bundle_x',
                'bundle_name': 'Bundle X',
                'price_cents': 100,
                'currency': 'eur',
                'credits': {'slides_credits': 2},
                'stripe_session_id': 'sess_direct',
                'payment_status': 'paid',
                'created_at': 1000.0,
                'fulfilled_at': 2000.0,
            },
            True,
        )
    ]
    assert rollup_calls == [purchase_writes[0][1]]


def _configure_transactional_purchase_runtime(runtime, monkeypatch, store, fail_on_purchase=False, rollup_calls=None):
    if rollup_calls is None:
        rollup_calls = []

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
    monkeypatch.setattr(
        purchases.admin_rollups,
        'increment_purchase_rollups',
        lambda payload, runtime=None: rollup_calls.append(dict(payload)),
    )
    return rollup_calls


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

    session = _paid_checkout_session(session_id='sess_unpaid', payment_status='unpaid')

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
    rollup_calls = []
    _configure_transactional_purchase_runtime(runtime, monkeypatch, store, rollup_calls=rollup_calls)

    session = _paid_checkout_session(
        session_id='sess_once',
        firebase_email='firebase@example.com',
        customer_email='stripe-customer@example.com',
    )

    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, 'granted')
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, 'already_processed')
    expected_slides_credits = credits.build_default_user_data('u1', 'u1@example.com', runtime=runtime)['slides_credits'] + 2
    assert store['users']['u1']['slides_credits'] == expected_slides_credits
    assert store['users']['u1']['email'] == 'firebase@example.com'
    assert store['purchases']['sess_once']['payment_status'] == 'paid'
    assert len(store['purchases']) == 1
    assert len(rollup_calls) == 1
    assert rollup_calls[0]['stripe_session_id'] == 'sess_once'
    assert rollup_calls[0]['price_cents'] == 100


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

    session = _paid_checkout_session(session_id='sess_blocked')

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

    session = _paid_checkout_session(session_id='sess_fail')

    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (False, 'could_not_grant_credits')
    assert store['users'] == {}
    assert store['purchases'] == {}


def test_process_checkout_session_credits_rejects_amount_mismatch(app, monkeypatch):
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

    session = _paid_checkout_session(session_id='sess_tampered', amount_total=1)

    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (False, 'checkout_amount_mismatch')
    assert called == []


def test_process_checkout_session_credits_requires_expanded_line_items(app, monkeypatch):
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

    session = _paid_checkout_session(session_id='sess_missing_lines', line_items={'data': []})

    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (False, 'missing_checkout_line_items')
    assert called == []
