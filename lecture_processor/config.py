import os
from dataclasses import dataclass


@dataclass(frozen=True)
class AppConfig:
    """Minimal central config object for the modular app layout."""

    flask_secret_key: str = os.getenv('FLASK_SECRET_KEY', '')
    log_level: str = (os.getenv('LOG_LEVEL', 'INFO') or 'INFO').strip().upper()
    sentry_environment: str = (os.getenv('SENTRY_ENVIRONMENT', os.getenv('FLASK_ENV', 'production')) or 'production').strip()
    sentry_release: str = (os.getenv('SENTRY_RELEASE', 'lecture-processor') or 'lecture-processor').strip()


def load_config() -> AppConfig:
    return AppConfig()
