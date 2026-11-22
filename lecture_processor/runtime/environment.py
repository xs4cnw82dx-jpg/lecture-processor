from __future__ import annotations

import os
import time
from pathlib import Path
from urllib.parse import urlparse

DEV_ENV_NAMES = {'development', 'dev', 'local', 'test'}


def env_value(name, default=None, *, environ=None):
    source = os.environ if environ is None else environ
    return source.get(name, default)


def env_text(name: str, default: str = '', *, environ=None) -> str:
    return str(env_value(name, default, environ=environ) or default).strip()


def log_level():
    return env_text('LOG_LEVEL', 'INFO').upper()


def sentry_release():
    return env_text('SENTRY_RELEASE', 'lecture-processor')


def is_truthy(value) -> bool:
    return str(value).strip().lower() in {'1', 'true', 'yes', 'on'}


def env_truthy(name, default='0', *, environ=None, blank_uses_default=True):
    source = os.environ if environ is None else environ
    value = source.get(name, default)
    return is_truthy((value or default) if blank_uses_default else value)


def env_list(name, default='', *, lowercase=False, environ=None):
    source = os.environ if environ is None else environ
    items = (item.strip() for item in source.get(name, default).split(','))
    return tuple((item.lower() if lowercase else item) for item in items if item)


def parse_int(raw, default, minimum=None, maximum=None):
    try:
        value = int(str(raw).strip())
    except (TypeError, ValueError):
        value = int(default)
    if minimum is not None:
        value = max(value, int(minimum))
    if maximum is not None:
        value = min(value, int(maximum))
    return value


def strict_int_env(name, default, *, blank_uses_default=False):
    """Read an integer setting whose startup contract rejects malformed values."""
    value = env_value(name, default)
    return int((value or default) if blank_uses_default else value)


def safe_int_env(name, default=0, minimum=1, maximum=100000, *, environ=None):
    return parse_int(env_text(name, str(default), environ=environ), default, minimum, maximum)


def safe_float_env(name, default=0.0, minimum=None, maximum=None, *, environ=None):
    try:
        value = float(env_text(name, str(default), environ=environ))
    except (TypeError, ValueError):
        value = float(default)
    if minimum is not None:
        value = max(float(minimum), value)
    if maximum is not None:
        value = min(float(maximum), value)
    return value


def sample_rate_env(name, default=0.0, *, environ=None):
    """Keep the caller's fallback on malformed input and bound configured rates."""
    source = os.environ if environ is None else environ
    try:
        value = float(str(source.get(name, default)).strip())
    except (TypeError, ValueError):
        return float(default)
    return min(max(value, 0.0), 1.0)


def _positive_timeout(name, default, *, environ=None, maximum=None):
    value = safe_int_env(name, default, minimum=None, maximum=maximum, environ=environ)
    return value if value > 0 else default


def get_gemini_http_timeout_ms(*, request_thread: bool = False, environ=None) -> int:
    timeout = _positive_timeout('GEMINI_HTTP_TIMEOUT_MS', 600_000, environ=environ)
    if request_thread:
        return min(timeout, _positive_timeout('GEMINI_REQUEST_HTTP_TIMEOUT_MS', 60_000, environ=environ))
    return timeout


def get_openrouter_http_timeout_ms(*, request_thread: bool = False, environ=None) -> int:
    timeout = _positive_timeout('OPENROUTER_HTTP_TIMEOUT_MS', 600_000, maximum=3_600_000, environ=environ)
    if request_thread:
        return min(timeout, _positive_timeout('OPENROUTER_REQUEST_HTTP_TIMEOUT_MS', 60_000, maximum=3_600_000, environ=environ))
    return timeout


def resolve_sentry_environment(*, environ=None) -> str:
    source = os.environ if environ is None else environ
    if env_text('RENDER', environ=source):
        return 'production'
    explicit = str(source.get('SENTRY_ENVIRONMENT') or source.get('APP_ENV') or source.get('ENV') or '').strip()
    return explicit or env_text('FLASK_ENV', 'production', environ=source)


