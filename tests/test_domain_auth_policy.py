from lecture_processor.domains.auth import policy
from lecture_processor.runtime.container import get_runtime


def test_auth_policy_dispatch_uses_explicit_runtime():
    class _Runtime:
        def is_email_allowed(self, email):
            return str(email).endswith("@example.edu")

        def load_email_allowlist_config(self, path):
            return ({path}, [".edu"])

    runtime = _Runtime()
    assert policy.is_email_allowed("student@example.edu", runtime=runtime) is True
    assert policy.is_email_allowed("student@gmail.com", runtime=runtime) is False
    domains, suffixes = policy.load_email_allowlist_config("/tmp/allowed.json", runtime=runtime)
    assert domains == {"/tmp/allowed.json"}
    assert suffixes == [".edu"]


def test_auth_policy_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "is_email_allowed", lambda email: email == "allowed@test.edu")

    with app.app_context():
        assert policy.is_email_allowed("allowed@test.edu") is True
        assert policy.is_email_allowed("blocked@test.edu") is False
