import io
import zipfile
from pathlib import Path
from types import SimpleNamespace

import pytest
from werkzeug.datastructures import MultiDict

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.ai.providers.fake import FakeGeminiClient
from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.rate_limit import quotas as rate_limit_quotas
from lecture_processor.domains.upload import import_audio as upload_import_audio
from lecture_processor.runtime.job_dispatcher import JobQueueFullError
from lecture_processor.services import tools_download_service
from tests.launch.support import _install_dispatch_credit_store
from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures("disable_sentry")


def test_tools_lecture_download_returns_zip_for_both_formats(client, monkeypatch, tmp_path):
    video_path = tmp_path / "lecture.mp4"
    audio_path = tmp_path / "lecture.mp3"
    video_path.write_bytes(b"video-bytes")
    audio_path.write_bytes(b"ID3\x03\x00\x00\x00")
    expected_download_bytes = video_path.stat().st_size + audio_path.stat().st_size
    quota_reservation = SimpleNamespace()
    reserved = []
    adjusted = []
    committed = []

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tool-dl-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(
        upload_import_audio,
        "validate_video_import_fetch_target",
        lambda _url, runtime=None: ("https://ovp.kaltura.com/path/index.m3u8", ""),
    )
    monkeypatch.setattr(core, "get_saved_file_size", lambda path: Path(path).stat().st_size)
    monkeypatch.setattr(core, "file_looks_like_audio", lambda _path: True)
    monkeypatch.setattr(core, "UPLOAD_FOLDER", str(tmp_path))
    monkeypatch.setattr(core, "submit_background_job", lambda target, *args, **kwargs: target(*args, **kwargs))
    monkeypatch.setattr(rate_limit_quotas, "has_sufficient_upload_disk_space", lambda *_args, **_kwargs: (True, 10**12, 0))

    def download_video(_target, prefix):
        path = tmp_path / f"{prefix}.mp4"
        path.write_bytes(video_path.read_bytes())
        return str(path), path.name, path.stat().st_size

    def convert_audio(path):
        converted = Path(path).with_suffix('.mp3')
        converted.write_bytes(audio_path.read_bytes())
        return str(converted), True

    monkeypatch.setattr(core, "download_video_from_video_url", download_video)
    monkeypatch.setattr(core, "convert_audio_to_mp3_with_ytdlp", convert_audio)
    monkeypatch.setattr(
        tools_download_service.upload_quota_service,
        "reserve_upload_quota",
        lambda _app_ctx, uid, requested_bytes, **kwargs: reserved.append(
            (uid, requested_bytes, kwargs.get("context"), kwargs.get("analytics_limit_name"))
        ) or (quota_reservation, None, 0),
    )
    monkeypatch.setattr(
        tools_download_service.upload_quota_service,
        "adjust_reserved_upload_bytes",
        lambda _app_ctx, reservation, actual_bytes, **kwargs: adjusted.append(
            (reservation, actual_bytes, kwargs.get("context"), kwargs.get("analytics_limit_name"))
        ) or (None, 0),
    )
    monkeypatch.setattr(
        tools_download_service.upload_quota_service,
        "commit_upload_quota",
        lambda reservation: committed.append(reservation),
    )

    response = client.post(
        "/api/tools/lecture-download",
        json={"url": "https://ovp.kaltura.com/path/index.m3u8", "format": "both"},
        headers={"Authorization": "Bearer dev", "Accept": "application/json"},
    )

    assert response.status_code == 202
    job_id = response.get_json()['job_id']
    ready = client.get(f'/api/tools/lecture-download/{job_id}', headers={"Authorization": "Bearer dev"}).get_json()
    assert ready['status'] == 'complete'
    response = client.get(f'/api/tools/lecture-download/{job_id}/file',
                          headers={"Authorization": "Bearer dev", "X-Lecture-Download-Token": ready['download_token']})
    assert response.status_code == 200
    assert response.mimetype == "application/zip"
    archive = zipfile.ZipFile(io.BytesIO(response.data))
    assert sorted(archive.namelist()) == ["lecture-audio.mp3", "lecture-video.mp4"]
    assert all(entry.compress_type == zipfile.ZIP_STORED for entry in archive.infolist())
    assert archive.read("lecture-video.mp4") == b"video-bytes"
    assert archive.read("lecture-audio.mp3") == b"ID3\x03\x00\x00\x00"
    assert reserved == [("tool-dl-u1", core.MAX_AUDIO_UPLOAD_BYTES * 2, "Lecture media download", "lecture_download")]
    assert adjusted == [(quota_reservation, expected_download_bytes, "Lecture media download", "lecture_download")]
    assert committed == [quota_reservation]


