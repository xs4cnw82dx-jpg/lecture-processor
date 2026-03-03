from lecture_processor.domains.rate_limit import limiter
from lecture_processor.runtime.container import get_runtime


def test_rate_limit_dispatch_uses_explicit_runtime():
    class _Runtime:
        def check_rate_limit(self, **kwargs):
            return ("ok", kwargs)

        def build_rate_limited_response(self, message, retry_after):
            return {"message": message, "retry_after": retry_after}

        def normalize_rate_limit_key_part(self, value, fallback="anon"):
            return f"{value}:{fallback}"

    runtime = _Runtime()
    status, payload = limiter.check_rate_limit(key="upload:u1", limit=10, window_seconds=60, runtime=runtime)
    assert status == "ok"
    assert payload["key"] == "upload:u1"
    assert payload["limit"] == 10
    assert payload["window_seconds"] == 60
    assert limiter.build_rate_limited_response("Too many", 12, runtime=runtime) == {
        "message": "Too many",
        "retry_after": 12,
    }
    assert limiter.normalize_rate_limit_key_part("u1", fallback="x", runtime=runtime) == "u1:x"


def test_rate_limit_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "check_rate_limit", lambda **_kwargs: (False, 9))
    monkeypatch.setattr(runtime.core, "build_rate_limited_response", lambda *args, **_kwargs: {"args": args})
    monkeypatch.setattr(runtime.core, "normalize_rate_limit_key_part", lambda value, fallback="anon": f"{value}-{fallback}")

    with app.app_context():
        assert limiter.check_rate_limit(key="x", limit=1, window_seconds=2) == (False, 9)
        assert limiter.build_rate_limited_response("limited", 9) == {"args": ("limited", 9)}
        assert limiter.normalize_rate_limit_key_part("abc", fallback="dev") == "abc-dev"
