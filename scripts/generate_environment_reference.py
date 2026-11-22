#!/usr/bin/env python3
"""Generate the deployment environment reference from checked-in source."""
import argparse
import ast
import re
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / 'docs/ENVIRONMENT.md'
ENV_READERS = {
    'getenv', 'env_getter', 'env_text', 'env_value', 'env_truthy', 'env_list', 'safe_int_env', 'safe_float_env',
    '_positive_timeout', 'strict_int_env', '_binary',
}
# Settings with contextual defaults or constraints that cannot be read off one call.
NOTES = {
    'APP_ENV': 'Runtime environment override.',
    'BOOK_CHATGPT_URL': 'Defaults to `https://chatgpt.com/`.',
    'BOOK_IMAGE_MAX_MB': '10 MiB, capped at 10.',
    'BOOK_STUDIO_ENABLED': 'Enabled unless set to 0.',
    'CALENDAR_TOKEN_ENCRYPTION_KEYS': 'Comma-separated Fernet keys, newest first.',
    'CALENDAR_WORKER_SERVICE_ACCOUNT': 'Firebase Functions service account for calendar wakeups.',
    'CALENDAR_WORKER_URL': 'HTTPS URL of the calendar worker.',
    'CORS_ALLOWED_ORIGINS': 'Comma-separated origins. Defaults to the local and deployed origins in the linked parser.',
    'ENV': 'Legacy environment name.',
    'FIREBASE_CREDENTIALS': 'Service-account JSON. The local startup path can also read a credentials file.',
    'FLASK_ENV': 'Legacy Flask runtime environment.',
    'FLASK_SECRET_KEY': 'Required outside development.',
    'GEMINI_API_KEY': 'Backend Gemini credential.',
    'GOOGLE_CALENDAR_ENABLED': 'Disabled by default. Accepts 1 or true and requires the calendar credentials.',
    'LECTURE_PROCESSOR_YTDLP_GUARD': 'Internal subprocess configuration set by the downloader.',
    'LIBREOFFICE_BIN': 'Optional binary path. The Docker image sets soffice.',
    'LP_FORCE_FAKE_PROVIDER': 'Defaults off. The isolated test and preview runners set this flag.',
    'OPENAI_CUSTOM_HEADERS': 'Must be unset for the OpenRouter adapter.',
    'OPENROUTER_API_KEY': 'Backend OpenRouter credential.',
    'PHYSIO_CODEX_BINARY': 'Optional companion executable path. The launcher otherwise discovers Codex.',
    'PHYSIO_COMPANION_URL': 'Defaults to `http://127.0.0.1:8765/physio`.',
    'PORT': '5000 for local app.py, 10000 for Gunicorn in Docker.',
    'PUBLIC_BASE_URL': 'HTTPS origin required outside development.',
    'RENDER': 'Platform-provided Render deployment marker.',
    'SENTRY_ENVIRONMENT': 'Defaults to production on Render. Locally checks APP_ENV, ENV, then FLASK_ENV.',
    'TESTING': 'Falls back to FLASK_TESTING when unset.',
    'UNIFIED_CREDITS_ENABLED': 'Defaults to the checked-in billing policy.',
    'USE_MINIFIED_JS_ASSETS': 'Defaults on outside development.',
}


def display_value(node):
    if isinstance(node, ast.Constant):
        return str(node.value) if node.value != '' else 'unset'
    return ast.unparse(node)


def python_reads(path):
    for call in ast.walk(ast.parse(path.read_text())):
        if not isinstance(call, ast.Call) or not call.args:
            continue
        target = ast.unparse(call.func)
        name = target.rsplit('.', 1)[-1]
        source_read = target == 'source.get' and path.parent.name == 'runtime'
        if name not in ENV_READERS and not target.endswith('environ.get') and not source_read:
            continue
        key = call.args[0]
        if not isinstance(key, ast.Constant) or not isinstance(key.value, str) or not re.fullmatch('[A-Z][A-Z0-9_]+', key.value):
            continue
        default = display_value(call.args[1]) if len(call.args) > 1 else 'unset'
        if name == 'env_truthy' and len(call.args) == 1:
            default = '0'
        bounds = {arg.arg: display_value(arg.value) for arg in call.keywords if arg.arg in ('minimum', 'maximum')}
        if bounds:
            default += ' (' + ', '.join(f'{key} {value}' for key, value in bounds.items()) + ')'
        yield key.value, default


def generate():
    sources = defaultdict(dict)
    paths = [ROOT / 'app.py', ROOT / 'scripts/run_physio_companion.py', *sorted((ROOT / 'lecture_processor').rglob('*.py'))]
    for path in paths:
        for key, default in python_reads(path):
            sources[key][path.relative_to(ROOT)] = default
    # The Firebase initializer accepts the variable name as an argument.
    sources['FIREBASE_CREDENTIALS'][Path('lecture_processor/runtime/bootstrap.py')] = 'unset'
    for key, default in re.findall(r'\$\{(\w+):-([^}]+)\}', (ROOT / 'Dockerfile').read_text()):
        sources[key][Path('Dockerfile')] = default
    for path in sorted((ROOT / 'functions').glob('*.js')):
        for key in re.findall(r"defineString\('([A-Z_]+)'\)", path.read_text()):
            sources[key][path.relative_to(ROOT)] = 'unset'
    output = [
        '# Environment reference', '',
        f'The web app, deployment command and local companion read {len(sources)} named settings. '
        'The table lists application defaults. Deployment overrides are in [render.yaml](../render.yaml).', '',
        'Regenerate with `python scripts/generate_environment_reference.py`. '
        'The generator reads checked-in source without loading application configuration.', '',
        'Boolean flags accept `1`, `true`, `yes` and `on`, ignoring case and surrounding whitespace, '
        'unless the entry specifies a different rule. Names ending in `_SECONDS`, `_MS` and `_BYTES` include their units.', '',
        '| Variable | Default or behavior | Used by |', '| --- | --- | --- |',
    ]
    for name, locations in sorted(sources.items()):
        defaults = list(dict.fromkeys(locations.values()))
        description = NOTES.get(name, ' / '.join(f'`{value}`' if value != 'unset' else 'Unset' for value in defaults))
        links = ', '.join(f'[{path.name}](../{path})' for path in sorted(locations))
        output.append(f'| `{name}` | {description} | {links} |')
    return '\n'.join(output) + '\n'


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--check', action='store_true', help='fail if the reference is out of date')
    args = parser.parse_args()
    reference = generate()
    if args.check:
        if not OUTPUT.exists() or OUTPUT.read_text() != reference:
            raise SystemExit('Regenerate docs/ENVIRONMENT.md')
    else:
        OUTPUT.write_text(reference)
