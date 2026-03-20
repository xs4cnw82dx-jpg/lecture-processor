from lecture_processor.config import AppConfig
from lecture_processor.runtime.settings import load_runtime_settings


def test_load_runtime_settings_uses_config_values_when_provided():
    config = AppConfig(
        flask_secret_key="  test-secret  ",
        log_level="warning",
        sentry_environment="Production",
        public_base_url="https://example.com",
    )

    settings = load_runtime_settings(config=config)

    assert settings.log_level == "WARNING"
    assert settings.environment == "production"
    assert settings.flask_secret_key == "test-secret"
    assert settings.public_base_url == "https://example.com"


def test_load_runtime_settings_falls_back_to_env_without_config(monkeypatch):
    monkeypatch.setenv("LOG_LEVEL", "debug")
    monkeypatch.setenv("SENTRY_ENVIRONMENT", "Staging")
    monkeypatch.setenv("FLASK_SECRET_KEY", "env-secret")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://env.example")

    settings = load_runtime_settings()

    assert settings.log_level == "DEBUG"
    assert settings.environment == "staging"
    assert settings.flask_secret_key == "env-secret"
    assert settings.public_base_url == "https://env.example"


def test_load_runtime_settings_treats_render_as_production_without_explicit_override(monkeypatch):
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("FLASK_ENV", "development")
    monkeypatch.setenv("SENTRY_ENVIRONMENT", "development")
    monkeypatch.setenv("APP_ENV", "development")
    monkeypatch.setenv("ENV", "development")
    monkeypatch.setenv("FLASK_SECRET_KEY", "env-secret")
    monkeypatch.setenv("PUBLIC_BASE_URL", "https://env.example")

    settings = load_runtime_settings()

    assert settings.environment == "production"
