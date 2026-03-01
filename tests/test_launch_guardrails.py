import io
import json
import zipfile
from datetime import datetime, timezone

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


def test_build_admin_deployment_info_detects_render_host(monkeypatch):
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("RENDER_SERVICE_NAME", "lecture-processor")
    monkeypatch.setenv("RENDER_SERVICE_ID", "srv-123")
    monkeypatch.setenv("RENDER_EXTERNAL_HOSTNAME", "lecture-processor-1.onrender.com")
    monkeypatch.setenv("RENDER_GIT_BRANCH", "main")
    monkeypatch.setenv("RENDER_GIT_COMMIT", "abcdef1234567890")

    info = app_module.build_admin_deployment_info("lecture-processor-1.onrender.com")
    assert info["runtime"] == "render"
    assert info["service_name"] == "lecture-processor"
    assert info["git_commit_short"] == "abcdef123456"
    assert info["host_matches_render"] is True

    mismatch = app_module.build_admin_deployment_info("other-host.onrender.com")
    assert mismatch["host_matches_render"] is False


def test_build_admin_runtime_checks_reports_tool_and_stripe_state(monkeypatch):
    monkeypatch.setattr(app_module.stripe, "api_key", "sk_test_123")
    monkeypatch.setattr(app_module, "STRIPE_PUBLISHABLE_KEY", "pk_test_123")
    monkeypatch.setattr(app_module, "get_soffice_binary", lambda: "/usr/bin/soffice")
    monkeypatch.setattr(app_module, "get_ffmpeg_binary", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(app_module.shutil, "which", lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "")
    monkeypatch.setattr(app_module, "db", object())
    monkeypatch.setattr(app_module, "client", object())

    checks = app_module.build_admin_runtime_checks()
    assert checks["stripe_secret_mode"] == "test"
    assert checks["stripe_publishable_mode"] == "test"
    assert checks["stripe_keys_match"] is True
    assert checks["pptx_conversion_available"] is True
    assert checks["video_import_available"] is True
    assert checks["firebase_ready"] is True
    assert checks["gemini_ready"] is True


def test_auth_user_includes_preferences(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "pref-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(
        app_module,
        "get_or_create_user",
        lambda _uid, _email: {
            "uid": "pref-u1",
            "email": "user@gmail.com",
            "lecture_credits_standard": 1,
            "lecture_credits_extended": 0,
            "slides_credits": 2,
            "interview_credits_short": 3,
            "interview_credits_medium": 0,
            "interview_credits_long": 0,
            "total_processed": 4,
            "preferred_output_language": "dutch",
            "preferred_output_language_custom": "",
            "onboarding_completed": False,
        },
    )

    response = client.get("/api/auth/user", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    body = response.get_json()
    assert body["preferences"]["output_language"] == "dutch"
    assert body["preferences"]["output_language_label"] == "Dutch"
    assert body["preferences"]["onboarding_completed"] is False


def test_user_preferences_put_persists_language_and_onboarding(client, monkeypatch):
    writes = []

    class _FakeDoc:
        def set(self, payload, merge=False):
            writes.append((payload, merge))
            return None

    class _FakeCollection:
        def document(self, _doc_id):
            return _FakeDoc()

    class _FakeDB:
        def collection(self, _name):
            return _FakeCollection()

    monkeypatch.setattr(app_module, "db", _FakeDB())
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "pref-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(
        app_module,
        "get_or_create_user",
        lambda _uid, _email: {
            "uid": "pref-u2",
            "email": "user@gmail.com",
            "preferred_output_language": "english",
            "preferred_output_language_custom": "",
            "onboarding_completed": False,
        },
    )

    response = client.put(
        "/api/user-preferences",
        json={"output_language": "dutch", "onboarding_completed": True},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["preferences"]["output_language"] == "dutch"
    assert body["preferences"]["output_language_label"] == "Dutch"
    assert body["preferences"]["onboarding_completed"] is True
    assert writes, "Firestore set should be called"
    last_payload, merge = writes[-1]
    assert merge is True
    assert last_payload["preferred_output_language"] == "dutch"
    assert last_payload["onboarding_completed"] is True


def test_user_preferences_put_requires_custom_language_for_other(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "pref-u3", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(
        app_module,
        "get_or_create_user",
        lambda _uid, _email: {
            "uid": "pref-u3",
            "email": "user@gmail.com",
            "preferred_output_language": "english",
            "preferred_output_language_custom": "",
            "onboarding_completed": False,
        },
    )

    response = client.put(
        "/api/user-preferences",
        json={"output_language": "other", "output_language_custom": ""},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "custom language is required" in response.get_json()["error"].lower()


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


def test_import_audio_url_rejects_invalid_host(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "imp-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (True, 0))

    response = client.post(
        "/api/import-audio-url",
        json={"url": "https://localhost/private/index.m3u8"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "not allowed" in response.get_json()["error"].lower()


def test_import_audio_url_success_returns_token(client, monkeypatch, tmp_path):
    app_module.AUDIO_IMPORT_TOKENS.clear()
    imported_path = tmp_path / "imported.mp3"
    imported_path.write_bytes(b"ID3\x03\x00\x00\x00")

    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "imp-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(
        app_module,
        "validate_video_import_url",
        lambda _url: ("https://ovp.kaltura.com/path/index.m3u8", ""),
    )
    monkeypatch.setattr(
        app_module,
        "download_audio_from_video_url",
        lambda _url, _prefix: (str(imported_path), "lecture.mp3", imported_path.stat().st_size),
    )

    response = client.post(
        "/api/import-audio-url",
        json={"url": "https://ovp.kaltura.com/path/index.m3u8"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    token = body["audio_import_token"]
    assert token in app_module.AUDIO_IMPORT_TOKENS
    assert body["file_name"] == "lecture.mp3"


def test_upload_accepts_audio_import_token_for_lecture_mode(client, monkeypatch):
    token_calls = []
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "imp-u3", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(app_module, "count_active_jobs_for_user", lambda _uid: 0)
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(
        app_module,
        "get_or_create_user",
        lambda _uid, _email: {
            "lecture_credits_standard": 1,
            "lecture_credits_extended": 0,
            "preferred_output_language": "dutch",
            "preferred_output_language_custom": "",
        },
    )
    monkeypatch.setattr(app_module, "allowed_file", lambda _filename, _allowed: True)
    monkeypatch.setattr(app_module, "file_has_pdf_signature", lambda _path: True)
    monkeypatch.setattr(app_module, "file_looks_like_audio", lambda _path: True)
    monkeypatch.setattr(app_module, "get_saved_file_size", lambda _path: 2048)
    monkeypatch.setattr(app_module, "deduct_credit", lambda *_args, **_kwargs: "lecture_credits_standard")
    monkeypatch.setattr(app_module, "cleanup_expired_audio_import_tokens", lambda: None)
    monkeypatch.setattr(app_module, "process_lecture_notes", lambda _job_id, _pdf_path, _audio_path: None)
    monkeypatch.setattr(
        app_module,
        "get_audio_import_token_path",
        lambda _uid, token, consume=False: token_calls.append((token, consume)) or ("/tmp/imported-audio.mp3", ""),
    )

    response = client.post(
        "/upload",
        data={
            "mode": "lecture-notes",
            "audio_import_token": "tok-abc-123",
            "pdf": (io.BytesIO(b"%PDF-1.4\n1 0 obj"), "slides.pdf", "application/pdf"),
        },
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert "job_id" in body
    assert token_calls == [("tok-abc-123", False), ("tok-abc-123", True)]
    assert app_module.jobs[body["job_id"]]["output_language"] == "Dutch"
    assert app_module.jobs[body["job_id"]]["mode"] == "lecture-notes"


def test_upload_slides_only_accepts_pptx_after_conversion(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "pptx-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(app_module, "count_active_jobs_for_user", lambda _uid: 0)
    monkeypatch.setattr(app_module, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(
        app_module,
        "get_or_create_user",
        lambda _uid, _email: {
            "slides_credits": 1,
            "preferred_output_language": "english",
            "preferred_output_language_custom": "",
        },
    )
    monkeypatch.setattr(app_module, "resolve_uploaded_slides_to_pdf", lambda _file, _job_id: ("/tmp/converted-slides.pdf", ""))
    monkeypatch.setattr(app_module, "deduct_credit", lambda *_args, **_kwargs: "slides_credits")
    monkeypatch.setattr(app_module, "process_slides_only", lambda _job_id, _pdf_path: None)

    response = client.post(
        "/upload",
        data={
            "mode": "slides-only",
            "pdf": (
                io.BytesIO(b"PK\x03\x04pptx-bytes"),
                "slides.pptx",
                "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ),
        },
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body.get("job_id")
    assert app_module.jobs[body["job_id"]]["mode"] == "slides-only"


def test_file_has_pptx_signature_detects_valid_archive(tmp_path):
    valid_path = tmp_path / "slides.pptx"
    with zipfile.ZipFile(valid_path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types></Types>")
        archive.writestr("ppt/presentation.xml", "<presentation></presentation>")
    assert app_module.file_has_pptx_signature(str(valid_path)) is True

    invalid_path = tmp_path / "invalid.pptx"
    invalid_path.write_bytes(b"not-a-pptx")
    assert app_module.file_has_pptx_signature(str(invalid_path)) is False


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


def test_merge_streak_data_keeps_most_recent_progress_day():
    server = {
        "last_study_date": "2026-02-26",
        "current_streak": 4,
        "daily_progress_date": "2026-02-26",
        "daily_progress_count": 7,
    }
    incoming = {
        "last_study_date": "2026-02-25",
        "current_streak": 1,
        "daily_progress_date": "2026-02-25",
        "daily_progress_count": 2,
    }

    merged = app_module.merge_streak_data(server, incoming)

    assert merged["last_study_date"] == "2026-02-26"
    assert merged["current_streak"] == 4
    assert merged["daily_progress_date"] == "2026-02-26"
    assert merged["daily_progress_count"] == 7


def test_merge_card_state_entries_keeps_counts_monotonic():
    server = {
        "seen": 5,
        "correct": 4,
        "wrong": 1,
        "level": "familiar",
        "interval_days": 7,
        "next_review_date": "2026-02-28",
        "last_review_date": "2026-02-26",
        "difficulty": "hard",
    }
    incoming = {
        "seen": 2,
        "correct": 2,
        "wrong": 0,
        "level": "familiar",
        "interval_days": 1,
        "next_review_date": "2026-02-27",
        "last_review_date": "2026-02-27",
        "difficulty": "easy",
    }

    merged = app_module.merge_card_state_entries(server, incoming)

    assert merged["seen"] == 5
    assert merged["correct"] == 4
    assert merged["wrong"] == 1
    assert merged["last_review_date"] == "2026-02-27"
    assert merged["next_review_date"] == "2026-02-27"
    assert merged["interval_days"] == 1
    assert merged["difficulty"] == "easy"


def test_update_study_progress_empty_card_state_payload_does_not_delete_existing_pack(client, monkeypatch):
    class _FakeSnapshot:
        def __init__(self, payload=None, exists=True):
            self._payload = payload or {}
            self.exists = exists

        def to_dict(self):
            return dict(self._payload)

    class _FakeProgressDoc:
        def __init__(self):
            self.set_calls = []

        def get(self):
            return _FakeSnapshot({}, exists=False)

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))
            return None

    class _FakeCardStateDoc:
        def __init__(self):
            self.set_calls = []
            self.delete_calls = 0

        def get(self):
            return _FakeSnapshot(
                {
                    "uid": "u10",
                    "pack_id": "pack-1",
                    "state": {"fc_1": {"seen": 1, "correct": 1, "wrong": 0, "interval_days": 1, "last_review_date": "2026-02-26"}},
                },
                exists=True,
            )

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))
            return None

        def delete(self):
            self.delete_calls += 1
            return None

    fake_progress_doc = _FakeProgressDoc()
    fake_card_doc = _FakeCardStateDoc()

    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u10", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "get_study_progress_doc", lambda _uid: fake_progress_doc)
    monkeypatch.setattr(app_module, "get_study_card_state_doc", lambda _uid, _pack_id: fake_card_doc)

    response = client.put(
        "/api/study-progress",
        json={"card_states": {"pack-1": {}}},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    assert fake_progress_doc.set_calls, "progress doc should still be updated"
    assert fake_card_doc.delete_calls == 0
    assert fake_card_doc.set_calls == []


def test_compute_study_progress_summary_uses_server_logic_for_overview():
    now = app_module.datetime.now()
    today = now.strftime("%Y-%m-%d")
    tomorrow = (now + app_module.timedelta(days=1)).strftime("%Y-%m-%d")

    progress_data = {
        "daily_goal": 30,
        "streak_data": {
            "last_study_date": today,
            "current_streak": 6,
            "daily_progress_date": today,
            "daily_progress_count": 9,
        },
    }
    card_state_maps = [
        {
            "fc_1": {"seen": 1, "correct": 1, "wrong": 0, "interval_days": 1, "next_review_date": today},
            "fc_2": {"seen": 1, "correct": 1, "wrong": 0, "interval_days": 1, "next_review_date": tomorrow},
        }
    ]

    summary = app_module.compute_study_progress_summary(progress_data, card_state_maps)

    assert summary["daily_goal"] == 30
    assert summary["current_streak"] == 6
    assert summary["today_progress"] == 9
    assert summary["due_today"] == 1


def test_compute_study_progress_summary_respects_timezone_boundary():
    base_now = datetime(2026, 2, 25, 23, 30, tzinfo=timezone.utc)
    progress_data = {
        "daily_goal": 20,
        "timezone": "Europe/Amsterdam",
        "streak_data": {
            "last_study_date": "2026-02-26",
            "current_streak": 3,
            "daily_progress_date": "2026-02-26",
            "daily_progress_count": 2,
        },
    }

    summary = app_module.compute_study_progress_summary(progress_data, [], base_now=base_now)

    assert summary["current_streak"] == 3
    assert summary["today_progress"] == 2


def test_compute_study_progress_summary_invalid_timezone_falls_back_to_utc():
    base_now = datetime(2026, 2, 25, 23, 30, tzinfo=timezone.utc)
    progress_data = {
        "daily_goal": 20,
        "timezone": "Invalid/Timezone",
        "streak_data": {
            "last_study_date": "2026-02-26",
            "current_streak": 3,
            "daily_progress_date": "2026-02-26",
            "daily_progress_count": 2,
        },
    }

    summary = app_module.compute_study_progress_summary(progress_data, [], base_now=base_now)

    assert summary["current_streak"] == 0
    assert summary["today_progress"] == 0


def test_compute_study_progress_summary_timezone_yesterday_window():
    base_now = datetime(2026, 2, 26, 0, 30, tzinfo=timezone.utc)
    progress_data = {
        "daily_goal": 25,
        "timezone": "Pacific/Honolulu",
        "streak_data": {
            "last_study_date": "2026-02-24",
            "current_streak": 4,
            "daily_progress_date": "2026-02-25",
            "daily_progress_count": 3,
        },
    }

    summary = app_module.compute_study_progress_summary(progress_data, [], base_now=base_now)

    assert summary["current_streak"] == 4
    assert summary["today_progress"] == 3
    assert summary["daily_goal"] == 25


def test_update_study_progress_merges_cross_browser_card_states(client, monkeypatch):
    class _FakeSnapshot:
        def __init__(self, payload=None, exists=False):
            self._payload = payload or {}
            self.exists = exists

        def to_dict(self):
            return dict(self._payload)

    class _FakeDocRef:
        def __init__(self, store, key):
            self.store = store
            self.key = key

        def get(self):
            payload = self.store.get(self.key)
            return _FakeSnapshot(payload, exists=payload is not None)

        def set(self, payload, merge=False):
            if merge and self.key in self.store and isinstance(self.store[self.key], dict):
                merged = dict(self.store[self.key])
                merged.update(payload or {})
                self.store[self.key] = merged
            else:
                self.store[self.key] = dict(payload or {})
            return None

        def delete(self):
            self.store.pop(self.key, None)
            return None

    progress_store = {}
    card_state_store = {}

    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u12", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "get_study_progress_doc", lambda uid: _FakeDocRef(progress_store, uid))
    monkeypatch.setattr(
        app_module,
        "get_study_card_state_doc",
        lambda uid, pack_id: _FakeDocRef(card_state_store, f"{uid}:{pack_id}"),
    )

    browser_a_payload = {
        "daily_goal": 20,
        "timezone": "Europe/Amsterdam",
        "streak_data": {
            "last_study_date": "2026-02-25",
            "current_streak": 2,
            "daily_progress_date": "2026-02-25",
            "daily_progress_count": 4,
        },
        "card_states": {
            "pack-sync-1": {
                "fc_1": {
                    "seen": 2,
                    "correct": 2,
                    "wrong": 0,
                    "interval_days": 1,
                    "next_review_date": "2026-02-26",
                    "last_review_date": "2026-02-25",
                    "difficulty": "medium",
                }
            }
        },
    }
    browser_b_payload = {
        "timezone": "Europe/Amsterdam",
        "streak_data": {
            "last_study_date": "2026-02-26",
            "current_streak": 3,
            "daily_progress_date": "2026-02-26",
            "daily_progress_count": 1,
        },
        "card_states": {
            "pack-sync-1": {
                "fc_1": {
                    "seen": 1,
                    "correct": 1,
                    "wrong": 0,
                    "interval_days": 3,
                    "next_review_date": "2026-03-01",
                    "last_review_date": "2026-02-26",
                    "difficulty": "easy",
                },
                "fc_2": {
                    "seen": 1,
                    "correct": 1,
                    "wrong": 0,
                    "interval_days": 1,
                    "next_review_date": "2026-02-27",
                    "last_review_date": "2026-02-26",
                    "difficulty": "hard",
                },
            }
        },
    }

    r1 = client.put("/api/study-progress", json=browser_a_payload, headers={"Authorization": "Bearer dev"})
    r2 = client.put("/api/study-progress", json=browser_b_payload, headers={"Authorization": "Bearer dev"})

    assert r1.status_code == 200
    assert r2.status_code == 200

    saved_progress = progress_store["u12"]
    assert saved_progress["daily_goal"] == 20
    assert saved_progress["timezone"] == "Europe/Amsterdam"
    assert saved_progress["streak_data"]["last_study_date"] == "2026-02-26"
    assert saved_progress["streak_data"]["current_streak"] == 3
    assert saved_progress["streak_data"]["daily_progress_date"] == "2026-02-26"
    assert saved_progress["streak_data"]["daily_progress_count"] == 1

    saved_cards = card_state_store["u12:pack-sync-1"]["state"]
    assert set(saved_cards.keys()) == {"fc_1", "fc_2"}
    assert saved_cards["fc_1"]["seen"] == 2
    assert saved_cards["fc_1"]["correct"] == 2
    assert saved_cards["fc_1"]["last_review_date"] == "2026-02-26"
    assert saved_cards["fc_1"]["interval_days"] == 3
    assert saved_cards["fc_1"]["next_review_date"] == "2026-03-01"
    assert saved_cards["fc_1"]["difficulty"] == "easy"
    assert saved_cards["fc_2"]["seen"] == 1


def test_billing_receipt_helpers_track_charged_and_refunded_credits():
    job = {"billing_receipt": app_module.initialize_billing_receipt({"interview_credits_short": 1, "slides_credits": 2})}

    app_module.add_job_credit_refund(job, "slides_credits", 1)
    app_module.add_job_credit_refund(job, "interview_credits_short", 1)

    snapshot = app_module.get_billing_receipt_snapshot(job)
    assert snapshot["charged"] == {"interview_credits_short": 1, "slides_credits": 2}
    assert snapshot["refunded"] == {"slides_credits": 1, "interview_credits_short": 1}


def test_status_returns_interview_billing_receipt(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u13", "email": "user@gmail.com"})
    app_module.jobs["job-interview-receipt"] = {
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


def test_download_docx_transcript_uses_consistent_filename(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u14", "email": "user@gmail.com"})
    app_module.jobs["job-transcript-docx"] = {
        "status": "complete",
        "mode": "lecture-notes",
        "user_id": "u14",
        "result": "Lecture notes",
        "transcript": "Transcript body",
    }

    response = client.get("/download-docx/job-transcript-docx?type=transcript", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    assert "lecture-transcript.docx" in (response.headers.get("Content-Disposition") or "")


def test_process_interview_transcription_saves_pack_on_success(monkeypatch, tmp_path):
    class _FakeUploaded:
        uri = "gs://fake/audio"
        name = "files/fake-audio"

    class _FakeFiles:
        def upload(self, **_kwargs):
            return _FakeUploaded()

        def delete(self, **_kwargs):
            return None

    class _FakeModels:
        def generate_content(self, **_kwargs):
            class _Resp:
                text = "Interview transcript output"

            return _Resp()

    class _FakeClient:
        files = _FakeFiles()
        models = _FakeModels()

    saved = []
    audio_path = tmp_path / "interview.wav"
    audio_path.write_bytes(b"RIFF0000WAVEfmt ")

    monkeypatch.setattr(app_module, "client", _FakeClient())
    monkeypatch.setattr(app_module, "convert_audio_to_mp3_with_ytdlp", lambda path: (str(path), False))
    monkeypatch.setattr(app_module, "persist_audio_for_study_pack", lambda _job_id, _path: "/tmp/persisted.mp3")
    monkeypatch.setattr(app_module, "get_mime_type", lambda _path: "audio/mpeg")
    monkeypatch.setattr(app_module, "wait_for_file_processing", lambda _uploaded: None)
    monkeypatch.setattr(
        app_module,
        "generate_interview_enhancements",
        lambda _transcript, _features, _language="English": {
            "summary": "Summary text",
            "sections": None,
            "combined": None,
            "successful_features": ["summary"],
            "failed_count": 0,
            "error": None,
        },
    )
    monkeypatch.setattr(app_module, "save_study_pack", lambda job_id, _job: saved.append(job_id))
    monkeypatch.setattr(app_module, "cleanup_files", lambda _local, _gemini: None)
    monkeypatch.setattr(app_module, "save_job_log", lambda *_args, **_kwargs: None)

    job_id = "job-interview-save"
    app_module.jobs[job_id] = {
        "status": "starting",
        "step": 0,
        "step_description": "Starting...",
        "total_steps": 2,
        "mode": "interview",
        "user_id": "save-u1",
        "user_email": "user@gmail.com",
        "credit_deducted": "interview_credits_short",
        "credit_refunded": False,
        "started_at": 1772000000.0,
        "result": None,
        "transcript": None,
        "flashcards": [],
        "test_questions": [],
        "study_features": "none",
        "output_language": "English",
        "interview_features": ["summary"],
        "interview_features_cost": 1,
        "interview_features_successful": [],
        "interview_summary": None,
        "interview_sections": None,
        "interview_combined": None,
        "extra_slides_refunded": 0,
        "study_generation_error": None,
        "error": None,
        "billing_receipt": app_module.initialize_billing_receipt({"interview_credits_short": 1, "slides_credits": 1}),
    }

    app_module.process_interview_transcription(job_id, str(audio_path))

    assert app_module.jobs[job_id]["status"] == "complete"
    assert saved == [job_id]


def test_upload_requires_auth(client):
    response = client.post("/upload", data={"mode": "slides-only"})
    assert response.status_code == 401


def test_create_checkout_requires_auth(client):
    response = client.post("/api/create-checkout-session", json={"bundle_id": "lecture_5"})
    assert response.status_code == 401


def test_study_pack_crud_requires_auth(client):
    assert client.get("/api/study-packs").status_code == 401
    assert client.post("/api/study-packs", json={}).status_code == 401
    assert client.get("/api/study-packs/pack-1").status_code == 401
    assert client.patch("/api/study-packs/pack-1", json={}).status_code == 401
    assert client.delete("/api/study-packs/pack-1").status_code == 401


def test_study_folder_crud_requires_auth(client):
    assert client.get("/api/study-folders").status_code == 401
    assert client.post("/api/study-folders", json={"name": "A"}).status_code == 401
    assert client.patch("/api/study-folders/f-1", json={"name": "B"}).status_code == 401
    assert client.delete("/api/study-folders/f-1").status_code == 401


def test_admin_overview_and_export_forbid_non_admin(client, monkeypatch):
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "u-non-admin", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_admin_user", lambda _decoded: False)
    assert client.get("/api/admin/overview", headers={"Authorization": "Bearer dev"}).status_code == 403
    assert client.get("/api/admin/export?type=jobs", headers={"Authorization": "Bearer dev"}).status_code == 403


def test_study_pack_audio_requires_auth(client):
    assert client.get("/api/study-packs/pack-audio/audio").status_code == 401


def test_study_pack_audio_forbidden_for_other_user(client, monkeypatch, tmp_path):
    audio_file = tmp_path / "sample.mp3"
    audio_file.write_bytes(b"ID3\x03\x00\x00\x00")

    class _FakeDoc:
        exists = True

        def __init__(self):
            self.reference = self

        def to_dict(self):
            return {
                "uid": "owner-uid",
                "audio_storage_key": "study_audio/sample.mp3",
            }

        def set(self, *_args, **_kwargs):
            return None

    class _FakeCollection:
        def document(self, _pack_id):
            return self

        def get(self):
            return _FakeDoc()

    class _FakeDB:
        def collection(self, _name):
            return _FakeCollection()

    monkeypatch.setattr(app_module, "db", _FakeDB())
    monkeypatch.setattr(app_module, "verify_firebase_token", lambda _request: {"uid": "other-uid", "email": "user@gmail.com"})
    monkeypatch.setattr(app_module, "is_admin_user", lambda _decoded: False)
    monkeypatch.setattr(app_module, "resolve_audio_storage_path_from_key", lambda _key: str(audio_file))

    response = client.get("/api/study-packs/pack-audio/audio", headers={"Authorization": "Bearer dev"})
    assert response.status_code == 403
