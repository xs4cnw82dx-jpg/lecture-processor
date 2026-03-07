import io
import json
import zipfile
from datetime import datetime, timezone
from types import SimpleNamespace

import pytest
from werkzeug.datastructures import MultiDict

from tests.runtime_test_support import get_test_core

core = get_test_core()
from lecture_processor.runtime.container import get_runtime
from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.ai import pipelines as ai_pipelines
from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import purchases as billing_purchases
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.rate_limit import quotas as rate_limit_quotas
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.domains.study import export as study_export
from lecture_processor.domains.upload import import_audio as upload_import_audio
from lecture_processor.services import upload_api_service

pytestmark = pytest.mark.usefixtures("disable_sentry")


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

    info = core.build_admin_deployment_info("lecture-processor-1.onrender.com")
    assert info["runtime"] == "render"
    assert info["service_name"] == "lecture-processor"
    assert info["git_commit_short"] == "abcdef123456"
    assert info["host_matches_render"] is True

    mismatch = core.build_admin_deployment_info("other-host.onrender.com")
    assert mismatch["host_matches_render"] is False


def test_build_admin_runtime_checks_reports_tool_and_stripe_state(monkeypatch):
    monkeypatch.setattr(core.stripe, "api_key", "sk_test_123")
    monkeypatch.setattr(core, "STRIPE_PUBLISHABLE_KEY", "pk_test_123")
    monkeypatch.setattr(core, "STRIPE_WEBHOOK_SECRET", "whsec_test_123")
    monkeypatch.setattr(core, "get_soffice_binary", lambda: "/usr/bin/soffice")
    monkeypatch.setattr(core, "get_ffmpeg_binary", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(core.shutil, "which", lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "")
    monkeypatch.setattr(core, "db", object())
    monkeypatch.setattr(core, "client", object())

    checks = core.build_admin_runtime_checks()
    assert checks["stripe_secret_mode"] == "test"
    assert checks["stripe_publishable_mode"] == "test"
    assert checks["stripe_keys_match"] is True
    assert checks["stripe_webhook_configured"] is True
    assert checks["pptx_conversion_available"] is True
    assert checks["video_import_available"] is True
    assert checks["firebase_ready"] is True
    assert checks["gemini_ready"] is True


def test_auth_user_includes_preferences(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "pref-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(
        core,
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
            "has_created_study_pack": True,
            "preferred_output_language": "dutch",
            "preferred_output_language_custom": "",
            "onboarding_completed": False,
        },
    )

    response = client.get("/api/auth/user", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    body = response.get_json()
    assert body["has_created_study_pack"] is True
    assert body["preferences"]["output_language"] == "dutch"
    assert body["preferences"]["output_language_label"] == "Dutch"
    assert body["preferences"]["onboarding_completed"] is False


def test_user_preferences_put_persists_language_and_onboarding(client, monkeypatch):
    writes = []
    monkeypatch.setattr(core, "db", object())
    monkeypatch.setattr(
        core.users_repo,
        "set_doc",
        lambda _db, _uid, payload, merge=False: writes.append((payload, merge)),
    )
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "pref-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(
        core,
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
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "pref-u3", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(
        core,
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
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u1", "email": "user@example.com"})
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (False, 12))
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post("/api/lp-event", json={"event": "auth_success", "session_id": "manualtest123"})

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "12"
    body = response.get_json()
    assert body["retry_after_seconds"] == 12
    assert "too many analytics events" in body["error"].lower()
    assert captured == [("analytics", 12)]


def test_checkout_rate_limited_returns_retry_after(client, monkeypatch):
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
        lambda _session_id: {
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


def test_purchase_history_disallowed_email_returns_403(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u2-denied", "email": "blocked@example.invalid"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: False)

    response = client.get("/api/purchase-history")

    assert response.status_code == 403
    assert response.get_json()["error"] == "Email not allowed"


def test_upload_active_jobs_returns_429(client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "client", None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u3", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 2)
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post("/upload", data={"mode": "lecture-notes"})

    assert response.status_code == 429
    body = response.get_json()
    assert "active processing job" in body["error"].lower()
    assert captured == [("upload", 10)]


def test_upload_rate_limited_returns_retry_after(client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "client", None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u4", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (False, 33))
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post("/upload", data={"mode": "lecture-notes"})

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "33"
    body = response.get_json()
    assert body["retry_after_seconds"] == 33
    assert "too many upload attempts" in body["error"].lower()
    assert captured == [("upload", 33)]


def test_upload_rejected_when_disk_space_low(client, monkeypatch):
    monkeypatch.setattr(core, "client", None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-lowdisk", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "has_sufficient_upload_disk_space", lambda _bytes=0, runtime=None: (False, 100, 200))

    response = client.post("/upload", data={"mode": "lecture-notes"})

    assert response.status_code == 503
    assert "storage" in response.get_json()["error"].lower()


def test_upload_rejected_when_daily_quota_reached(client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "client", None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-daycap", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "has_sufficient_upload_disk_space", lambda _bytes=0, runtime=None: (True, 99999999, 100))
    monkeypatch.setattr(rate_limit_quotas, "reserve_daily_upload_bytes", lambda _uid, _bytes, runtime=None: (False, 123))
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post("/upload", data={"mode": "lecture-notes"})

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "123"
    assert "daily upload quota" in response.get_json()["error"].lower()
    assert captured == [("upload", 123)]


def test_upload_invalid_audio_content_type_rejected(client, monkeypatch):
    released = []
    monkeypatch.setattr(core, "client", None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u5", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "has_sufficient_upload_disk_space", lambda _bytes=0, runtime=None: (True, 99999999, 100))
    monkeypatch.setattr(rate_limit_quotas, "reserve_daily_upload_bytes", lambda _uid, _bytes, runtime=None: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "release_daily_upload_bytes", lambda uid, requested, runtime=None: released.append((uid, requested)) or True)
    monkeypatch.setattr(
        core,
        "get_or_create_user",
        lambda _uid, _email: {"lecture_credits_standard": 1, "lecture_credits_extended": 0},
    )

    response = client.post(
        "/upload",
        data={
            "mode": "lecture-notes",
            "study_pack_title": "Neural Networks Week 1",
            "pdf": (io.BytesIO(b"%PDF-1.4\n1 0 obj"), "slides.pdf", "application/pdf"),
            "audio": (io.BytesIO(b"not-audio"), "audio.mp3", "text/plain"),
        },
        content_type="multipart/form-data",
    )

    assert response.status_code == 400
    body = response.get_json()
    assert body["error"] == "Invalid audio content type"
    assert len(released) == 1
    assert released[0][0] == "u5"


def test_import_audio_url_rejects_invalid_host(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "imp-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))

    response = client.post(
        "/api/import-audio-url",
        json={"url": "https://localhost/private/index.m3u8"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "not allowed" in response.get_json()["error"].lower()


def test_import_audio_url_success_returns_token(client, monkeypatch, tmp_path):
    core.AUDIO_IMPORT_TOKENS.clear()
    imported_path = tmp_path / "imported.mp3"
    imported_path.write_bytes(b"ID3\x03\x00\x00\x00")

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "imp-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(
        upload_import_audio,
        "validate_video_import_url",
        lambda _url, runtime=None: ("https://ovp.kaltura.com/path/index.m3u8", ""),
    )
    monkeypatch.setattr(
        core,
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
    assert token in core.AUDIO_IMPORT_TOKENS
    assert body["file_name"] == "lecture.mp3"


def test_upload_accepts_audio_import_token_for_lecture_mode(client, monkeypatch):
    token_calls = []
    released = []
    monkeypatch.setattr(core, "client", object())
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "imp-u3", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "has_sufficient_upload_disk_space", lambda _bytes=0, runtime=None: (True, 10_000_000, 0))
    monkeypatch.setattr(rate_limit_quotas, "reserve_daily_upload_bytes", lambda _uid, _bytes, runtime=None: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "release_daily_upload_bytes", lambda uid, requested, runtime=None: released.append((uid, requested)) or True)
    monkeypatch.setattr(
        core,
        "get_or_create_user",
        lambda _uid, _email: {
            "lecture_credits_standard": 1,
            "lecture_credits_extended": 0,
            "preferred_output_language": "dutch",
            "preferred_output_language_custom": "",
        },
    )
    monkeypatch.setattr(core, "allowed_file", lambda _filename, _allowed: True)
    monkeypatch.setattr(core, "file_has_pdf_signature", lambda _path: True)
    monkeypatch.setattr(core, "file_looks_like_audio", lambda _path: True)
    monkeypatch.setattr(core, "get_saved_file_size", lambda _path: 2048)
    monkeypatch.setattr(billing_credits, "deduct_credit", lambda *_args, **_kwargs: "lecture_credits_standard")
    monkeypatch.setattr(upload_import_audio, "cleanup_expired_audio_import_tokens", lambda runtime=None: None)
    monkeypatch.setattr(ai_pipelines, "process_lecture_notes", lambda _job_id, _pdf_path, _audio_path, runtime=None: None)
    monkeypatch.setattr(
        upload_import_audio,
        "get_audio_import_token_path",
        lambda _uid, token, consume=False, runtime=None: token_calls.append((token, consume)) or ("/tmp/imported-audio.mp3", ""),
    )

    response = client.post(
        "/upload",
        data={
            "mode": "lecture-notes",
            "study_pack_title": "Distributed Systems Interview",
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
    assert core.jobs[body["job_id"]]["output_language"] == "Dutch"
    assert core.jobs[body["job_id"]]["mode"] == "lecture-notes"
    assert released == []


def test_upload_slides_only_accepts_pptx_after_conversion(client, monkeypatch):
    monkeypatch.setattr(core, "client", object())
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "pptx-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(
        core,
        "get_or_create_user",
        lambda _uid, _email: {
            "slides_credits": 1,
            "preferred_output_language": "english",
            "preferred_output_language_custom": "",
        },
    )
    monkeypatch.setattr(core, "resolve_uploaded_slides_to_pdf", lambda _file, _job_id: ("/tmp/converted-slides.pdf", ""))
    monkeypatch.setattr(billing_credits, "deduct_credit", lambda *_args, **_kwargs: "slides_credits")
    monkeypatch.setattr(ai_pipelines, "process_slides_only", lambda _job_id, _pdf_path, runtime=None: None)

    response = client.post(
        "/upload",
        data={
            "mode": "slides-only",
            "study_pack_title": "Linear Algebra Slides",
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
    assert core.jobs[body["job_id"]]["mode"] == "slides-only"


@pytest.mark.parametrize("mode", ["lecture-notes", "slides-only", "interview"])
def test_upload_requires_study_pack_title_for_processing_modes(client, monkeypatch, mode):
    released = []
    monkeypatch.setattr(core, "client", None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "title-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "has_sufficient_upload_disk_space", lambda _bytes=0, runtime=None: (True, 10_000_000, 0))
    monkeypatch.setattr(rate_limit_quotas, "reserve_daily_upload_bytes", lambda _uid, _bytes, runtime=None: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "release_daily_upload_bytes", lambda uid, requested, runtime=None: released.append((uid, requested)) or True)
    monkeypatch.setattr(
        core,
        "get_or_create_user",
        lambda _uid, _email: {
            "lecture_credits_standard": 1,
            "lecture_credits_extended": 0,
            "slides_credits": 1,
            "interview_credits_short": 1,
            "interview_credits_medium": 0,
            "interview_credits_long": 0,
        },
    )

    response = client.post(
        "/upload",
        data={"mode": mode},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert response.get_json()["error"] == "Lecture Topic / Name is required."
    assert len(released) == 1
    assert released[0][0] == "title-u1"


def test_upload_missing_credits_releases_daily_quota_reservation(client, monkeypatch):
    released = []
    monkeypatch.setattr(core, "client", None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "credits-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "has_sufficient_upload_disk_space", lambda _bytes=0, runtime=None: (True, 10_000_000, 0))
    monkeypatch.setattr(rate_limit_quotas, "reserve_daily_upload_bytes", lambda _uid, _bytes, runtime=None: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "release_daily_upload_bytes", lambda uid, requested, runtime=None: released.append((uid, requested)) or True)
    monkeypatch.setattr(core, "get_or_create_user", lambda _uid, _email: {"lecture_credits_standard": 0, "lecture_credits_extended": 0})

    response = client.post(
        "/upload",
        data={"mode": "lecture-notes", "study_pack_title": "Quantum Mechanics Week 1"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 402
    assert "no lecture credits remaining" in response.get_json()["error"].lower()
    assert len(released) == 1
    assert released[0][0] == "credits-u1"


def test_tools_extract_image_rejects_more_than_five_files(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tools-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(core, "get_or_create_user", lambda _uid, _email: {"slides_credits": 5})

    response = client.post(
        "/api/tools/extract",
        data=MultiDict([
            ("source_type", "image"),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\none"), "one.png", "image/png")),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\ntwo"), "two.png", "image/png")),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\nthree"), "three.png", "image/png")),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\nfour"), "four.png", "image/png")),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\nfive"), "five.png", "image/png")),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\nsix"), "six.png", "image/png")),
        ]),
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "up to 5 images" in response.get_json()["error"].lower()


def test_tools_extract_image_accepts_five_files_bills_once_and_returns_output_text(client, monkeypatch):
    deduct_calls = []
    log_calls = []
    cleanup_calls = []

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tools-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(core, "get_or_create_user", lambda _uid, _email: {"slides_credits": 9})
    monkeypatch.setattr(core, "allowed_file", lambda _filename, _allowed: True)
    monkeypatch.setattr(core, "get_saved_file_size", lambda _path: 4096)
    monkeypatch.setattr(core, "get_mime_type", lambda _path: "image/png")
    monkeypatch.setattr(core, "cleanup_files", lambda local_paths, remote_files: cleanup_calls.append((list(local_paths), list(remote_files))))
    monkeypatch.setattr(core, "save_job_log", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(analytics_events, "log_analytics_event", lambda *_args, **_kwargs: log_calls.append(True) or True)

    monkeypatch.setattr(
        billing_credits,
        "deduct_credit",
        lambda _uid, _credit_type, runtime=None: deduct_calls.append((_uid, _credit_type)) or "slides_credits",
    )

    monkeypatch.setattr(
        ai_provider,
        "run_with_provider_retry",
        lambda _name, fn, retry_tracker=None, runtime=None: fn(),
    )
    monkeypatch.setattr(
        ai_provider,
        "generate_with_policy",
        lambda *_args, **_kwargs: SimpleNamespace(text="Combined image extraction output"),
    )
    monkeypatch.setattr(ai_provider, "extract_token_usage", lambda *_args, **_kwargs: {})

    class _Part:
        @staticmethod
        def from_uri(file_uri=None, mime_type=None):
            return {"uri": file_uri, "mime_type": mime_type}

        @staticmethod
        def from_text(text=''):
            return {"text": text}

    class _Content:
        def __init__(self, role=None, parts=None):
            self.role = role
            self.parts = parts or []

    class _UploadApi:
        def upload(self, file=None, config=None):
            return SimpleNamespace(uri=f"mock://{file}", name="mock-file")

    monkeypatch.setattr(core, "types", SimpleNamespace(Part=_Part, Content=_Content))
    monkeypatch.setattr(core, "client", SimpleNamespace(files=_UploadApi()))
    monkeypatch.setattr(core, "wait_for_file_processing", lambda _uploaded: None)

    response = client.post(
        "/api/tools/extract",
        data=MultiDict([
            ("source_type", "image"),
            ("custom_prompt", "Extract all visible text"),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\none"), "one.png", "image/png")),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\ntwo"), "two.png", "image/png")),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\nthree"), "three.png", "image/png")),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\nfour"), "four.png", "image/png")),
            ("files", (io.BytesIO(b"\x89PNG\r\n\x1a\nfive"), "five.png", "image/png")),
        ]),
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["output_text"] == "Combined image extraction output"
    assert payload["content_markdown"] == "Combined image extraction output"
    assert len(deduct_calls) == 1
    assert deduct_calls[0][1] == "slides_credits"
    assert log_calls
    assert cleanup_calls


def test_file_has_pptx_signature_detects_valid_archive(tmp_path):
    valid_path = tmp_path / "slides.pptx"
    with zipfile.ZipFile(valid_path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types></Types>")
        archive.writestr("ppt/presentation.xml", "<presentation></presentation>")
    assert core.file_has_pptx_signature(str(valid_path)) is True

    invalid_path = tmp_path / "invalid.pptx"
    invalid_path.write_bytes(b"not-a-pptx")
    assert core.file_has_pptx_signature(str(invalid_path)) is False


def test_account_export_requires_auth(client):
    response = client.get("/api/account/export")
    assert response.status_code == 401
    assert response.get_json()["error"] == "Unauthorized"


def test_account_export_returns_json_attachment(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u6", "email": "user@gmail.com"})
    monkeypatch.setattr(
        account_lifecycle,
        "collect_user_export_payload",
        lambda uid, email, runtime=None: {"meta": {"uid": uid, "email": email}, "collections": {}},
    )

    response = client.get("/api/account/export", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    assert response.mimetype == "application/json"
    content_disposition = response.headers.get("Content-Disposition", "")
    assert "attachment;" in content_disposition
    assert "lecture-processor-account-export-" in content_disposition
    parsed = json.loads(response.data.decode("utf-8"))
    assert parsed["meta"]["uid"] == "u6"


def test_account_export_bundle_requires_auth(client):
    response = client.post(
        "/api/account/export-bundle",
        json={"scope": "account", "include": {"account_json": True}},
    )
    assert response.status_code == 401
    assert response.get_json()["error"] == "Unauthorized"


def test_account_export_bundle_rejects_empty_selection(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "bundle-u1", "email": "user@gmail.com"})

    response = client.post(
        "/api/account/export-bundle",
        json={"scope": "account", "include": {}},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "select at least one export option" in response.get_json()["error"].lower()


def test_account_export_bundle_returns_selected_folders_and_files(client, monkeypatch):
    class _PackDoc:
        def __init__(self, pack_id, payload):
            self.id = pack_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "bundle-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(
        core.study_repo,
        "list_study_packs_by_uid",
        lambda _db, _uid, _limit: [
            _PackDoc(
                "pack-1",
                {
                    "study_pack_id": "pack-1",
                    "title": "Biology Week 1",
                    "flashcards": [{"front": "Q1", "back": "A1"}],
                    "test_questions": [],
                    "notes_markdown": "",
                },
            )
        ],
    )
    monkeypatch.setattr(
        account_lifecycle,
        "collect_user_export_payload",
        lambda uid, email, runtime=None: {"meta": {"uid": uid, "email": email}, "collections": {}},
    )

    response = client.post(
        "/api/account/export-bundle",
        json={
            "scope": "account",
            "include": {
                "flashcards_csv": True,
                "account_json": True,
            },
        },
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    assert response.mimetype == "application/zip"
    with zipfile.ZipFile(io.BytesIO(response.data), "r") as archive:
        names = set(archive.namelist())
    assert "flashcards_csv/" in names
    assert "account_json/" in names
    assert any(name.startswith("flashcards_csv/") and name.endswith(".csv") for name in names)
    assert "account_json/account-export.json" in names
    assert not any(name.startswith("practice_tests_csv/") for name in names)
    assert not any(name.startswith("lecture_notes_docx/") for name in names)
    assert not any(name.startswith("lecture_notes_pdf_marked/") for name in names)
    assert not any(name.startswith("lecture_notes_pdf_unmarked/") for name in names)


def test_account_export_bundle_marked_and_unmarked_pdf_flags_are_independent(client, monkeypatch):
    class _PackDoc:
        def __init__(self, pack_id, payload):
            self.id = pack_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "bundle-u3", "email": "user@gmail.com"})
    monkeypatch.setattr(
        core.study_repo,
        "list_study_packs_by_uid",
        lambda _db, _uid, _limit: [
            _PackDoc(
                "pack-2",
                {
                    "study_pack_id": "pack-2",
                    "title": "Calculus Midterm",
                    "flashcards": [],
                    "test_questions": [],
                    "notes_markdown": "# Notes",
                },
            )
        ],
    )

    def _fake_pdf(_pack, include_answers=True, runtime=None):
        _ = runtime
        return b"marked-pdf" if include_answers else b"unmarked-pdf"

    monkeypatch.setattr(study_export, "build_notes_pdf_bytes", _fake_pdf)

    marked_only = client.post(
        "/api/account/export-bundle",
        json={"scope": "account", "include": {"lecture_notes_pdf_marked": True}},
        headers={"Authorization": "Bearer dev"},
    )
    assert marked_only.status_code == 200
    with zipfile.ZipFile(io.BytesIO(marked_only.data), "r") as archive:
        marked_names = set(archive.namelist())
    assert any(name.startswith("lecture_notes_pdf_marked/") and name.endswith("-marked.pdf") for name in marked_names)
    assert not any(name.startswith("lecture_notes_pdf_unmarked/") and name.endswith("-unmarked.pdf") for name in marked_names)

    unmarked_only = client.post(
        "/api/account/export-bundle",
        json={"scope": "account", "include": {"lecture_notes_pdf_unmarked": True}},
        headers={"Authorization": "Bearer dev"},
    )
    assert unmarked_only.status_code == 200
    with zipfile.ZipFile(io.BytesIO(unmarked_only.data), "r") as archive:
        unmarked_names = set(archive.namelist())
    assert any(name.startswith("lecture_notes_pdf_unmarked/") and name.endswith("-unmarked.pdf") for name in unmarked_names)
    assert not any(name.startswith("lecture_notes_pdf_marked/") and name.endswith("-marked.pdf") for name in unmarked_names)


def test_account_delete_rejects_bad_confirmation_text(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u7", "email": "user@gmail.com"})

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "nope", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "invalid confirmation text" in response.get_json()["error"].lower()


def test_account_delete_rejects_when_active_jobs_exist(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u8", "email": "user@gmail.com"})
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 1)

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "DELETE MY ACCOUNT", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 409
    assert "cannot delete account while 1 queued or processing job" in response.get_json()["error"].lower()


def test_account_delete_success_path_returns_ok(client, monkeypatch):
    class _FakeProgressSnapshot:
        exists = False

    class _FakeProgressDoc:
        def get(self):
            return _FakeProgressSnapshot()

        def delete(self):
            return None

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u9", "email": "user@gmail.com"})
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(account_lifecycle, "mark_account_deletion_requested", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "query_docs_by_field", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(account_lifecycle, "has_docs_by_field", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(account_lifecycle, "remove_upload_artifacts_for_job_ids", lambda _job_ids, runtime=None: 0)
    monkeypatch.setattr(core.batch_repo, "list_batch_jobs_by_uid", lambda _db, _uid, _limit: [])
    monkeypatch.setattr(core.batch_repo, "list_batch_rows", lambda _db, _batch_id: [])
    monkeypatch.setattr(core, "get_study_progress_doc", lambda _uid: _FakeProgressDoc())
    monkeypatch.setattr(core.auth, "delete_user", lambda _uid: None)
    monkeypatch.setattr(core.users_repo, "delete_doc", lambda _db, _uid: None)

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "DELETE MY ACCOUNT", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["auth_user_deleted"] is True


def test_account_delete_exhaustively_deletes_paginated_docs(client, monkeypatch):
    store = {
        "job_logs": {
            f"log-{idx}": {"uid": "u-delete", "job_id": f"job-{idx}"}
            for idx in range(101)
        },
        "purchases": {},
        "analytics_events": {},
        "study_folders": {},
        "study_card_states": {},
        "study_packs": {},
        core.RUNTIME_JOBS_COLLECTION: {},
        "batch_jobs": {},
    }
    deleted_profiles = []
    deleted_auth_users = []
    removed_artifact_sets = []

    class _DocReference:
        def __init__(self, collection_name, doc_id):
            self.collection_name = collection_name
            self.doc_id = doc_id

        def delete(self):
            store[self.collection_name].pop(self.doc_id, None)
            return None

        def set(self, payload, merge=False):
            existing = dict(store[self.collection_name].get(self.doc_id) or {})
            store[self.collection_name][self.doc_id] = dict(existing, **payload) if merge else dict(payload)
            return None

    class _Doc:
        def __init__(self, collection_name, doc_id):
            self.id = doc_id
            self.reference = _DocReference(collection_name, doc_id)
            self._collection_name = collection_name

        def to_dict(self):
            return dict(store[self._collection_name].get(self.id) or {})

    class _ProgressSnapshot:
        exists = False

    class _ProgressDoc:
        def get(self):
            return _ProgressSnapshot()

        def delete(self):
            return None

    def _query_docs_by_field(collection_name, field_name, field_value, limit, runtime=None):
        _ = runtime
        matches = []
        for doc_id, payload in list(store.get(collection_name, {}).items()):
            if str(payload.get(field_name, "")) != str(field_value):
                continue
            matches.append(_Doc(collection_name, doc_id))
            if len(matches) >= limit:
                break
        return matches

    def _has_docs_by_field(collection_name, field_name, field_value, runtime=None):
        _ = runtime
        return any(str(payload.get(field_name, "")) == str(field_value) for payload in store.get(collection_name, {}).values())

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-delete", "email": "user@gmail.com"})
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(account_lifecycle, "mark_account_deletion_requested", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "query_docs_by_field", _query_docs_by_field)
    monkeypatch.setattr(account_lifecycle, "has_docs_by_field", _has_docs_by_field)
    monkeypatch.setattr(
        account_lifecycle,
        "remove_upload_artifacts_for_job_ids",
        lambda job_ids, runtime=None: removed_artifact_sets.append(set(job_ids)) or len(job_ids),
    )
    monkeypatch.setattr(core.batch_repo, "list_batch_jobs_by_uid", lambda _db, _uid, _limit: [])
    monkeypatch.setattr(core.batch_repo, "list_batch_rows", lambda _db, _batch_id: [])
    monkeypatch.setattr(core, "get_study_progress_doc", lambda _uid: _ProgressDoc())
    monkeypatch.setattr(core.auth, "delete_user", lambda uid: deleted_auth_users.append(uid))
    monkeypatch.setattr(core.users_repo, "delete_doc", lambda _db, uid: deleted_profiles.append(uid))

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "DELETE MY ACCOUNT", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["deleted"]["job_logs"] == 101
    assert store["job_logs"] == {}
    assert deleted_auth_users == ["u-delete"]
    assert deleted_profiles == ["u-delete"]
    assert removed_artifact_sets and len(removed_artifact_sets[0]) == 101


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

    merged = core.merge_streak_data(server, incoming)

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

    merged = core.merge_card_state_entries(server, incoming)

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
    runtime = get_runtime(client.application)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u10", "email": "user@gmail.com"})
    monkeypatch.setattr(runtime, "db", object(), raising=False)
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda _uid: fake_progress_doc, raising=False)
    monkeypatch.setattr(runtime, "get_study_card_state_doc", lambda _uid, _pack_id: fake_card_doc, raising=False)

    response = client.put(
        "/api/study-progress",
        json={"card_states": {"pack-1": {}}},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    assert fake_progress_doc.set_calls, "progress doc should still be updated"
    assert fake_card_doc.delete_calls == 0
    assert fake_card_doc.set_calls == []


def test_update_study_progress_invalid_card_states_returns_400_without_writes(client, monkeypatch):
    class _FakeSnapshot:
        exists = False

        def to_dict(self):
            return {}

    class _FakeProgressDoc:
        def __init__(self):
            self.set_calls = []

        def get(self):
            return _FakeSnapshot()

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))

    class _FakeCardDoc:
        def __init__(self):
            self.set_calls = []
            self.delete_calls = 0

        def get(self):
            return _FakeSnapshot()

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))

        def delete(self):
            self.delete_calls += 1

    fake_progress_doc = _FakeProgressDoc()
    fake_card_doc = _FakeCardDoc()

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-invalid-cards", "email": "user@gmail.com"})
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(core, "get_study_progress_doc", lambda _uid: fake_progress_doc)
    monkeypatch.setattr(core, "get_study_card_state_doc", lambda _uid, _pack_id: fake_card_doc)

    response = client.put(
        "/api/study-progress",
        json={"card_states": ["not", "an", "object"]},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert fake_progress_doc.set_calls == []
    assert fake_card_doc.set_calls == []
    assert fake_card_doc.delete_calls == 0


def test_update_study_progress_invalid_remove_pack_ids_returns_400_without_writes(client, monkeypatch):
    class _FakeSnapshot:
        exists = False

        def to_dict(self):
            return {}

    class _FakeProgressDoc:
        def __init__(self):
            self.set_calls = []

        def get(self):
            return _FakeSnapshot()

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))

    class _FakeCardDoc:
        def __init__(self):
            self.set_calls = []
            self.delete_calls = 0

        def get(self):
            return _FakeSnapshot()

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))

        def delete(self):
            self.delete_calls += 1

    fake_progress_doc = _FakeProgressDoc()
    fake_card_doc = _FakeCardDoc()

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-invalid-remove", "email": "user@gmail.com"})
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(core, "get_study_progress_doc", lambda _uid: fake_progress_doc)
    monkeypatch.setattr(core, "get_study_card_state_doc", lambda _uid, _pack_id: fake_card_doc)

    response = client.put(
        "/api/study-progress",
        json={"remove_pack_ids": "pack-1"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert fake_progress_doc.set_calls == []
    assert fake_card_doc.set_calls == []
    assert fake_card_doc.delete_calls == 0


def test_compute_study_progress_summary_uses_server_logic_for_overview():
    now = core.datetime.now()
    today = now.strftime("%Y-%m-%d")
    tomorrow = (now + core.timedelta(days=1)).strftime("%Y-%m-%d")

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

    summary = core.compute_study_progress_summary(progress_data, card_state_maps)

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

    summary = core.compute_study_progress_summary(progress_data, [], base_now=base_now)

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

    summary = core.compute_study_progress_summary(progress_data, [], base_now=base_now)

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

    summary = core.compute_study_progress_summary(progress_data, [], base_now=base_now)

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
    runtime = get_runtime(client.application)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u12", "email": "user@gmail.com"})
    monkeypatch.setattr(runtime, "db", object(), raising=False)
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda uid: _FakeDocRef(progress_store, uid), raising=False)
    monkeypatch.setattr(
        runtime,
        "get_study_card_state_doc",
        lambda uid, pack_id: _FakeDocRef(card_state_store, f"{uid}:{pack_id}"),
        raising=False,
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


def test_download_docx_transcript_uses_consistent_filename(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u14", "email": "user@gmail.com"})
    core.jobs["job-transcript-docx"] = {
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

    monkeypatch.setattr(core, "client", _FakeClient())
    monkeypatch.setattr(core, "convert_audio_to_mp3_with_ytdlp", lambda path: (str(path), False))
    monkeypatch.setattr(core, "persist_audio_for_study_pack", lambda _job_id, _path: "/tmp/persisted.mp3")
    monkeypatch.setattr(core, "get_mime_type", lambda _path: "audio/mpeg")
    monkeypatch.setattr(core, "wait_for_file_processing", lambda _uploaded: None)
    monkeypatch.setattr(
        core,
        "generate_interview_enhancements",
        lambda _transcript, _features, _language="English", retry_tracker=None: {
            "summary": "Summary text",
            "sections": None,
            "combined": None,
            "successful_features": ["summary"],
            "failed_count": 0,
            "error": None,
        },
    )
    monkeypatch.setattr(core, "save_study_pack", lambda job_id, _job: saved.append(job_id))
    monkeypatch.setattr(core, "cleanup_files", lambda _local, _gemini: None)
    monkeypatch.setattr(core, "save_job_log", lambda *_args, **_kwargs: None)

    job_id = "job-interview-save"
    core.jobs[job_id] = {
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
        "billing_receipt": core.initialize_billing_receipt({"interview_credits_short": 1, "slides_credits": 1}),
    }

    core.process_interview_transcription(job_id, str(audio_path))

    assert core.jobs[job_id]["status"] == "complete"
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
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-non-admin", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: False)
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

    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _FakeDoc())
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "other-uid", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: False)
    monkeypatch.setattr(study_audio, "resolve_audio_storage_path_from_key", lambda _key, runtime=None: str(audio_file))

    response = client.get("/api/study-packs/pack-audio/audio", headers={"Authorization": "Bearer dev"})
    assert response.status_code == 403
