import ast
from pathlib import Path

from lecture_processor.runtime import hooks
from tests.runtime_test_support import get_test_core

core = get_test_core()


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


def test_startup_hook_runs_batch_recovery_once(client, monkeypatch):
    calls = []
    monkeypatch.setattr(core, 'run_startup_recovery_once', lambda: calls.append('runtime'))
    monkeypatch.setattr(hooks.batch_orchestrator, 'run_startup_batch_recovery_once', lambda runtime=None: calls.append('batch'))

    response = client.get('/healthz')

    assert response.status_code == 200
    assert calls == ['runtime', 'batch']
