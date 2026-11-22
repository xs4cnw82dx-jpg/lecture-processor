from dataclasses import dataclass, field, replace

from lecture_processor.runtime.environment import (
    DEV_ENV_NAMES, env_text, env_value, log_level, normalize_public_base_url,
    resolve_runtime_environment, resolve_sentry_environment, sentry_release,
)


@dataclass(frozen=True)
class AppConfig:
    """Minimal central config object for the modular app layout."""

    flask_secret_key: str = field(default_factory=lambda: env_value('FLASK_SECRET_KEY', ''))
    log_level: str = field(default_factory=log_level)
    sentry_environment: str = field(default_factory=resolve_sentry_environment)
    sentry_release: str = field(default_factory=sentry_release)
    public_base_url: str = field(default_factory=lambda: env_text('PUBLIC_BASE_URL'))


def load_config() -> AppConfig:
    config = AppConfig()
    runtime_env = resolve_runtime_environment(default_local='development').lower()
    is_dev_like = runtime_env in DEV_ENV_NAMES
    if not is_dev_like and not config.flask_secret_key.strip():
        raise RuntimeError('FLASK_SECRET_KEY must be set in non-development environments.')
    normalized_public_base_url = normalize_public_base_url(config.public_base_url, is_dev_like=is_dev_like)
    return replace(config, public_base_url=normalized_public_base_url)
