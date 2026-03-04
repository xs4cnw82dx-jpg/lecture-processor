import json

from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def load_email_allowlist_config(path, runtime=None):
    try:
        with open(path, 'r', encoding='utf-8') as handle:
            data = json.load(handle)
    except Exception as error:
        raise RuntimeError(f'Could not read allowlist config at {path}: {error}')
    if not isinstance(data, dict):
        raise RuntimeError(f'Allowlist config at {path} must be a JSON object.')

    raw_domains = data.get('domains', [])
    raw_suffixes = data.get('suffixes', [])
    if not isinstance(raw_domains, list) or not isinstance(raw_suffixes, list):
        raise RuntimeError(f"Allowlist config at {path} must contain list values for 'domains' and 'suffixes'.")

    domains = {str(item).strip().lower() for item in raw_domains if str(item).strip()}
    suffixes = [str(item).strip().lower() for item in raw_suffixes if str(item).strip()]
    if not domains:
        raise RuntimeError(f'Allowlist config at {path} has an empty domains list.')
    if not suffixes:
        raise RuntimeError(f'Allowlist config at {path} has an empty suffixes list.')
    return (domains, suffixes)


def is_email_allowed(email, runtime=None):
    if not email:
        return False
    resolved_runtime = _resolve_runtime(runtime)
    allowed_domains = set(getattr(resolved_runtime, 'ALLOWED_EMAIL_DOMAINS', set()) or set())
    allowed_patterns = list(getattr(resolved_runtime, 'ALLOWED_EMAIL_PATTERNS', []) or [])
    email = str(email).lower()
    domain = email.split('@')[-1] if '@' in email else ''
    if domain in allowed_domains:
        return True
    for pattern in allowed_patterns:
        if domain.endswith(pattern):
            return True
    return False
