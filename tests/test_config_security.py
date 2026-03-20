import json
from pathlib import Path

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
    monkeypatch.delenv("PUBLIC_BASE_URL", raising=False)

    cfg = load_config()
    assert cfg.flask_secret_key == ""


def test_load_config_treats_render_as_production_even_when_flask_env_is_development(monkeypatch):
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("FLASK_ENV", "development")
    monkeypatch.setenv("SENTRY_ENVIRONMENT", "development")
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("FLASK_SECRET_KEY", "test-secret")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://example.com")

    cfg = load_config()

    assert cfg.sentry_environment == "production"


def test_load_config_requires_public_base_url_in_non_dev(monkeypatch):
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.delenv("FLASK_ENV", raising=False)
    monkeypatch.delenv("SENTRY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("ENV", raising=False)
    monkeypatch.setenv("FLASK_SECRET_KEY", "test-secret")
    monkeypatch.delenv("PUBLIC_BASE_URL", raising=False)

    with pytest.raises(RuntimeError):
        load_config()


def test_load_config_rejects_non_https_public_base_url_in_non_dev(monkeypatch):
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.delenv("FLASK_ENV", raising=False)
    monkeypatch.delenv("SENTRY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("ENV", raising=False)
    monkeypatch.setenv("FLASK_SECRET_KEY", "test-secret")
    monkeypatch.setenv("PUBLIC_BASE_URL", "http://example.com")

    with pytest.raises(RuntimeError):
        load_config()


def test_load_config_normalizes_public_base_url(monkeypatch):
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.delenv("FLASK_ENV", raising=False)
    monkeypatch.delenv("SENTRY_ENVIRONMENT", raising=False)
    monkeypatch.delenv("ENV", raising=False)
    monkeypatch.setenv("FLASK_SECRET_KEY", "test-secret")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://example.com/")

    cfg = load_config()
    assert cfg.public_base_url == "https://example.com"


def test_functions_allowlist_config_stays_in_sync_with_canonical_file():
    project_root = Path(__file__).resolve().parents[1]
    canonical_path = project_root / "config" / "allowed_email_domains.json"
    functions_path = project_root / "functions" / "allowed_email_domains.json"

    canonical = json.loads(canonical_path.read_text(encoding="utf-8"))
    functions_copy = json.loads(functions_path.read_text(encoding="utf-8"))

    assert functions_copy == canonical
