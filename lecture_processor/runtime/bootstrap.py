from __future__ import annotations

import json
import logging
import os
import sys
import warnings
from dataclasses import dataclass

from dotenv import load_dotenv


warnings.filterwarnings('ignore', message='urllib3 v2 only supports OpenSSL 1\\.1\\.1\\+.*')


def load_local_environment(*, environ=None) -> None:
    source = os.environ if environ is None else environ
    if not source.get('RENDER'):
        load_dotenv()


def configure_logging(log_level: str):
    safe_level = str(log_level or 'INFO').strip().upper()
    logging.basicConfig(
        level=getattr(logging, safe_level, logging.INFO),
        format='%(asctime)s %(levelname)s %(name)s %(message)s',
    )
    return logging.getLogger('lecture_processor')


def ensure_directory(path: str) -> None:
    os.makedirs(path, exist_ok=True)


def initialize_gemini_client(api_key: str, *, genai_module, logger):
    safe_api_key = str(api_key or '').strip()
    if not safe_api_key:
        logger.warning('⚠️ GEMINI_API_KEY not set; AI processing features are disabled.')
        return None
    try:
        return genai_module.Client(api_key=safe_api_key)
    except Exception as error:
        logger.warning('⚠️ Gemini client disabled: %s', error)
        return None


@dataclass(frozen=True)
class FirebaseInitResult:
    db: object
    init_error: str


def initialize_firebase(
    *,
    logger,
    credentials_module,
    firestore_module,
    firebase_admin_module,
    credentials_env_var: str = 'FIREBASE_CREDENTIALS',
    local_credentials_path: str = 'firebase-credentials.json',
) -> FirebaseInitResult:
    try:
        firebase_creds_raw = str(os.getenv(credentials_env_var, '') or '').strip()
        local_creds_file_exists = os.path.exists(local_credentials_path)
        if local_creds_file_exists:
            logger.warning(
                'Local %s detected. Prefer %s environment variable for safer deployments.',
                local_credentials_path,
                credentials_env_var,
            )
        if firebase_creds_raw:
            credential = credentials_module.Certificate(json.loads(firebase_creds_raw))
        elif local_creds_file_exists:
            credential = credentials_module.Certificate(local_credentials_path)
        else:
            raise ValueError(
                f'{credentials_env_var} is not set and {local_credentials_path} was not found.'
            )
        if not firebase_admin_module._apps:
            firebase_admin_module.initialize_app(credential)
        return FirebaseInitResult(db=firestore_module.client(), init_error='')
    except Exception as error:
        init_error = str(error)
        logger.warning('⚠️ Firebase initialization skipped: %s', init_error)
        return FirebaseInitResult(db=None, init_error=init_error)


def configure_stripe(stripe_module, secret_key: str):
    stripe_module.api_key = str(secret_key or '')
    return stripe_module.api_key


def safe_float_env(name: str, default: float = 0.0, *, environ=None) -> float:
    source = os.environ if environ is None else environ
    raw = str(source.get(name, default)).strip()
    try:
        value = float(raw)
    except Exception:
        return float(default)
    return min(max(value, 0.0), 1.0)


def env_truthy(name: str, default: str = '0', *, environ=None) -> bool:
    source = os.environ if environ is None else environ
    return str(source.get(name, default) or default).strip().lower() in {'1', 'true', 'yes', 'on'}


def should_init_backend_sentry(
    *,
    backend_dsn: str,
    sentry_sdk_module,
    flask_integration,
    capture_local: bool,
    environ=None,
    argv=None,
) -> bool:
    source = os.environ if environ is None else environ
    args = sys.argv if argv is None else argv
    if not (backend_dsn and sentry_sdk_module and flask_integration):
        return False
    if capture_local:
        return True
    if str(source.get('TESTING', source.get('FLASK_TESTING', '0'))).strip().lower() in {'1', 'true', 'yes', 'on'}:
        return False
    if source.get('PYTEST_CURRENT_TEST'):
        return False
    if any('pytest' in str(arg or '').lower() for arg in args):
        return False
    if not source.get('RENDER'):
        return False
    return True


def initialize_backend_sentry(
    *,
    backend_dsn: str,
    sentry_sdk_module,
    flask_integration,
    traces_sample_rate: float,
    environment: str,
    release: str,
) -> None:
    sentry_sdk_module.init(
        dsn=backend_dsn,
        integrations=[flask_integration()],
        traces_sample_rate=traces_sample_rate,
        send_default_pii=False,
        environment=environment,
        release=release,
    )
