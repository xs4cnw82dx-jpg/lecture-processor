import pytest

from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import purchases as billing_purchases
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.services import upload_api_service
from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures("disable_sentry")


def test_checkout_rate_limited_returns_retry_after(allow_account_writes, client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u2", "email": "user@example.com"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: True)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (False, 21))
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post("/api/create-checkout-session", json={"bundle_id": "lecture_5"})

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "21"
    body = response.get_json()
    assert body["retry_after_seconds"] == 21
    assert "too many checkout attempts" in body["error"].lower()
    assert captured == [("checkout", 21)]


def test_checkout_disallowed_email_returns_403(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u2-denied", "email": "blocked@example.invalid"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: False)

    response = client.post("/api/create-checkout-session", json={"bundle_id": "lecture_5"})

    assert response.status_code == 403
    assert response.get_json()["error"] == "Email not allowed"


def test_confirm_checkout_disallowed_email_returns_403(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u2-denied", "email": "blocked@example.invalid"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: False)

    response = client.get("/api/confirm-checkout-session?session_id=sess_123")

    assert response.status_code == 403
    assert response.get_json()["error"] == "Email not allowed"


def test_confirm_checkout_pending_payment_returns_409(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u2", "email": "user@example.com"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: True)
    monkeypatch.setattr(
        core.stripe.checkout.Session,
        "retrieve",
        lambda _session_id, *, expand: {
            "id": "sess_123",
            "payment_status": "unpaid",
            "metadata": {"uid": "u2", "bundle_id": "lecture_5"},
        },
    )
    monkeypatch.setattr(
        billing_purchases,
        "process_checkout_session_credits",
        lambda _session, runtime=None: (False, "pending_payment"),
    )

    response = client.get("/api/confirm-checkout-session?session_id=sess_123")

    assert response.status_code == 409
    assert response.get_json()["status"] == "pending_payment"


def test_purchase_history_errors_return_500(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-pay", "email": "user@example.com"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: True)

    def _raise(*_args, **_kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(core.purchases_repo, "list_by_uid_recent", _raise)

    response = client.get("/api/purchase-history")

    assert response.status_code == 500
    assert "could not load purchase history" in response.get_json()["error"].lower()


def test_purchase_history_disallowed_email_returns_403(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u2-denied", "email": "blocked@example.invalid"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: False)

    response = client.get("/api/purchase-history")

    assert response.status_code == 403
    assert response.get_json()["error"] == "Email not allowed"


def test_billing_receipt_helpers_track_charged_and_refunded_credits():
    job = {"billing_receipt": core.initialize_billing_receipt({"interview_credits_short": 1, "slides_credits": 2})}

    core.add_job_credit_refund(job, "slides_credits", 1)
    core.add_job_credit_refund(job, "interview_credits_short", 1)

    snapshot = core.get_billing_receipt_snapshot(job)
    assert snapshot["charged"] == {"interview_credits_short": 1, "slides_credits": 2}
    assert snapshot["refunded"] == {"slides_credits": 1, "interview_credits_short": 1}


def test_refund_credit_returns_false_when_user_document_is_missing(monkeypatch):
    class _MissingDoc:
        exists = False

    update_called = {"value": False}

    monkeypatch.setattr(core.users_repo, "get_doc", lambda _db, _uid: _MissingDoc())
    monkeypatch.setattr(
        core.users_repo,
        "update_doc",
        lambda _db, _uid, _updates: update_called.__setitem__("value", True),
    )

    refunded = core.refund_credit("missing-u", "lecture_credits_standard")

    assert refunded is False
    assert update_called["value"] is False


def test_refund_slides_credits_returns_false_when_user_document_is_missing(monkeypatch):
    class _MissingDoc:
        exists = False

    update_called = {"value": False}

    monkeypatch.setattr(core.users_repo, "get_doc", lambda _db, _uid: _MissingDoc())
    monkeypatch.setattr(
        core.users_repo,
        "update_doc",
        lambda _db, _uid, _updates: update_called.__setitem__("value", True),
    )

    refunded = core.refund_slides_credits("missing-u", 1)

    assert refunded is False
    assert update_called["value"] is False


def test_tools_refund_fallback_does_not_claim_success_when_slides_refund_fails():
    class _Time:
        def __init__(self):
            self.sleeps = []

        def sleep(self, seconds):
            self.sleeps.append(seconds)

    class _AppCtx:
        def __init__(self):
            self.time = _Time()
            self.refund_credit_calls = 0
            self.refund_slides_calls = 0

        def refund_credit(self, _uid, _credit_type):
            self.refund_credit_calls += 1
            return False

        def refund_slides_credits(self, _uid, _amount):
            self.refund_slides_calls += 1
            return False

    app_ctx = _AppCtx()
    monkeypatch = pytest.MonkeyPatch()
    monkeypatch.setattr(
        billing_credits,
        "refund_credit",
        lambda uid, credit_type, runtime=None: runtime.refund_credit(uid, credit_type),
    )
    monkeypatch.setattr(
        billing_credits,
        "refund_slides_credits",
        lambda uid, amount, runtime=None: runtime.refund_slides_credits(uid, amount),
    )

    try:
        refunded, method = upload_api_service._attempt_credit_refund(
            app_ctx,
            "u-missing",
            "slides_credits",
        )
    finally:
        monkeypatch.undo()

    assert refunded is False
    assert method == ""
    assert app_ctx.refund_credit_calls == 3
    assert app_ctx.refund_slides_calls == 2


def test_status_returns_interview_billing_receipt(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u13", "email": "user@gmail.com"})
    core.jobs["job-interview-receipt"] = {
        "status": "complete",
        "step": 2,
        "step_description": "Complete!",
        "total_steps": 2,
        "mode": "interview",
        "user_id": "u13",
        "result": "Interview transcript output",
        "flashcards": [],
        "test_questions": [],
        "study_features": "none",
        "output_language": "English",
        "interview_features": ["summary", "sections"],
        "interview_features_successful": ["summary"],
        "interview_summary": "Summary content",
        "interview_sections": None,
        "interview_combined": None,
        "transcript": "Raw transcript",
        "billing_receipt": {
            "charged": {"interview_credits_short": 1, "slides_credits": 2},
            "refunded": {"slides_credits": 1},
            "updated_at": 1770000000.0,
        },
    }

    response = client.get("/status/job-interview-receipt", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    body = response.get_json()
    assert body["mode"] == "interview"
    assert body["billing_receipt"]["charged"] == {"interview_credits_short": 1, "slides_credits": 2}
    assert body["billing_receipt"]["refunded"] == {"slides_credits": 1}


def test_create_checkout_requires_auth(client):
    response = client.post("/api/create-checkout-session", json={"bundle_id": "lecture_5"})
    assert response.status_code == 401
