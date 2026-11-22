import io
import zipfile

import pytest

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.ai import pipelines as ai_pipelines
from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.rate_limit import quotas as rate_limit_quotas
from lecture_processor.domains.upload import import_audio as upload_import_audio
from tests.launch.support import _install_dispatch_credit_store
from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures("disable_sentry")


def test_upload_active_jobs_returns_429(allow_account_writes, client, monkeypatch):
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


def test_upload_rate_limited_returns_retry_after(allow_account_writes, client, monkeypatch):
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


def test_upload_rejected_when_disk_space_low(allow_account_writes, client, monkeypatch):
    monkeypatch.setattr(core, "client", None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-lowdisk", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "has_sufficient_upload_disk_space", lambda _bytes=0, runtime=None: (False, 100, 200))

    response = client.post("/upload", data={"mode": "lecture-notes"})

    assert response.status_code == 503
    assert "storage" in response.get_json()["error"].lower()


def test_upload_rejected_when_daily_quota_reached(allow_account_writes, client, monkeypatch):
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


def test_upload_invalid_audio_content_type_rejected(allow_account_writes, client, monkeypatch):
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


def test_import_audio_url_rejects_invalid_host(allow_account_writes, client, monkeypatch):
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


def test_import_audio_url_rate_limited_returns_retry_after(allow_account_writes, client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "imp-limited", "email": "user@gmail.com"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: True)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (False, 17))
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post(
        "/api/import-audio-url",
        json={"url": "https://ovp.kaltura.com/path/index.m3u8"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "17"
    assert response.get_json()["retry_after_seconds"] == 17
    assert captured == [("audio_import", 17)]


def test_import_audio_url_success_queues_job_and_status_returns_token(allow_account_writes, client, monkeypatch, tmp_path):
    core.AUDIO_IMPORT_TOKENS.clear()
    core.AUDIO_IMPORT_JOBS.clear()
    imported_path = tmp_path / "imported.mp3"
    imported_path.write_bytes(b"ID3\x03\x00\x00\x00")
    reserved = []
    released = []

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "imp-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "has_sufficient_upload_disk_space", lambda _bytes=0, runtime=None: (True, 10_000_000_000, 0))
    monkeypatch.setattr(rate_limit_quotas, "reserve_daily_upload_bytes", lambda uid, byte_count, runtime=None: reserved.append((uid, byte_count)) or (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "release_daily_upload_bytes", lambda uid, byte_count, runtime=None: released.append((uid, byte_count)) or True)
    monkeypatch.setattr(
        upload_import_audio,
        "validate_video_import_fetch_target",
        lambda _url, runtime=None: ("https://ovp.kaltura.com/path/index.m3u8?token=secret", ""),
    )
    monkeypatch.setattr(
        core,
        "download_audio_from_video_url",
        lambda _url, _prefix: (str(imported_path), "lecture.mp3", imported_path.stat().st_size),
    )
    monkeypatch.setattr(core, "submit_background_job", lambda target, *args, **kwargs: target(*args, **kwargs))

    response = client.post(
        "/api/import-audio-url",
        json={"url": "https://ovp.kaltura.com/path/index.m3u8"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 202
    body = response.get_json()
    assert body["ok"] is False
    assert body["status"] == "queued"
    assert body["job_id"]

    status_response = client.get(
        f"/api/import-audio-url/{body['job_id']}",
        headers={"Authorization": "Bearer dev"},
    )
    assert status_response.status_code == 200
    status_body = status_response.get_json()
    assert status_body["ok"] is True
    assert status_body["status"] == "complete"
    token = status_body["audio_import_token"]
    assert token in core.AUDIO_IMPORT_TOKENS
    assert status_body["file_name"] == "lecture.mp3"
    assert core.AUDIO_IMPORT_TOKENS[token]["source_url"] == "https://ovp.kaltura.com/[redacted]"
    assert core.AUDIO_IMPORT_TOKENS[token]["quota_bytes_charged"] == imported_path.stat().st_size
    assert reserved == [("imp-u2", core.MAX_AUDIO_UPLOAD_BYTES)]
    assert released == [("imp-u2", core.MAX_AUDIO_UPLOAD_BYTES - imported_path.stat().st_size)]


def test_upload_accepts_audio_import_token_for_lecture_mode(allow_account_writes, client, monkeypatch):
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
    credit_store = _install_dispatch_credit_store(monkeypatch, 'imp-u3', {
        "lecture_credits_standard": 1,
        "lecture_credits_extended": 0,
        "preferred_output_language": "dutch",
        "preferred_output_language_custom": "",
    })
    monkeypatch.setattr(core, "allowed_file", lambda _filename, _allowed: True)
    monkeypatch.setattr(core, "file_has_pdf_signature", lambda _path: True)
    monkeypatch.setattr(core, "file_looks_like_audio", lambda _path: True)
    monkeypatch.setattr(core, "get_saved_file_size", lambda _path: 2048)
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
    assert credit_store.docs('users')['imp-u3']['lecture_credits_standard'] == 0
    assert credit_store.docs('users')['imp-u3']['total_processed'] == 1
    assert len(credit_store.docs('credit_charges')) == 1
    assert len(credit_store.queued) == 1
    assert credit_store.docs(core.RUNTIME_JOBS_COLLECTION)[body['job_id']]['billing_receipt']['charged'] == {'lecture_credits_standard': 1}


def test_upload_slides_only_accepts_pptx_after_conversion(allow_account_writes, client, monkeypatch):
    monkeypatch.setattr(core, "client", object())
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "pptx-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    credit_store = _install_dispatch_credit_store(monkeypatch, 'pptx-u1', {
        "slides_credits": 1,
        "preferred_output_language": "english",
        "preferred_output_language_custom": "",
    })
    monkeypatch.setattr(core, "file_has_pptx_signature", lambda _path: True)
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
    assert credit_store.docs('users')['pptx-u1']['slides_credits'] == 0
    assert len(credit_store.docs('credit_charges')) == 1
    assert len(credit_store.queued) == 1
    assert credit_store.docs(core.RUNTIME_JOBS_COLLECTION)[body['job_id']]['billing_receipt']['charged'] == {'slides_credits': 1}


@pytest.mark.parametrize("mode", ["lecture-notes", "slides-only", "interview"])
def test_upload_requires_study_pack_title_for_processing_modes(allow_account_writes, client, monkeypatch, mode):
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
    expected_label = "Interview Title / Name" if mode == "interview" else "Lecture Topic / Name"
    assert response.get_json()["error"] == f"{expected_label} is required."
    assert len(released) == 1
    assert released[0][0] == "title-u1"


def test_upload_missing_credits_releases_daily_quota_reservation(allow_account_writes, client, monkeypatch):
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


def test_file_has_pptx_signature_detects_valid_archive(tmp_path):
    valid_path = tmp_path / "slides.pptx"
    with zipfile.ZipFile(valid_path, "w") as archive:
        archive.writestr("[Content_Types].xml", "<Types></Types>")
        archive.writestr("ppt/presentation.xml", "<presentation></presentation>")
    assert core.file_has_pptx_signature(str(valid_path)) is True

    invalid_path = tmp_path / "invalid.pptx"
    invalid_path.write_bytes(b"not-a-pptx")
    assert core.file_has_pptx_signature(str(invalid_path)) is False


def test_upload_requires_auth(client):
    response = client.post("/upload", data={"mode": "slides-only"})
    assert response.status_code == 401
