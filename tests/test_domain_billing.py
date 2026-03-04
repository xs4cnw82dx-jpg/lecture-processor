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
    monkeypatch.setattr(runtime, "CREDIT_BUNDLES", {"bundle_x": {"price_cents": 100}})
    monkeypatch.setattr(
        purchases,
        "purchase_record_exists_for_session",
        lambda _session_id, runtime=None: True,
    )

    session = {
        "id": "sess_1",
        "status": "complete",
        "payment_status": "paid",
        "metadata": {"uid": "u1", "bundle_id": "bundle_x"},
    }
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, "already_processed")
