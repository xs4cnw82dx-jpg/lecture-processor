#!/usr/bin/env python3
"""Run pytest without local credentials, workspace uploads, or background jobs."""
from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))


def main() -> int:
    for name in ('RENDER', 'FIREBASE_CREDENTIALS', 'GOOGLE_APPLICATION_CREDENTIALS',
                 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'STRIPE_SECRET_KEY',
                 'SENTRY_DSN_BACKEND', 'SENTRY_DSN_FRONTEND', 'SENTRY_DSN'):
        os.environ.pop(name, None)
    os.environ.update({
        'APP_ENV': 'test', 'SENTRY_ENVIRONMENT': 'test',
        'FLASK_SECRET_KEY': 'isolated-local-test-only',
        'ENABLE_RUNTIME_JOB_RECOVERY': '0', 'ENABLE_BATCH_JOB_RECOVERY': '0',
    })
    with tempfile.TemporaryDirectory(prefix='lecture-pytest-') as storage:
        os.chdir(storage)
        from lecture_processor.runtime.bootstrap import FirebaseInitResult
        with patch('lecture_processor.runtime.bootstrap.load_local_environment'), \
             patch('lecture_processor.runtime.bootstrap.initialize_firebase',
                   return_value=FirebaseInitResult(db=None, init_error='Isolated tests')):
            from lecture_processor.runtime import core
        # All later factory calls reuse this imported module. Keep storage absolute
        # when source-based tests run from the project root.
        core.UPLOAD_FOLDER = str(Path(storage) / 'uploads')
        core._cleanup_thread = None
        os.chdir(PROJECT_ROOT)
        import pytest
        return pytest.main(sys.argv[1:] or ['-q'])


if __name__ == '__main__':
    raise SystemExit(main())
