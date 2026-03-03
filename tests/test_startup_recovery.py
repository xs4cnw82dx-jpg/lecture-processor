import ast
from pathlib import Path

import app as app_module

from lecture_processor.runtime.container import get_runtime

core = get_runtime(app_module.app).core
import pytest


@pytest.fixture()
def client():
    app_module.app.config["TESTING"] = True
    with app_module.app.test_client() as test_client:
        yield test_client


def test_runtime_recovery_not_called_at_module_scope():
    source = Path(core.__file__).read_text(encoding='utf-8')
    tree = ast.parse(source)
    top_level_calls = []
    for node in tree.body:
        if isinstance(node, ast.Expr) and isinstance(node.value, ast.Call):
            func = node.value.func
            if isinstance(func, ast.Name):
                top_level_calls.append(func.id)
    assert 'recover_stale_runtime_jobs' not in top_level_calls


def test_startup_recovery_runs_once_on_first_request(client, monkeypatch):
    calls = []
    monkeypatch.setattr(core, 'recover_stale_runtime_jobs', lambda: calls.append('run') or 0)
    monkeypatch.setattr(core, 'acquire_runtime_job_recovery_lease', lambda now_ts=None: True)
    monkeypatch.setattr(core, 'RUNTIME_JOB_RECOVERY_ENABLED', True)
    monkeypatch.setattr(core, 'RUNTIME_JOB_RECOVERY_DONE', False)

    first = client.get('/healthz')
    second = client.get('/healthz')

    assert first.status_code == 200
    assert second.status_code == 200
    assert calls == ['run']