def resolve_runtime_environment(*, default_local='development', environ=None) -> str:
    source = os.environ if environ is None else environ
    if env_text('RENDER', environ=source):
        return 'production'
    return str(source.get('SENTRY_ENVIRONMENT') or source.get('APP_ENV') or source.get('FLASK_ENV')
               or source.get('ENV') or default_local).strip()


def is_forced_fake_provider(*, environ=None) -> bool:
    source = os.environ if environ is None else environ
    forced = env_truthy('LP_FORCE_FAKE_PROVIDER', environ=source)
    if forced and (str(source.get('APP_ENV', '')).strip().lower() != 'test'
                   or str(source.get('SENTRY_ENVIRONMENT', '')).strip().lower() not in {'', 'test'}
                   or any(source.get(name) for name in ('RENDER', 'RENDER_SERVICE_ID', 'RENDER_DEPLOY_ID'))):
        raise RuntimeError('Fake providers require an isolated test environment.')
    return forced


def is_render_environment(*, environ=None) -> bool:
    return bool(
        env_text('RENDER', environ=environ)
        or env_text('RENDER_SERVICE_ID', environ=environ)
        or env_text('RENDER_DEPLOY_ID', environ=environ)
    )


def is_dev_environment(*, environ=None, sentry_environment: str = '') -> bool:
    if is_render_environment(environ=environ):
        return False
    env_value = str(
        env_text('APP_ENV', environ=environ)
        or env_text('FLASK_ENV', environ=environ)
        or str(sentry_environment or '').strip()
    ).strip().lower()
    flask_debug = env_truthy('FLASK_DEBUG', environ=environ)
    return env_value in DEV_ENV_NAMES or flask_debug


def normalize_public_base_url(raw_value: str, *, is_dev_like: bool | None = None, logger=None) -> str:
    """Validate startup configuration, or derive an origin for display when no policy is supplied."""
    candidate = str(raw_value or '').strip()
    if not candidate:
        if is_dev_like is False:
            raise RuntimeError('PUBLIC_BASE_URL must be set in non-development environments.')
        return ''
    parsed = urlparse(candidate)
    scheme = parsed.scheme.lower()
    if is_dev_like is None:
        host = parsed.netloc.strip().lower()
        if scheme in {'http', 'https'} and host and not (parsed.username or parsed.password):
            return f'{scheme}://{host}'.rstrip('/')
        if logger is not None:
            logger.warning('Ignoring invalid PUBLIC_BASE_URL configuration')
        return ''
    if scheme not in {'http', 'https'}:
        raise RuntimeError('PUBLIC_BASE_URL must start with http:// or https://.')
    if not is_dev_like and scheme != 'https':
        raise RuntimeError('PUBLIC_BASE_URL must use https:// in non-development environments.')
    if parsed.username or parsed.password:
        raise RuntimeError('PUBLIC_BASE_URL must not include credentials.')
    if not parsed.netloc:
        raise RuntimeError('PUBLIC_BASE_URL must include a valid host.')
    if parsed.path and parsed.path != '/':
        raise RuntimeError('PUBLIC_BASE_URL must not include a path.')
    return f'{scheme}://{parsed.netloc}'.rstrip('/')


def get_public_base_url(*, environ=None, logger=None, default_dev_url: str = 'http://127.0.0.1:5000') -> str:
    normalized = normalize_public_base_url(env_text('PUBLIC_BASE_URL', environ=environ), logger=logger)
    if normalized:
        return normalized
    runtime_env = resolve_runtime_environment(default_local='development', environ=environ).strip().lower()
    if runtime_env in DEV_ENV_NAMES:
        return default_dev_url
    return ''


def should_use_minified_js_assets(*, environ=None, sentry_environment: str = '') -> bool:
    raw = env_text('USE_MINIFIED_JS_ASSETS', environ=environ).lower()
    if raw:
        return is_truthy(raw)
    return not is_dev_environment(environ=environ, sentry_environment=sentry_environment)


