from lecture_processor.domains.rate_limit import limiter
from lecture_processor.runtime.container import get_runtime


def test_rate_limit_uses_runtime_service_dependencies():
    captured = {}

    class _RateLimitService:
        @staticmethod
        def check_rate_limit(key, limit, window_seconds, **kwargs):
            captured["kwargs"] = kwargs
            return ("ok", {"key": key, "limit": limit, "window_seconds": window_seconds})

    class _Runtime:
        rate_limit_service = _RateLimitService()
        RATE_LIMIT_FIRESTORE_ENABLED = True
        RATE_LIMIT_COUNTER_COLLECTION = "rate_limit_counters"
        RATE_LIMIT_EVENTS = {}
        RATE_LIMIT_LOCK = object()
        db = object()
        firestore = object()
        time = object()

        @staticmethod
        def jsonify(payload):
            class _Response(dict):
                headers = {}
                status_code = 200
            return _Response(payload)

    runtime = _Runtime()
    status, payload = limiter.check_rate_limit(key="upload:u1", limit=10, window_seconds=60, runtime=runtime)
    assert status == "ok"
    assert payload["key"] == "upload:u1"
    assert payload["limit"] == 10
    assert payload["window_seconds"] == 60
    assert captured["kwargs"]["counter_collection"] == "rate_limit_counters"
    response = limiter.build_rate_limited_response("Too many", 12, runtime=runtime)
    assert response["error"] == "Too many"
    assert response["retry_after_seconds"] == 12
    assert response.status_code == 429
    assert response.headers["Retry-After"] == "12"
    assert limiter.normalize_rate_limit_key_part("u 1", fallback="x", runtime=runtime) == "u_1"


def test_rate_limit_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.rate_limit_service, "check_rate_limit", lambda *_args, **_kwargs: (False, 9))

    with app.app_context():
        assert limiter.check_rate_limit(key="x", limit=1, window_seconds=2) == (False, 9)
        response = limiter.build_rate_limited_response("limited", 9)
        assert response.status_code == 429
        assert response.get_json()["error"] == "limited"
        assert limiter.normalize_rate_limit_key_part("abc", fallback="dev") == "abc"
