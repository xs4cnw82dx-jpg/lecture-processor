import pytest

from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures("disable_sentry")


def test_resolve_js_asset_defaults_to_minified_outside_dev(monkeypatch):
    monkeypatch.delenv('USE_MINIFIED_JS_ASSETS', raising=False)
    monkeypatch.setattr(core, 'is_dev_environment', lambda: False)

    assert core.resolve_js_asset('js/reader.js') == 'js/reader.min.js'


def test_resolve_js_asset_can_be_explicitly_disabled(monkeypatch):
    monkeypatch.setenv('USE_MINIFIED_JS_ASSETS', '0')
    monkeypatch.setattr(core, 'is_dev_environment', lambda: False)

    assert core.resolve_js_asset('js/reader.js') == 'js/reader.js'