def resolve_js_asset(filename: str, *, project_root_dir: str, environ=None, sentry_environment: str = '') -> str:
    safe_name = str(filename or '').strip()
    if not safe_name.endswith('.js'):
        return safe_name
    if not should_use_minified_js_assets(environ=environ, sentry_environment=sentry_environment):
        return safe_name
    min_name = safe_name[:-3] + '.min.js'
    min_path = Path(str(project_root_dir or '').strip()) / 'static' / min_name
    if min_path.exists():
        return min_name
    return safe_name


def extract_hostname(value: str) -> str:
    candidate = str(value or '').strip()
    if not candidate:
        return ''
    if '://' in candidate:
        try:
            return str(urlparse(candidate).hostname or '').strip().lower()
        except Exception:
            return ''
    return candidate.split('/', 1)[0].split(':', 1)[0].strip().lower()


def resolve_host_status(request_hostname: str, *, render_hostname: str = '', public_hostname: str = '') -> str:
    safe_request = extract_hostname(request_hostname)
    safe_render = extract_hostname(render_hostname)
    safe_public = extract_hostname(public_hostname)
    if not safe_request:
        return 'unknown'
    if safe_public and safe_request == safe_public:
        if safe_render and safe_public != safe_render:
            return 'custom-domain'
        return 'configured-public-host'
    if safe_render and safe_request == safe_render:
        return 'render-default'
    if safe_public or safe_render:
        return 'mismatch'
    return 'unknown'


def build_admin_deployment_info(
    request_host: str = '',
    *,
    environ=None,
    public_base_url: str = '',
    app_boot_ts: float = 0.0,
    now_ts: float | None = None,
):
    request_host = str(request_host or '').strip()
    request_hostname = extract_hostname(request_host)
    render_hostname = env_text('RENDER_EXTERNAL_HOSTNAME', environ=environ).lower()
    public_hostname = extract_hostname(public_base_url)
    render_external_url = env_text('RENDER_EXTERNAL_URL', environ=environ)
    render_service_id = env_text('RENDER_SERVICE_ID', environ=environ)
    render_deploy_id = env_text('RENDER_DEPLOY_ID', environ=environ)
    render_instance_id = env_text('RENDER_INSTANCE_ID', environ=environ)
    render_service_name = env_text('RENDER_SERVICE_NAME', environ=environ)
    render_git_commit = env_text('RENDER_GIT_COMMIT', environ=environ)
    render_git_branch = env_text('RENDER_GIT_BRANCH', environ=environ)
    render_detected = is_render_environment(environ=environ)
    host_matches_render = None
    if render_hostname and request_hostname:
        host_matches_render = request_hostname == render_hostname
    current_ts = time.time() if now_ts is None else float(now_ts)
    return {
        'runtime': 'render' if render_detected else 'local',
        'request_host': request_host,
        'request_hostname': request_hostname,
        'configured_public_hostname': public_hostname,
        'render_external_hostname': render_hostname,
        'render_external_url': render_external_url,
        'host_matches_render': host_matches_render,
        'host_status': resolve_host_status(
            request_hostname,
            render_hostname=render_hostname,
            public_hostname=public_hostname,
        ),
        'service_id': render_service_id,
        'service_name': render_service_name,
        'deploy_id': render_deploy_id,
        'instance_id': render_instance_id,
        'git_branch': render_git_branch,
        'git_commit': render_git_commit,
        'git_commit_short': render_git_commit[:12] if render_git_commit else '',
        'app_boot_ts': app_boot_ts,
        'app_uptime_seconds': max(0, round(current_ts - float(app_boot_ts or 0.0), 1)),
    }


def parse_cors_allowed_origins(*, environ=None):
    raw = env_text('CORS_ALLOWED_ORIGINS', environ=environ)
    if raw:
        origins = [part.strip().lower() for part in raw.split(',') if part.strip()]
        return set(origins)
    return {
        'http://127.0.0.1:5000',
        'http://localhost:5000',
        'http://127.0.0.1:10000',
        'http://localhost:10000',
        'https://lecture-processor.onrender.com',
        'https://lecture-processor-1.onrender.com',
        'https://lectureprocessor.com',
        'https://www.lectureprocessor.com',
    }
