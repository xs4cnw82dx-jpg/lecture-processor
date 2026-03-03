import app as app_module
import pytest
from types import SimpleNamespace


@pytest.fixture()
def client():
    app_module.app.config["TESTING"] = True
    app_module.jobs.clear()
    with app_module.app.test_client() as test_client:
        yield test_client
    app_module.jobs.clear()


@pytest.fixture(autouse=True)
def disable_sentry(monkeypatch):
    monkeypatch.setattr(app_module, "sentry_sdk", None)


def test_config_endpoint_shape(client, monkeypatch):
    monkeypatch.setattr(app_module, "STRIPE_PUBLISHABLE_KEY", "pk_test_contract")

    response = client.get("/api/config")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["stripe_publishable_key"] == "pk_test_contract"
    assert isinstance(payload.get("bundles"), dict)
    assert "lecture_5" in payload["bundles"]
    assert "interview_3" in payload["bundles"]


def test_checkout_invalid_bundle_returns_400(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "contract-u1", "email": "u@example.com"})
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (True, 0))

    response = client.post("/api/create-checkout-session", json={"bundle_id": "not_real"})

    assert response.status_code == 400
    assert "invalid bundle" in response.get_json()["error"].lower()


def test_status_not_found_contract(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "contract-u2", "email": "u@example.com"})

    response = client.get("/status/job-does-not-exist")

    assert response.status_code == 404
    body = response.get_json()
    assert body.get("job_lost") is True
    assert body.get("retryable") is True
    assert body.get("error_code") == "JOB_TEMPORARILY_UNAVAILABLE"
    assert "temporarily unavailable" in body.get("error", "").lower()


def test_stripe_webhook_requires_secret(client, monkeypatch):
    monkeypatch.setattr(app_module, "STRIPE_WEBHOOK_SECRET", "")

    response = client.post("/api/stripe-webhook", data=b"{}", headers={"Content-Type": "application/json"})

    assert response.status_code == 500
    assert response.get_json().get("error") == "Webhook not configured"


def test_study_pack_get_missing_returns_404(client, monkeypatch):
    class _MissingDoc:
        exists = False

    class _Collection:
        def document(self, _pack_id):
            return self

        def get(self):
            return _MissingDoc()

    class _DB:
        def collection(self, _name):
            return _Collection()

    monkeypatch.setattr(app_module, "db", _DB())
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "contract-u3", "email": "u@example.com"})

    response = client.get("/api/study-packs/missing-pack")

    assert response.status_code == 404
    assert "not found" in response.get_json().get("error", "").lower()


