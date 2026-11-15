#!/usr/bin/env python3
"""Check the production entrypoint with temporary storage and no external access."""
from __future__ import annotations

import os
from pathlib import Path
import subprocess
import sys
import tempfile

PROJECT_ROOT = Path(__file__).resolve().parents[1]

_CHECK = r'''
import runpy
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, sys.argv[1])

class ExternalAccessAttempted(BaseException):
    pass

def forbid_external_access(*_args, **_kwargs):
    raise ExternalAccessAttempted('External access attempted during isolated startup.')

# Exercise real bootstrap code while preventing background work and external I/O.
with patch('socket.socket.connect', forbid_external_access), \
     patch('socket.socket.connect_ex', forbid_external_access), \
     patch('socket.create_connection', forbid_external_access), \
     patch('socket.getaddrinfo', forbid_external_access), \
     patch('dotenv.load_dotenv', forbid_external_access), \
     patch('threading.Thread.start', lambda _thread: None):
    module = runpy.run_path(str(Path(sys.argv[1]) / 'app.py'), run_name='isolated_startup')
    app = module['app']
    runtime = app.extensions['lecture_processor']['runtime']
    from lecture_processor.domains.ai.providers.fake import FakeGeminiClient
    assert isinstance(runtime.client, FakeGeminiClient)
    assert runtime.db is None
    assert not runtime.RUNTIME_JOB_RECOVERY_ENABLED
    assert not runtime.BATCH_JOB_RECOVERY_ENABLED
    assert not runtime._cleanup_thread.is_alive()
    assert Path(runtime.UPLOAD_FOLDER).resolve().is_relative_to(Path.cwd())
    assert Path(runtime.STUDY_AUDIO_ROOT).is_relative_to(Path.cwd())
    response = app.test_client().get('/healthz')
    assert response.status_code == 200 and response.json['status'] == 'ok'
    print('Isolated app.py startup passed.')
'''


def check_startup(project_root=PROJECT_ROOT):
    environment = {
        'PATH': os.environ.get('PATH', ''),
        'PYTHONDONTWRITEBYTECODE': '1',
        'APP_ENV': 'test',
        'SENTRY_ENVIRONMENT': 'test',
        'LP_FORCE_FAKE_PROVIDER': '1',
        'FLASK_SECRET_KEY': 'isolated-startup-only',
        'ENABLE_RUNTIME_JOB_RECOVERY': '0',
        'ENABLE_BATCH_JOB_RECOVERY': '0',
    }
    with tempfile.TemporaryDirectory(prefix='lecture-startup-') as storage:
        return subprocess.run(
            [sys.executable, '-c', _CHECK, str(Path(project_root).resolve())],
            cwd=storage, env=environment, timeout=30, check=False,
        ).returncode


if __name__ == '__main__':
    raise SystemExit(check_startup())
