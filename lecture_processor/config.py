import os
from dataclasses import dataclass, field, replace
from urllib.parse import urlparse


@dataclass(frozen=True)
class AppConfig:
    """Minimal central config object for the modular app layout."""

    flask_secret_key: str = field(default_factory=lambda: os.getenv('FLASK_SECRET_KEY', ''))
    log_level: str = field(default_factory=lambda: (os.getenv('LOG_LEVEL', 'INFO') or 'INFO').strip().upper())
    sentry_environment: str = field(default_factory=lambda: resolve_sentry_environment())
    sentry_release: str = field(default_factory=lambda: (os.getenv('SENTRY_RELEASE', 'lecture-processor') or 'lecture-processor').strip())
    public_base_url: str = field(default_factory=lambda: (os.getenv('PUBLIC_BASE_URL', '') or '').strip())


def resolve_sentry_environment() -> str:
    if str(os.getenv('RENDER', '') or '').strip():
        return 'production'
    explicit = str(
        os.getenv('SENTRY_ENVIRONMENT')
        or os.getenv('APP_ENV')
        or os.getenv('ENV')
        or ''
    ).strip()
    if explicit:
        return explicit
    if str(os.getenv('RENDER', '') or '').strip():
        return 'production'
    return (os.getenv('FLASK_ENV', 'production') or 'production').strip()


def resolve_runtime_environment(*, default_local: str = 'development') -> str:
    if str(os.getenv('RENDER', '') or '').strip():
        return 'production'
    return str(
        os.getenv('SENTRY_ENVIRONMENT')
        or os.getenv('APP_ENV')
        or os.getenv('FLASK_ENV')
        or os.getenv('ENV')
        or default_local
    ).strip()


def normalize_public_base_url(raw_value: str, *, is_dev_like: bool) -> str:
    candidate = str(raw_value or '').strip()
    if not candidate:
        if is_dev_like:
            return ''
        raise RuntimeError('PUBLIC_BASE_URL must be set in non-development environments.')
    parsed = urlparse(candidate)
    scheme = str(parsed.scheme or '').strip().lower()
    if scheme not in {'http', 'https'}:
        raise RuntimeError('PUBLIC_BASE_URL must start with http:// or https://.')
    if not is_dev_like and scheme != 'https':
        raise RuntimeError('PUBLIC_BASE_URL must use https:// in non-development environments.')
    if parsed.username or parsed.password:
        raise RuntimeError('PUBLIC_BASE_URL must not include credentials.')
    if not parsed.netloc:
        raise RuntimeError('PUBLIC_BASE_URL must include a valid host.')
    if parsed.path and parsed.path not in {'', '/'}:
        raise RuntimeError('PUBLIC_BASE_URL must not include a path.')
    return f"{scheme}://{parsed.netloc}".rstrip('/')


def load_config() -> AppConfig:
    config = AppConfig()
    runtime_env = resolve_runtime_environment(default_local='development').lower()
    is_dev_like = runtime_env in {'development', 'dev', 'local', 'test'}
    if not is_dev_like and not config.flask_secret_key.strip():
        raise RuntimeError('FLASK_SECRET_KEY must be set in non-development environments.')
    normalized_public_base_url = normalize_public_base_url(config.public_base_url, is_dev_like=is_dev_like)
    return replace(config, public_base_url=normalized_public_base_url)
