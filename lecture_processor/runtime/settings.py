from __future__ import annotations

import os
from dataclasses import dataclass

from lecture_processor.config import AppConfig


@dataclass(frozen=True)
class AppSettings:
    """Normalized runtime settings used by the app factory/runtime container."""

    log_level: str
    environment: str
    flask_secret_key: str
    public_base_url: str


def load_runtime_settings(config: AppConfig | None = None) -> AppSettings:
    if config is not None:
        return AppSettings(
            log_level=(str(config.log_level or 'INFO') or 'INFO').strip().upper(),
            environment=(str(config.sentry_environment or '') or 'production').strip().lower(),
            flask_secret_key=(str(config.flask_secret_key or '') or '').strip(),
            public_base_url=(str(config.public_base_url or '') or '').strip(),
        )

    environment = (
        os.getenv('SENTRY_ENVIRONMENT')
        or os.getenv('FLASK_ENV')
        or os.getenv('ENV')
        or ('production' if os.getenv('RENDER') else 'development')
    ).strip().lower()
    return AppSettings(
        log_level=(os.getenv('LOG_LEVEL', 'INFO') or 'INFO').strip().upper(),
        environment=environment,
        flask_secret_key=(os.getenv('FLASK_SECRET_KEY', '') or '').strip(),
        public_base_url=(os.getenv('PUBLIC_BASE_URL', '') or '').strip(),
    )
