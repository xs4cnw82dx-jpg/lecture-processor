from pathlib import Path


def test_auth_policy_domain_does_not_import_runtime_core_module():
    path = Path("lecture_processor/domains/auth/policy.py")
    text = path.read_text(encoding="utf-8")
    assert "from lecture_processor.runtime import core" not in text
    assert "lecture_processor.runtime.core" not in text
