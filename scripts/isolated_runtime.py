"""Provider isolation shared by local test and preview entrypoints."""

import os


def force_isolated_provider_environment():
    for name in ('GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENROUTER_API_KEY',
                 'RENDER', 'RENDER_SERVICE_ID', 'RENDER_DEPLOY_ID'):
        os.environ.pop(name, None)
    os.environ.update({
        'LP_FORCE_FAKE_PROVIDER': '1', 'APP_ENV': 'test', 'SENTRY_ENVIRONMENT': 'test',
    })
