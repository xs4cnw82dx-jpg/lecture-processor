import pytest

from lecture_processor.config import load_config


def test_load_config_requires_secret_key_in_non_dev(monkeypatch):
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.delenv("FLASK_ENV", raising=False)
    monkeypatch.delenv("SENTRY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("ENV", raising=False)
    monkeypatch.delenv("FLASK_SECRET_KEY", raising=False)

    with pytest.raises(RuntimeError):
        load_config()


def test_load_config_allows_missing_secret_in_dev(monkeypatch):
    monkeypatch.delenv("RENDER", raising=False)
    monkeypatch.setenv("FLASK_ENV", "development")
    monkeypatch.delenv("FLASK_SECRET_KEY", raising=False)

    cfg = load_config()
    assert cfg.flask_secret_key == ""
