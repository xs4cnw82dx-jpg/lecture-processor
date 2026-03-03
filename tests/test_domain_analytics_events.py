from lecture_processor.domains.analytics import events
from lecture_processor.runtime.container import get_runtime


def test_analytics_dispatch_uses_explicit_runtime():
    class _Runtime:
        def sanitize_analytics_event_name(self, value):
            return f"event:{value}"

        def sanitize_analytics_session_id(self, value):
            return f"session:{value}"

        def sanitize_analytics_properties(self, props):
            return {"wrapped": props}

        def log_analytics_event(self, event_name, **kwargs):
            return {"event": event_name, "kwargs": kwargs}

        def log_rate_limit_hit(self, name, retry_after):
            return f"rl:{name}:{retry_after}"

    runtime = _Runtime()
    assert events.sanitize_analytics_event_name("auth_success", runtime=runtime) == "event:auth_success"
    assert events.sanitize_analytics_session_id("abc123", runtime=runtime) == "session:abc123"
    assert events.sanitize_analytics_properties({"a": 1}, runtime=runtime) == {"wrapped": {"a": 1}}
    assert events.log_analytics_event("checkout_started", uid="u1", runtime=runtime) == {
        "event": "checkout_started",
        "kwargs": {"uid": "u1"},
    }
    assert events.log_rate_limit_hit("upload", 5, runtime=runtime) == "rl:upload:5"


def test_analytics_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "sanitize_analytics_event_name", lambda value: f"san:{value}")
    monkeypatch.setattr(runtime.core, "log_rate_limit_hit", lambda name, retry_after: (name, retry_after))

    with app.app_context():
        assert events.sanitize_analytics_event_name("processing_completed") == "san:processing_completed"
        assert events.log_rate_limit_hit("tools", 11) == ("tools", 11)
