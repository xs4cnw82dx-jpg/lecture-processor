from lecture_processor.domains.analytics import events
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