def test_tools_lecture_download_rate_limited_returns_retry_after(client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tool-dl-limited", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (False, 19))
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post(
        "/api/tools/lecture-download",
        json={"url": "https://ovp.kaltura.com/path/index.m3u8", "format": "audio"},
        headers={"Authorization": "Bearer dev", "Accept": "application/json"},
    )

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "19"
    assert response.get_json()["retry_after_seconds"] == 19
    assert captured == [("lecture_download", 19)]


def test_tools_lecture_download_checks_quota_before_fetch(client, monkeypatch):
    reserve_calls = []

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tool-dl-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(
        upload_import_audio,
        "validate_video_import_fetch_target",
        lambda _url, runtime=None: ("https://ovp.kaltura.com/path/index.m3u8", ""),
    )
    monkeypatch.setattr(
        tools_download_service.upload_quota_service,
        "reserve_upload_quota",
        lambda app_ctx, uid, requested_bytes, **kwargs: reserve_calls.append(
            (uid, requested_bytes, kwargs.get("context"), kwargs.get("analytics_limit_name"))
        )
        or (None, app_ctx.jsonify({"error": "quota reached"}), 429),
    )
    monkeypatch.setattr(
        core,
        "download_audio_from_video_url",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("download should not start after quota rejection")),
    )

    response = client.post(
        "/api/tools/lecture-download",
        json={"url": "https://ovp.kaltura.com/path/index.m3u8", "format": "audio"},
        headers={"Authorization": "Bearer dev", "Accept": "application/json"},
    )

    assert response.status_code == 429
    assert response.get_json()["error"] == "quota reached"
    assert reserve_calls == [("tool-dl-u2", core.MAX_AUDIO_UPLOAD_BYTES, "Lecture media download", "lecture_download")]


def test_tools_extract_image_rejects_more_than_five_files(allow_account_writes, client, monkeypatch):
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


