import io
import json

import pytest

import app as app_module


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


def test_verify_email_allows_student_domain(client):
    response = client.post("/api/verify-email", json={"email": "student@st.hanze.nl"})
    assert response.status_code == 200
    body = response.get_json()
    assert body["allowed"] is True


def test_verify_email_blocks_unknown_domain(client):
    response = client.post("/api/verify-email", json={"email": "x@unknown-domain.invalid"})
    assert response.status_code == 200
    body = response.get_json()
    assert body["allowed"] is False
    assert "university email" in body["message"].lower()


def test_analytics_rate_limited_returns_retry_after(client, monkeypatch):
    captured = []
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u1", "email": "user@example.com"})
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (False, 12))
    monkeypatch.setattr(app_module, "log_rate_limit_hit", lambda name, retry: captured.append((name, retry)) or True)

    response = client.post("/api/lp-event", json={"event": "auth_success", "session_id": "manualtest123"})

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "12"
    body = response.get_json()
    assert body["retry_after_seconds"] == 12
    assert "too many analytics events" in body["error"].lower()
    assert captured == [("analytics", 12)]


def test_checkout_rate_limited_returns_retry_after(client, monkeypatch):
    captured = []
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u2", "email": "user@example.com"})
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (False, 21))
    monkeypatch.setattr(app_module, "log_rate_limit_hit", lambda name, retry: captured.append((name, retry)) or True)

    response = client.post("/api/create-checkout-session", json={"bundle_id": "lecture_5"})

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "21"
    body = response.get_json()
    assert body["retry_after_seconds"] == 21
    assert "too many checkout attempts" in body["error"].lower()
    assert captured == [("checkout", 21)]


def test_upload_active_jobs_returns_429(client, monkeypatch):
    captured = []
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u3", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(app_module, "count_active_jobs_for_user", lambda _uid: 2)
    monkeypatch.setattr(app_module, "log_rate_limit_hit", lambda name, retry: captured.append((name, retry)) or True)

    response = client.post("/upload", data={"mode": "lecture-notes"})

    assert response.status_code == 429
    body = response.get_json()
    assert "active processing job" in body["error"].lower()
    assert captured == [("upload", 10)]


def test_upload_rate_limited_returns_retry_after(client, monkeypatch):
    captured = []
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u4", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(app_module, "count_active_jobs_for_user", lambda _uid: 0)
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (False, 33))
    monkeypatch.setattr(app_module, "log_rate_limit_hit", lambda name, retry: captured.append((name, retry)) or True)

    response = client.post("/upload", data={"mode": "lecture-notes"})

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "33"
    body = response.get_json()
    assert body["retry_after_seconds"] == 33
    assert "too many upload attempts" in body["error"].lower()
    assert captured == [("upload", 33)]


def test_upload_invalid_audio_content_type_rejected(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u5", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(app_module, "count_active_jobs_for_user", lambda _uid: 0)
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(
        app_module,
        "get_or_create_user",
        lambda _uid, _email: {"lecture_credits_standard": 1, "lecture_credits_extended": 0},
    )

    response = client.post(
        "/upload",
        data={
            "mode": "lecture-notes",
            "pdf": (io.BytesIO(b"%PDF-1.4\n1 0 obj"), "slides.pdf", "application/pdf"),
            "audio": (io.BytesIO(b"not-audio"), "audio.mp3", "text/plain"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    body = response.get_json()
    assert body["error"] == "Invalid audio content type"


def test_account_export_requires_auth(client):
    response = client.get("/api/account/export")
    assert response.status_code == 401
    assert response.get_json()["error"] == "Unauthorized"


def test_account_export_returns_json_attachment(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u6", "email": "user@gmail.com"})
    monkeypatch.setattr(
        app_module,
        "collect_user_export_payload",
        lambda uid, email: {"meta": {"uid": uid, "email": email}, "collections": {}},
    )

    response = client.get("/api/account/export", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    assert response.mimetype == "application/json"
    content_disposition = response.headers.get("Content-Disposition", "")
    assert "attachment;" in content_disposition
    assert "lecture-processor-account-export-" in content_disposition
    parsed = json.loads(response.data.decode("utf-8"))
    assert parsed["meta"]["uid"] == "u6"


def test_account_delete_rejects_bad_confirmation_text(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u7", "email": "user@gmail.com"})

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "nope", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "invalid confirmation text" in response.get_json()["error"].lower()


def test_account_delete_rejects_when_active_jobs_exist(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u8", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "count_active_jobs_for_user", lambda _uid: 1)

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "DELETE MY ACCOUNT", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 409
    assert "cannot delete account while 1 processing job" in response.get_json()["error"].lower()


def test_account_delete_success_path_returns_ok(client, monkeypatch):
    class _FakeDocRef:
        def delete(self):
            return None

    class _FakeCollection:
        def __init__(self, name):
            self.name = name

        def where(self, *_args, **_kwargs):
            return self

        def limit(self, *_args, **_kwargs):
            return self

        def stream(self):
            return []

        def document(self, _doc_id):
            return _FakeDocRef()

    class _FakeDB:
        def collection(self, name):
            return _FakeCollection(name)

    class _FakeProgressDoc:
        def delete(self):
            return None

    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u9", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "count_active_jobs_for_user", lambda _uid: 0)
    monkeypatch.setattr(app_module, "list_docs_by_uid", lambda *_args, **_kwargs: ([], False))
    monkeypatch.setattr(app_module, "delete_docs_by_uid", lambda *_args, **_kwargs: (0, False))
    monkeypatch.setattr(app_module, "anonymize_purchase_docs_by_uid", lambda *_args, **_kwargs: (0, False))
    monkeypatch.setattr(app_module, "remove_upload_artifacts_for_job_ids", lambda _job_ids: 0)
    monkeypatch.setattr(app_module, "get_study_progress_doc", lambda _uid: _FakeProgressDoc())
    monkeypatch.setattr(app_module, "get_study_card_state_doc", lambda _uid, _pack_id: _FakeProgressDoc())
    monkeypatch.setattr(app_module, "db", _FakeDB())
    monkeypatch.setattr(app_module.auth, "delete_user", lambda _uid: None)

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "DELETE MY ACCOUNT", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["auth_user_deleted"] is True