def test_admin_overview_contract_fields(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(app_module, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(app_module, "db", None)

    response = client.get("/api/admin/overview?window=7d")

    assert response.status_code == 200
    data = response.get_json()
    assert "window" in data
    assert "metrics" in data
    assert "recent_jobs" in data
    assert "recent_purchases" in data


def test_admin_route_requires_server_session_cookie(client):
    response = client.get("/admin", follow_redirects=False)
    assert response.status_code in {302, 301}
    assert response.headers.get("Location", "").endswith("/dashboard")


def test_admin_session_login_sets_cookie(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(app_module, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(app_module, "_extract_bearer_token", lambda _request: "id-token")
    monkeypatch.setattr(app_module.auth, "create_session_cookie", lambda _id_token, expires_in: "session-cookie")

    response = client.post("/api/session/login", headers={"Authorization": "Bearer test"})

    assert response.status_code == 200
    assert response.get_json().get("ok") is True
    set_cookie = response.headers.get("Set-Cookie", "")
    assert "lp_admin_session=session-cookie" in set_cookie


def test_status_uses_runtime_job_fallback(client, monkeypatch):
    app_module.jobs.clear()
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u-fallback", "email": "user@example.com"})
    monkeypatch.setattr(
        app_module,
        "load_runtime_job_snapshot",
        lambda _job_id: {
            "job_id": "job-fallback",
            "status": "processing",
            "step": 2,
            "step_description": "Processing",
            "total_steps": 3,
            "mode": "lecture-notes",
            "user_id": "u-fallback",
            "billing_receipt": {"charged": {"lecture_credits_standard": 1}, "refunded": {}},
        },
    )

    response = client.get("/status/job-fallback")

    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "processing"
    assert body["step"] == 2


def test_verify_email_handles_empty_body(client, monkeypatch):
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (True, 0))

    response = client.post("/api/verify-email", data=b"", headers={"Content-Type": "text/plain"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload.get("allowed") is False


def test_processing_averages_error_returns_empty_fallback_without_raw_details(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u", "email": "user@example.com"})

    class _BrokenDB:
        def collection(self, _name):
            raise RuntimeError("firestore internal detail")

    monkeypatch.setattr(app_module, "db", _BrokenDB())

    response = client.get("/api/processing-averages")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload.get("averages") == {}
    assert payload.get("total_jobs") == 0
    assert "error" not in payload


def test_processing_estimate_uses_sanitized_total_mb_and_percentiles(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u", "email": "user@example.com"})

    class _Doc:
        def __init__(self, row):
            self._row = row

        def to_dict(self):
            return dict(self._row)

    durations = [90, 100, 110, 120, 130, 140, 150, 160]
    docs = [
        _Doc({
            "status": "complete",
            "mode": "lecture-notes",
            "duration_seconds": d,
            "study_features": "both",
            "file_size_mb": 55.0,
        })
        for d in durations
    ]
    monkeypatch.setattr(app_module, "safe_query_docs_in_window", lambda *_args, **_kwargs: docs)

    response = client.get("/api/processing-estimate?mode=lecture-notes&study_features=both&total_mb=55.25")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload.get("source") == "strict"
    assert payload.get("sample_count") == 8
    assert payload["range"]["low_seconds"] > 0
    assert payload["range"]["typical_seconds"] >= payload["range"]["low_seconds"]
    assert payload["range"]["high_seconds"] >= payload["range"]["typical_seconds"]


def test_checkout_session_uses_trusted_public_base_url(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "checkout-u1", "email": "u@example.com"})
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(app_module, "PUBLIC_BASE_URL", "https://trusted.example")

    captured = {}

    def _fake_create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(url="https://checkout.stripe.test/session/abc")

    monkeypatch.setattr(app_module.stripe.checkout.Session, "create", _fake_create)

    response = client.post(
        "/api/create-checkout-session",
        json={"bundle_id": "lecture_5"},
        headers={
            "Authorization": "Bearer dev",
            "Host": "attacker.invalid",
        },
    )

    assert response.status_code == 200
    assert response.get_json().get("checkout_url", "").startswith("https://checkout.stripe.test/")
    assert captured.get("success_url", "").startswith("https://trusted.example/dashboard?payment=success")
    assert captured.get("cancel_url") == "https://trusted.example/dashboard?payment=cancelled"


def test_admin_export_sanitizes_formula_like_cells(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(app_module, "is_admin_user", lambda _decoded: True)

    class _Doc:
        def __init__(self, doc_id, payload):
            self.id = doc_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    docs = [
        _Doc(
            "job-1",
            {
                "job_id": "job-1",
                "uid": "u-1",
                "email": "=malicious@example.com",
                "mode": "lecture-notes",
                "source_type": "url",
                "source_url": "+https://evil.example",
                "custom_prompt": "-SUM(1,1)",
                "prompt_template_key": "@template",
                "prompt_source": "custom",
                "status": "complete",
                "credit_deducted": "slides_credits",
                "credit_refund_method": "",
                "credit_refunded": False,
                "error_message": "",
                "started_at": 1,
                "finished_at": 2,
                "duration_seconds": 1,
            },
        )
    ]
    monkeypatch.setattr(app_module, "safe_query_docs_in_window", lambda **_kwargs: docs)

    response = client.get("/api/admin/export?type=jobs&window=7d", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    csv_text = response.get_data(as_text=True)
    assert "'=malicious@example.com" in csv_text
    assert "'+https://evil.example" in csv_text
    assert "'-SUM(1,1)" in csv_text
    assert "'@template" in csv_text


def test_safe_query_docs_in_window_skips_streaming_fallback(monkeypatch):
    monkeypatch.setattr(app_module, "db", object())

    def _raise(*_args, **_kwargs):
        raise RuntimeError("missing index")

    stream_called = {"value": False}

    def _stream(*_args, **_kwargs):
        stream_called["value"] = True
        return []

    monkeypatch.setattr(app_module, "query_docs_in_window", _raise)
    monkeypatch.setattr(app_module.admin_repo, "stream_collection", _stream)

    docs = app_module.safe_query_docs_in_window(
        collection_name="job_logs",
        timestamp_field="finished_at",
        window_start=1,
        window_end=2,
        order_desc=True,
    )

    assert docs == []
    assert stream_called["value"] is False
