#!/usr/bin/env python3
"""Run the real UI with isolated temporary storage and no production services.

Used by Playwright and manual design previews. Browser tests supply synthetic
API/auth fixtures. This runner never loads .env or local Firebase credentials.
"""

from __future__ import annotations

import argparse
import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch


PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--port', type=int, default=int(os.getenv('PORT', '5123')))
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error('port must be between 1024 and 65535')

    for name in ('RENDER', 'FIREBASE_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS',
                 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'STRIPE_SECRET_KEY',
                 'SENTRY_DSN_BACKEND', 'SENTRY_DSN_FRONTEND', 'SENTRY_DSN'):
        os.environ.pop(name, None)
    os.environ.update({
        'APP_ENV': 'test', 'SENTRY_ENVIRONMENT': 'test', 'FLASK_TESTING': '1',
        'FLASK_SECRET_KEY': 'isolated-local-ui-preview-only',
        'PUBLIC_BASE_URL': f'http://127.0.0.1:{args.port}',
        'ENABLE_RUNTIME_JOB_RECOVERY': '0', 'ENABLE_BATCH_JOB_RECOVERY': '0',
        'GOOGLE_CALENDAR_ENABLED': '0',
    })

    # Changing cwd BEFORE importing the runtime isolates its relative uploads.
    with tempfile.TemporaryDirectory(prefix='lecture-ui-preview-') as storage:
        os.chdir(storage)
        from lecture_processor import create_app
        from lecture_processor.runtime.bootstrap import FirebaseInitResult

        with patch('lecture_processor.runtime.bootstrap.load_local_environment'), \
             patch('lecture_processor.runtime.bootstrap.initialize_firebase',
                   return_value=FirebaseInitResult(db=None, init_error='Isolated UI preview')), \
             patch('lecture_processor.runtime.container._start_cleanup_thread_once'):
            app = create_app()
        app.config['TESTING'] = True
        app.jinja_env.auto_reload = True
        app.run(host='127.0.0.1', port=args.port, debug=False, use_reloader=False, threaded=True)


if __name__ == '__main__':
    main()
