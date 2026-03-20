from lecture_processor import create_app
from lecture_processor.runtime.container import get_runtime


def test_create_app_returns_fresh_instances():
    first = create_app()
    second = create_app()

    assert first is not second
    assert first.extensions["lecture_processor"]["factory_initialized"] is True
    assert second.extensions["lecture_processor"]["factory_initialized"] is True
    assert get_runtime(first).app is first
    assert get_runtime(second).app is second


def test_create_app_registers_routes_without_reusing_blueprint_state():
    app = create_app()

    assert "pages" in app.blueprints
    assert "upload_api" in app.blueprints
    assert "/api/tools/extract" in {rule.rule for rule in app.url_map.iter_rules()}
