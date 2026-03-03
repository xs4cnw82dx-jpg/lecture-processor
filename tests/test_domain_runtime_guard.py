from pathlib import Path


def test_auth_domain_modules_do_not_import_runtime_core_module():
    paths = (
        Path("lecture_processor/domains/account/lifecycle.py"),
        Path("lecture_processor/domains/analytics/events.py"),
        Path("lecture_processor/domains/auth/policy.py"),
        Path("lecture_processor/domains/auth/session.py"),
        Path("lecture_processor/domains/billing/credits.py"),
        Path("lecture_processor/domains/billing/purchases.py"),
        Path("lecture_processor/domains/billing/receipts.py"),
        Path("lecture_processor/domains/rate_limit/limiter.py"),
        Path("lecture_processor/domains/rate_limit/quotas.py"),
        Path("lecture_processor/domains/runtime_jobs/recovery.py"),
        Path("lecture_processor/domains/runtime_jobs/store.py"),
        Path("lecture_processor/domains/shared/parsing.py"),
        Path("lecture_processor/domains/upload/import_audio.py"),
    )
    for path in paths:
        text = path.read_text(encoding="utf-8")
        assert "from lecture_processor.runtime import core" not in text
        assert "lecture_processor.runtime.core" not in text