def test_tools_extract_image_accepts_five_files_bills_once_and_returns_output_text(allow_account_writes, client, monkeypatch):
    log_calls = []
    cleanup_calls = []

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tools-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    credit_store = _install_dispatch_credit_store(monkeypatch, 'tools-u2', {"slides_credits": 9})
    monkeypatch.setattr(core, "allowed_file", lambda _filename, _allowed: True)
    monkeypatch.setattr(core, "get_saved_file_size", lambda _path: 4096)
    monkeypatch.setattr(core, "get_mime_type", lambda _path: "image/png")
    monkeypatch.setattr(core, "cleanup_files", lambda local_paths, remote_files: cleanup_calls.append((list(local_paths), list(remote_files))))
    monkeypatch.setattr(core, "save_job_log", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(analytics_events, "log_analytics_event", lambda *_args, **_kwargs: log_calls.append(True) or True)

    monkeypatch.setattr(
        ai_provider,
        "run_with_provider_retry",
        lambda _name, fn, retry_tracker=None, runtime=None: fn(),
    )
    # The workflow session owns uploads and generation through the local fake client.
    fake_client = FakeGeminiClient({"models.generate_content": [
        SimpleNamespace(text="Combined image extraction output", usage_metadata=None),
    ]})
    monkeypatch.setattr(core, "client", fake_client)
    monkeypatch.setattr(core, "submit_background_job", lambda target, *args, **kwargs: target(*args, **kwargs))

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

    assert response.status_code == 202
    payload = response.get_json()
    assert payload["ok"] is True
    assert payload["status"] == "queued"
    job_id = payload["job_id"]

    status_response = client.get(
        f"/status/{job_id}",
        headers={"Authorization": "Bearer dev"},
    )

    assert status_response.status_code == 200
    status_payload = status_response.get_json()
    assert status_payload["status"] == "complete"
    assert status_payload["source_type"] == "image"
    assert status_payload["output_text"] == "Combined image extraction output"
    assert status_payload["content_markdown"] == "Combined image extraction output"
    assert status_payload["result"] == "Combined image extraction output"
    assert payload["ok"] is True
    assert credit_store.docs('users')['tools-u2']['slides_credits'] == 8
    assert credit_store.docs('users')['tools-u2']['total_processed'] == 1
    assert len(credit_store.docs('credit_charges')) == 1
    assert status_payload['billing_receipt']['charged'] == {'slides_credits': 1}
    assert log_calls
    assert cleanup_calls
    assert fake_client.calls.count("files.upload") == 5
    assert fake_client.calls.count("models.generate_content") == 1
    assert fake_client.calls.count("files.delete") == 5


def test_tools_transcribe_audio_uses_interview_credit_and_returns_transcript(client, monkeypatch):
    cleanup_calls = []

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tools-tr-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    credit_store = _install_dispatch_credit_store(monkeypatch, 'tools-tr-u1', {
        "email": "user@gmail.com",
        "interview_credits_short": 1,
        "interview_credits_medium": 0,
        "interview_credits_long": 0,
        "preferred_output_language": "dutch",
        "preferred_output_language_custom": "",
    })
    monkeypatch.setattr(core, "allowed_file", lambda _filename, _allowed: True)
    monkeypatch.setattr(core, "get_saved_file_size", lambda _path: 4096)
    monkeypatch.setattr(core, "file_looks_like_audio", lambda _path: True)
    monkeypatch.setattr(core, "cleanup_files", lambda local_paths, remote_files: cleanup_calls.append((list(local_paths), list(remote_files))))
    monkeypatch.setattr(core, "save_job_log", lambda *_args, **_kwargs: True)

    # The workflow session uploads through the local fake client.
    monkeypatch.setattr(core, "client", FakeGeminiClient())
    monkeypatch.setattr(core, "convert_audio_to_mp3_with_ytdlp", lambda path: (path, False))
    monkeypatch.setattr(core, "get_mime_type", lambda _path: "audio/mpeg")
    monkeypatch.setattr(
        core,
        "transcribe_audio_plain",
        lambda _audio_file, _audio_mime_type, output_language="English", retry_tracker=None, include_usage=False, **_kwargs: (
            ("Transcript in " + str(output_language), {"input_tokens": 11, "output_tokens": 7, "total_tokens": 18})
            if include_usage else ("Transcript in " + str(output_language))
        ),
    )
    monkeypatch.setattr(core, "submit_background_job", lambda target, *args, **kwargs: target(*args, **kwargs))

    response = client.post(
        "/api/tools/transcribe",
        data={"audio": (io.BytesIO(b"ID3\x03\x00\x00\x00"), "lecture.mp3", "audio/mpeg")},
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 202
    payload = response.get_json()
    assert payload["ok"] is True
    job_id = payload["job_id"]

    status_response = client.get(
        f"/status/{job_id}",
        headers={"Authorization": "Bearer dev"},
    )

    assert status_response.status_code == 200
    status_payload = status_response.get_json()
    assert status_payload["status"] == "complete"
    assert status_payload["output_text"] == "Transcript in Dutch"
    assert status_payload["billing_receipt"]["charged"]["interview_credits_short"] == 1
    assert cleanup_calls
    assert credit_store.docs('users')['tools-tr-u1']['interview_credits_short'] == 0
    assert credit_store.docs('users')['tools-tr-u1']['total_processed'] == 1
    assert len(credit_store.docs('credit_charges')) == 1


def test_tools_transcribe_rejects_low_disk_before_saving_audio(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tools-lowdisk", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(rate_limit_quotas, "has_sufficient_upload_disk_space", lambda _bytes=0, runtime=None: (False, 100, 200))

    response = client.post(
        "/api/tools/transcribe",
        data={"audio": (io.BytesIO(b"ID3\x03\x00\x00\x00"), "lecture.mp3", "audio/mpeg")},
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 503
    assert "storage" in response.get_json()["error"].lower()


def test_tools_transcribe_rejects_when_user_has_too_many_active_jobs(client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tools-busy", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: core.MAX_ACTIVE_JOBS_PER_USER)
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)
    monkeypatch.setattr(
        rate_limiter,
        "check_rate_limit",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("rate limit should not run after active job cap")),
    )

    response = client.post(
        "/api/tools/transcribe",
        data={"audio": (io.BytesIO(b"ID3\x03\x00\x00\x00"), "lecture.mp3", "audio/mpeg")},
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 429
    assert "active processing job" in response.get_json()["error"]
    assert captured == [("tools_transcribe", 10)]


def test_tools_transcribe_rate_limited_returns_retry_after(client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tools-tr-limited", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (False, 27))
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post(
        "/api/tools/transcribe",
        data={"audio": (io.BytesIO(b"ID3\x03\x00\x00\x00"), "lecture.mp3", "audio/mpeg")},
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "27"
    assert response.get_json()["retry_after_seconds"] == 27
    assert captured == [("tools_transcribe", 27)]


def test_voice_note_rate_limited_returns_retry_after(client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "voice-limited", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (False, 31))
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)

    response = client.post(
        "/api/voice-notes",
        data={"audio": (io.BytesIO(b"ID3\x03\x00\x00\x00"), "voice.webm", "audio/webm")},
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 429
    assert response.headers.get("Retry-After") == "31"
    assert response.get_json()["retry_after_seconds"] == 31
    assert captured == [("voice_notes", 31)]


def test_voice_note_active_jobs_returns_429(client, monkeypatch):
    captured = []
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "voice-busy", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: core.MAX_ACTIVE_JOBS_PER_USER)
    monkeypatch.setattr(analytics_events, "log_rate_limit_hit", lambda name, retry, runtime=None: captured.append((name, retry)) or True)
    monkeypatch.setattr(
        rate_limiter,
        "check_rate_limit",
        lambda **_kwargs: (_ for _ in ()).throw(AssertionError("rate limit should not run after active job cap")),
    )

    response = client.post(
        "/api/voice-notes",
        data={"audio": (io.BytesIO(b"ID3\x03\x00\x00\x00"), "voice.webm", "audio/webm")},
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 429
    assert "active processing job" in response.get_json()["error"]
    assert captured == [("voice_notes", 10)]


def test_tools_transcribe_audio_allows_per_run_output_language_override(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "tools-tr-u2", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    credit_store = _install_dispatch_credit_store(monkeypatch, 'tools-tr-u2', {
        "email": "user@gmail.com",
        "interview_credits_short": 1,
        "interview_credits_medium": 0,
        "interview_credits_long": 0,
        "preferred_output_language": "english",
        "preferred_output_language_custom": "",
    })
    monkeypatch.setattr(core, "allowed_file", lambda _filename, _allowed: True)
    monkeypatch.setattr(core, "get_saved_file_size", lambda _path: 4096)
    monkeypatch.setattr(core, "file_looks_like_audio", lambda _path: True)
    monkeypatch.setattr(core, "cleanup_files", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(core, "save_job_log", lambda *_args, **_kwargs: True)

    # The workflow session uploads through the local fake client.
    monkeypatch.setattr(core, "client", FakeGeminiClient())
    monkeypatch.setattr(core, "convert_audio_to_mp3_with_ytdlp", lambda path: (path, False))
    monkeypatch.setattr(core, "get_mime_type", lambda _path: "audio/mpeg")
    monkeypatch.setattr(
        core,
        "transcribe_audio_plain",
        lambda _audio_file, _audio_mime_type, output_language="English", retry_tracker=None, include_usage=False, **_kwargs: (
            ("Transcript in " + str(output_language), {"input_tokens": 11, "output_tokens": 7, "total_tokens": 18})
            if include_usage else ("Transcript in " + str(output_language))
        ),
    )
    monkeypatch.setattr(core, "submit_background_job", lambda target, *args, **kwargs: target(*args, **kwargs))

    response = client.post(
        "/api/tools/transcribe",
        data={
            "output_language": "other",
            "output_language_custom": "Italian",
            "audio": (io.BytesIO(b"ID3\x03\x00\x00\x00"), "lecture.mp3", "audio/mpeg"),
        },
        content_type="multipart/form-data",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 202
    payload = response.get_json()
    assert payload["ok"] is True

    status_response = client.get(
        f"/status/{payload['job_id']}",
        headers={"Authorization": "Bearer dev"},
    )

    assert status_response.status_code == 200
    status_payload = status_response.get_json()
    assert status_payload["status"] == "complete"
    assert status_payload["output_text"] == "Transcript in Italian"
    assert credit_store.docs('users')['tools-tr-u2']['interview_credits_short'] == 0
    assert len(credit_store.docs('credit_charges')) == 1
    assert status_payload['billing_receipt']['charged'] == {'interview_credits_short': 1}


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
    # The workflow session uploads through the local fake client; every generation returns this text.
    fake_client = FakeGeminiClient()
    generations = []
    fake_client.models.generate_content = lambda **kwargs: generations.append(kwargs) or SimpleNamespace(
        text="Interview transcript output", usage_metadata=None)

    saved = []
    audio_path = tmp_path / "interview.wav"
    audio_path.write_bytes(b"RIFF0000WAVEfmt ")

    monkeypatch.setattr(core, "client", fake_client)
    monkeypatch.setattr(core, "convert_audio_to_mp3_with_ytdlp", lambda path: (str(path), False))
    monkeypatch.setattr(core, "persist_audio_for_study_pack", lambda _job_id, _path: "/tmp/persisted.mp3")
    monkeypatch.setattr(core, "get_mime_type", lambda _path: "audio/mpeg")
    monkeypatch.setattr(core, "save_study_pack", lambda job_id, _job: saved.append(job_id) or True)
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
    # One upload, transcription plus the summary extra, and the upload deleted once at close.
    assert fake_client.calls.count("files.upload") == 1
    assert len(generations) == 2
    assert fake_client.calls.count("files.delete") == 1


@pytest.mark.parametrize(
    ("raised_error", "expected_status", "expected_payload_status"),
    [
        (JobQueueFullError("queue full"), 503, "queue_full"),
        (RuntimeError("dispatch failed"), 500, "setup_failed"),
    ],
)
def test_voice_note_study_tools_dispatch_failure_refunds_study_credit(
    client,
    monkeypatch,
    raised_error,
    expected_status,
    expected_payload_status,
):
    credit_store = _install_dispatch_credit_store(monkeypatch, 'voice-u1', {"slides_credits": 1})

    class _FakePackDoc:
        exists = True

        def to_dict(self):
            return {
                "uid": "voice-u1",
                "title": "Voice lecture",
                "output_language": "English",
            }

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "voice-u1", "email": "user@gmail.com"})
    monkeypatch.setattr(core, "is_email_allowed", lambda _email: True)
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _FakePackDoc())

    def _raise_on_submit(*_args, **_kwargs):
        raise raised_error

    monkeypatch.setattr(core, "submit_background_job", _raise_on_submit)

    response = client.post(
        "/api/voice-notes/pack-voice/study-tools",
        json={"study_features": "both"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == expected_status
    body = response.get_json()
    assert body["status"] == expected_payload_status
    job = core.jobs[body["job_id"]]
    assert job["status"] == "error"
    assert job["credit_refunded"] is True
    assert job["extra_slides_refunded"] == 1
    assert job["billing_receipt"]["charged"] == {"slides_credits": 1}
    assert job["billing_receipt"]["refunded"] == {"slides_credits": 1}
    assert credit_store.docs('users')['voice-u1']['slides_credits'] == 1
    assert credit_store.docs('users')['voice-u1']['total_processed'] == 0
    assert len(credit_store.docs('credit_charges')) == 1
    assert len(credit_store.docs('credit_refunds')) == 1
    journal = next(iter(credit_store.docs('credit_charges').values()))
    assert journal['charged_credits'] == 1
    assert journal['refunded_credits'] == 1
    assert journal['components']['extras']['refunded_credits'] == 1
