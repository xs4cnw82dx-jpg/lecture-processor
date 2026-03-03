from lecture_processor.domains.auth import session
from lecture_processor.runtime.container import get_runtime


def test_auth_session_dispatch_uses_explicit_runtime():
    class _Runtime:
        def _extract_bearer_token(self, req):
            return f"token:{req}"

        def verify_admin_session_cookie(self, req):
            return {"uid": f"admin:{req}"}

    runtime = _Runtime()
    assert session._extract_bearer_token("request-1", runtime=runtime) == "token:request-1"
    assert session.verify_admin_session_cookie("request-2", runtime=runtime) == {"uid": "admin:request-2"}


def test_auth_session_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "_extract_bearer_token", lambda req: f"bearer:{req}")
    monkeypatch.setattr(runtime.core, "verify_admin_session_cookie", lambda req: {"uid": f"cookie:{req}"})

    with app.app_context():
        assert session._extract_bearer_token("abc") == "bearer:abc"
        assert session.verify_admin_session_cookie("xyz") == {"uid": "cookie:xyz"}
