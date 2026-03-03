from pathlib import Path


def test_blueprints_do_not_import_legacy_app():
    blueprint_dir = Path('lecture_processor/blueprints')
    offenders = []
    for path in sorted(blueprint_dir.glob('*.py')):
        text = path.read_text(encoding='utf-8')
        if 'from lecture_processor import legacy_app' in text or 'legacy_app.' in text:
            offenders.append(str(path))
    assert offenders == []
