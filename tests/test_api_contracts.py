import app as app_module
import pytest


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
    assert "job not found" in body.get("error", "").lower()


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
