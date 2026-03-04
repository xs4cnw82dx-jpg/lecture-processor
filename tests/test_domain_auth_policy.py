from lecture_processor.domains.auth import policy
from lecture_processor.runtime.container import get_runtime


def test_auth_policy_uses_runtime_allowlist_values():
    class _Runtime:
        ALLOWED_EMAIL_DOMAINS = {'example.edu'}
        ALLOWED_EMAIL_PATTERNS = ['.school.edu']

    runtime = _Runtime()
    assert policy.is_email_allowed("student@example.edu", runtime=runtime) is True
    assert policy.is_email_allowed("student@dept.school.edu", runtime=runtime) is True
    assert policy.is_email_allowed("student@gmail.com", runtime=runtime) is False


def test_auth_policy_load_allowlist_config(tmp_path):
    allowlist_file = tmp_path / "allowed.json"
    allowlist_file.write_text(
        '{"domains": ["example.edu"], "suffixes": [".school.edu"]}',
        encoding='utf-8',
    )
    domains, suffixes = policy.load_email_allowlist_config(str(allowlist_file))
    assert domains == {"example.edu"}
    assert suffixes == [".school.edu"]


def test_auth_policy_uses_current_app_runtime_values(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "ALLOWED_EMAIL_DOMAINS", {"allowed.test.edu"})
    monkeypatch.setattr(runtime, "ALLOWED_EMAIL_PATTERNS", [".dept.test.edu"])

    with app.app_context():
        assert policy.is_email_allowed("alice@allowed.test.edu") is True
        assert policy.is_email_allowed("alice@math.dept.test.edu") is True
        assert policy.is_email_allowed("blocked@test.edu") is False
