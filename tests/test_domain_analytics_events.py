import re

from lecture_processor.domains.analytics import events
from lecture_processor.services import analytics_service
from lecture_processor.runtime.container import get_runtime


def test_analytics_events_use_runtime_analytics_service():
    calls = {}

    class _AnalyticsService:
        @staticmethod
        def sanitize_event_name(value, **kwargs):
            calls['sanitize_event_name'] = kwargs
            return f"event:{value}"

        @staticmethod
        def sanitize_session_id(value, **kwargs):
            calls['sanitize_session_id'] = kwargs
            return f"session:{value}"

        @staticmethod
        def sanitize_properties(props, **kwargs):
            calls['sanitize_properties'] = kwargs
            return {"wrapped": props}

        @staticmethod
        def log_analytics_event(event_name, **kwargs):
            calls['log_analytics_event'] = kwargs
            return {"event": event_name}

        @staticmethod
        def log_rate_limit_hit(limit_name, **kwargs):
            calls['log_rate_limit_hit'] = kwargs
            return f"rl:{limit_name}"

    class _Runtime:
        analytics_service = _AnalyticsService()
        ANALYTICS_NAME_RE = object()
        ANALYTICS_ALLOWED_EVENTS = {'a'}
        ANALYTICS_SESSION_ID_RE = object()
        db = object()
        logger = object()
        time = object()

    runtime = _Runtime()
    assert events.sanitize_analytics_event_name("auth_success", runtime=runtime) == "event:auth_success"
    assert events.sanitize_analytics_session_id("abc123", runtime=runtime) == "session:abc123"
    assert events.sanitize_analytics_properties({"a": 1}, runtime=runtime) == {"wrapped": {"a": 1}}
    assert events.log_analytics_event("checkout_started", uid="u1", runtime=runtime) == {"event": "checkout_started"}
    assert events.log_rate_limit_hit("upload", 5, runtime=runtime) == "rl:upload"
    assert 'name_re' in calls['sanitize_event_name']
    assert calls['log_analytics_event']['uid'] == 'u1'
    assert calls['log_rate_limit_hit']['retry_after'] == 5


def test_analytics_events_use_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.analytics_service, "sanitize_event_name", lambda value, **_kwargs: f"san:{value}")
    monkeypatch.setattr(runtime.analytics_service, "log_rate_limit_hit", lambda name, **kwargs: (name, kwargs.get('retry_after')))

    with app.app_context():
        assert events.sanitize_analytics_event_name("processing_completed") == "san:processing_completed"
        assert events.log_rate_limit_hit("tools", 11) == ("tools", 11)


def test_analytics_payloads_include_ttl_fields():
    added_events = []
    added_limits = []
    rollups = []

    class _Time:
        @staticmethod
        def time():
            return 100.0

    class _Runtime:
        TELEMETRY_RETENTION_SECONDS = 200

    original_add_event = analytics_service.analytics_repo.add_event
    original_add_rate_limit = analytics_service.analytics_repo.add_rate_limit_log
    original_analytics_rollup = analytics_service.admin_rollups.increment_analytics_rollups
    original_rate_limit_rollup = analytics_service.admin_rollups.increment_rate_limit_rollups
    try:
        analytics_service.analytics_repo.add_event = lambda _db, payload: added_events.append(payload)
        analytics_service.analytics_repo.add_rate_limit_log = lambda _db, payload: added_limits.append(payload)
        analytics_service.admin_rollups.increment_analytics_rollups = lambda payload, runtime=None: rollups.append(('event', payload))
        analytics_service.admin_rollups.increment_rate_limit_rollups = lambda payload, runtime=None: rollups.append(('limit', payload))

        assert analytics_service.log_analytics_event(
            "auth_success",
            db=object(),
            name_re=re.compile(r'^[a-z_]+$'),
            session_id_re=re.compile(r'^[a-z0-9]+$'),
            allowed_events={"auth_success"},
            logger=None,
            time_module=_Time,
            runtime=_Runtime(),
        ) is True
        assert analytics_service.log_rate_limit_hit(
            "upload",
            3,
            db=object(),
            logger=None,
            time_module=_Time,
            runtime=_Runtime(),
        ) is True
        for limit_name in (
            "physio_transcription",
            "voice_notes",
            "audio_import",
            "lecture_download",
            "tools_transcribe",
            "verify_email",
        ):
            assert analytics_service.log_rate_limit_hit(
                limit_name,
                4,
                db=object(),
                logger=None,
                time_module=_Time,
                runtime=_Runtime(),
            ) is True
        assert analytics_service.log_rate_limit_hit(
            "not_a_real_limit",
            4,
            db=object(),
            logger=None,
            time_module=_Time,
            runtime=_Runtime(),
        ) is False
    finally:
        analytics_service.analytics_repo.add_event = original_add_event
        analytics_service.analytics_repo.add_rate_limit_log = original_add_rate_limit
        analytics_service.admin_rollups.increment_analytics_rollups = original_analytics_rollup
        analytics_service.admin_rollups.increment_rate_limit_rollups = original_rate_limit_rollup

    assert added_events[0]["expires_at"] == 100.0 + 24 * 60 * 60
    assert added_events[0]["expires_at_ts"].timestamp() == added_events[0]["expires_at"]
    assert added_limits[0]["expires_at"] == 100.0 + 24 * 60 * 60
    assert added_limits[0]["expires_at_ts"].timestamp() == added_limits[0]["expires_at"]
    assert [payload["limit_name"] for payload in added_limits] == [
        "upload",
        "physio_transcription",
        "voice_notes",
        "audio_import",
        "lecture_download",
        "tools_transcribe",
        "verify_email",
    ]
