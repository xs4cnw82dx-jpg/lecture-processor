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
