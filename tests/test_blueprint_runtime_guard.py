from pathlib import Path


def test_blueprints_do_not_import_legacy_or_runtime_core_modules():
    blueprint_dir = Path('lecture_processor/blueprints')
    forbidden_patterns = (
        'from lecture_processor import legacy_app',
        'legacy_app.',
        'from lecture_processor.runtime import core',
        'lecture_processor.runtime.core',
    )
    offenders = []
    for path in sorted(blueprint_dir.glob('*.py')):
        text = path.read_text(encoding='utf-8')
        if any(pattern in text for pattern in forbidden_patterns):
            offenders.append(str(path))
    assert offenders == []
