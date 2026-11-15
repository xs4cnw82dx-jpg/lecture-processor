"""The entrypoint check reaches real bootstrap and reports startup failures."""
from scripts.check_app_startup_isolated import check_startup


def test_production_entrypoint_starts_with_inherited_service_settings_removed(monkeypatch, capfd):
    for name in ('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
                 'FIREBASE_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS',
                 'STRIPE_SECRET_KEY', 'SENTRY_DSN', 'RENDER_SERVICE_ID'):
        monkeypatch.setenv(name, 'synthetic-must-not-be-used')
    monkeypatch.setenv('LP_FORCE_FAKE_PROVIDER', '0')
    monkeypatch.setenv('APP_ENV', 'production')
    assert check_startup() == 0
    captured = capfd.readouterr()
    assert 'Isolated app.py startup passed.' in captured.out
    assert 'synthetic-must-not-be-used' not in captured.out + captured.err


def test_entrypoint_startup_failure_is_not_hidden(tmp_path, capfd):
    (tmp_path / 'app.py').write_text("raise RuntimeError('synthetic-startup-failure')\n")
    assert check_startup(tmp_path) != 0
    captured = capfd.readouterr()
    assert 'synthetic-startup-failure' in captured.err
    assert 'Isolated app.py startup passed.' not in captured.out
