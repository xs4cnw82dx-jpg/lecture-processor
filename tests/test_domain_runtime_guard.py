from pathlib import Path


def test_auth_domain_modules_do_not_import_runtime_core_module():
    paths = (
        Path("lecture_processor/domains/auth/policy.py"),
        Path("lecture_processor/domains/auth/session.py"),
        Path("lecture_processor/domains/rate_limit/limiter.py"),
    )
    for path in paths:
        text = path.read_text(encoding="utf-8")
        assert "from lecture_processor.runtime import core" not in text
        assert "lecture_processor.runtime.core" not in text
