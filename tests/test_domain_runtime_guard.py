from pathlib import Path


def test_domain_modules_do_not_import_runtime_core_module():
    paths = sorted(Path("lecture_processor/domains").rglob("*.py"))
    for path in paths:
        text = path.read_text(encoding="utf-8")
        assert "from lecture_processor.runtime import core" not in text
        assert "lecture_processor.runtime.core" not in text
        assert "from lecture_processor.services" not in text
        assert "import lecture_processor.services" not in text
