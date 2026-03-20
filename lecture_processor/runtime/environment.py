from __future__ import annotations

import os
import time
from pathlib import Path
from urllib.parse import urlparse

from lecture_processor.config import resolve_runtime_environment

DEV_ENV_NAMES = {'development', 'dev', 'local', 'test'}


def _env_get(name: str, default: str = '', *, environ=None) -> str:
    source = os.environ if environ is None else environ
    return str(source.get(name, default) or default).strip()


def is_render_environment(*, environ=None) -> bool:
    return bool(
        _env_get('RENDER', environ=environ)
        or _env_get('RENDER_SERVICE_ID', environ=environ)
        or _env_get('RENDER_DEPLOY_ID', environ=environ)
    )


def is_dev_environment(*, environ=None, sentry_environment: str = '') -> bool:
    if is_render_environment(environ=environ):
        return False
    env_value = str(
        _env_get('APP_ENV', environ=environ)
        or _env_get('FLASK_ENV', environ=environ)
        or str(sentry_environment or '').strip()
    ).strip().lower()
    flask_debug = _env_get('FLASK_DEBUG', '0', environ=environ).lower() in {'1', 'true', 'yes', 'on'}
    return env_value in DEV_ENV_NAMES or flask_debug


def normalize_public_base_url(raw_value: str, *, logger=None) -> str:
    candidate = str(raw_value or '').strip()
    if not candidate:
        return ''
    parsed = urlparse(candidate)
    scheme = str(parsed.scheme or '').strip().lower()
    netloc = str(parsed.netloc or '').strip().lower()
    if scheme in {'http', 'https'} and netloc and (not parsed.username) and (not parsed.password):
        return f'{scheme}://{netloc}'.rstrip('/')
    if logger is not None:
        logger.warning('Ignoring invalid PUBLIC_BASE_URL value: %s', candidate[:120])
    return ''


def get_public_base_url(*, environ=None, logger=None, default_dev_url: str = 'http://127.0.0.1:5000') -> str:
    normalized = normalize_public_base_url(_env_get('PUBLIC_BASE_URL', environ=environ), logger=logger)
    if normalized:
        return normalized
    runtime_env = resolve_runtime_environment(default_local='development').strip().lower()
    if runtime_env in DEV_ENV_NAMES:
        return default_dev_url
    return ''


def should_use_minified_js_assets(*, environ=None, sentry_environment: str = '') -> bool:
    raw = _env_get('USE_MINIFIED_JS_ASSETS', environ=environ).lower()
    if raw:
        return raw in {'1', 'true', 'yes', 'on'}
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
    render_hostname = _env_get('RENDER_EXTERNAL_HOSTNAME', environ=environ).lower()
    public_hostname = extract_hostname(public_base_url)
    render_external_url = _env_get('RENDER_EXTERNAL_URL', environ=environ)
    render_service_id = _env_get('RENDER_SERVICE_ID', environ=environ)
    render_deploy_id = _env_get('RENDER_DEPLOY_ID', environ=environ)
    render_instance_id = _env_get('RENDER_INSTANCE_ID', environ=environ)
    render_service_name = _env_get('RENDER_SERVICE_NAME', environ=environ)
    render_git_commit = _env_get('RENDER_GIT_COMMIT', environ=environ)
    render_git_branch = _env_get('RENDER_GIT_BRANCH', environ=environ)
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
