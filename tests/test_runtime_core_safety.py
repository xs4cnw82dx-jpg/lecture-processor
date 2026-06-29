from lecture_processor.domains.admin import metrics as admin_metrics
from lecture_processor.domains.admin import rollups as admin_rollups
from lecture_processor.runtime import core


def test_admin_email_requires_verified_firebase_email(monkeypatch):
    monkeypatch.setattr(core, "ADMIN_UIDS", {"admin-uid"})
    monkeypatch.setattr(core, "ADMIN_EMAILS", {"admin@example.com"})

    assert core.is_admin_user({"uid": "admin-uid", "email": "other@example.com"}) is True
    assert core.is_admin_user({"uid": "not-admin", "email": "admin@example.com"}) is False
    assert core.is_admin_user({"uid": "not-admin", "email": "admin@example.com", "email_verified": False}) is False
    assert core.is_admin_user({"uid": "not-admin", "email": "admin@example.com", "email_verified": True}) is True


def test_tools_analytics_events_are_allowed():
    assert core.sanitize_analytics_event_name("tools_page_opened") == "tools_page_opened"
    assert core.sanitize_analytics_event_name("tools_extract_completed") == "tools_extract_completed"
    assert core.sanitize_analytics_event_name("tools_extract_failed") == "tools_extract_failed"
    assert core.sanitize_analytics_event_name("tools_export_requested") == "tools_export_requested"


def test_safe_env_parsers_fall_back_and_clamp_invalid_values(monkeypatch):
    monkeypatch.setenv("TEST_BAD_INT", "not-a-number")
    monkeypatch.setenv("TEST_LOW_INT", "-10")
    monkeypatch.setenv("TEST_HIGH_FLOAT", "999")

    assert core.safe_int_env("TEST_BAD_INT", 3, minimum=1, maximum=10) == 3
    assert core.safe_int_env("TEST_LOW_INT", 3, minimum=1, maximum=10) == 1
    assert core.safe_float_env("TEST_HIGH_FLOAT", 1.5, minimum=0.2, maximum=10.0) == 10.0


def test_save_job_log_redacts_sensitive_url_and_prompt(app, monkeypatch):
    captured = {}

    monkeypatch.setattr(core.job_logs_repo, "set_job_log", lambda _db, _job_id, payload: captured.update(payload))
    monkeypatch.setattr(admin_rollups, "increment_job_rollups", lambda *_args, **_kwargs: None)
    monkeypatch.setattr(admin_metrics, "add_admin_visibility_flag", lambda payload: payload)
    monkeypatch.setattr(core, "log_analytics_event", lambda *_args, **_kwargs: True)

    with app.app_context():
        core.save_job_log(
            "job-1",
            {
                "started_at": 10,
                "user_id": "u1",
                "user_email": "user@example.com",
                "mode": "tools",
                "source_type": "url",
                "source_url": "https://example.com/private/token?secret=abc#frag",
                "custom_prompt": "Summarize this confidential note",
                "effective_prompt_preview": "Summarize this confidential note with context",
                "status": "complete",
            },
            15,
        )

    assert captured["source_url"] == "https://example.com/[redacted]"
    assert captured["custom_prompt"] == ""
    assert captured["effective_prompt_preview"] == ""
    assert captured["custom_prompt_length"] == len("Summarize this confidential note")
    assert captured["expires_at"] == 15 + core.TELEMETRY_RETENTION_SECONDS
    assert captured["expires_at_ts"].timestamp() == captured["expires_at"]


def test_cleanup_stale_upload_artifacts_preserves_active_and_persisted_files(tmp_path, monkeypatch):
    upload_root = tmp_path / "uploads"
    study_audio_root = upload_root / "study_audio"
    upload_root.mkdir()
    study_audio_root.mkdir()

    stale_file = upload_root / "orphan.pdf"
    fresh_file = upload_root / "fresh.pdf"
    active_job_file = upload_root / "active-job_lecture.mp3"
    active_import_file = upload_root / "pending-import.mp3"
    study_audio_file = study_audio_root / "pack-audio.mp3"
    for path in (stale_file, fresh_file, active_job_file, active_import_file, study_audio_file):
        path.write_bytes(b"data")

    old_time = 1000
    fresh_time = 100000
    for path in (stale_file, active_job_file, active_import_file, study_audio_file):
        path.touch()
        __import__('os').utime(path, (old_time, old_time))
    __import__('os').utime(fresh_file, (fresh_time, fresh_time))

    old_jobs = dict(core.jobs)
    old_tokens = dict(core.AUDIO_IMPORT_TOKENS)
    try:
        core.jobs.clear()
        core.jobs["active-job"] = {"status": "processing"}
        core.AUDIO_IMPORT_TOKENS.clear()
        core.AUDIO_IMPORT_TOKENS["token"] = {"path": str(active_import_file), "expires_at": fresh_time}
        monkeypatch.setattr(core, "UPLOAD_FOLDER", str(upload_root))
        monkeypatch.setattr(core, "STUDY_AUDIO_ROOT", str(study_audio_root))
        monkeypatch.setattr(core.time, "time", lambda: fresh_time)

        result = core.cleanup_stale_upload_artifacts(ttl_seconds=3600)
    finally:
        core.jobs.clear()
        core.jobs.update(old_jobs)
        core.AUDIO_IMPORT_TOKENS.clear()
        core.AUDIO_IMPORT_TOKENS.update(old_tokens)

    assert result["removed_files"] == 1
    assert not stale_file.exists()
    assert fresh_file.exists()
    assert active_job_file.exists()
    assert active_import_file.exists()
    assert study_audio_file.exists()
