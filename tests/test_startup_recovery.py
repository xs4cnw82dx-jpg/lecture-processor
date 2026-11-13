import ast
import logging
from pathlib import Path
import threading
from types import SimpleNamespace

from flask import Flask
import pytest

from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.runtime import container
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


def test_health_requests_do_not_run_startup_recovery(client, monkeypatch):
    calls = []
    monkeypatch.setattr(core, 'run_startup_recovery_once', lambda: calls.append('runtime'))
    monkeypatch.setattr(batch_orchestrator, 'run_startup_batch_recovery_once', lambda runtime=None: calls.append('batch'))

    first = client.get('/healthz')
    second = client.get('/healthz')

    assert first.status_code == 200
    assert second.status_code == 200
    assert calls == []


def test_build_runtime_starts_both_recoveries_before_any_request(monkeypatch):
    calls = []
    monkeypatch.setattr(core, 'run_startup_recovery_once', lambda: calls.append('runtime'))
    monkeypatch.setattr(batch_orchestrator, 'run_startup_batch_recovery_once', lambda runtime=None: calls.append('batch'))
    monkeypatch.setattr(core, 'RUNTIME_JOB_RECOVERY_ENABLED', True)
    monkeypatch.setattr(core, 'BATCH_JOB_RECOVERY_ENABLED', True)
    monkeypatch.setattr(core, '_startup_recovery_thread', None, raising=False)
    monkeypatch.setattr(core, 'app', core.app)
    monkeypatch.setattr(container, '_start_cleanup_thread_once', lambda _core: None)

    runtime = container.build_runtime(Flask('synthetic-recovery'), SimpleNamespace())
    runtime._startup_recovery_thread.join(2)
    assert not runtime._startup_recovery_thread.is_alive()
    assert calls == ['runtime', 'batch']


def test_startup_recovery_daemon_does_not_block_boot_and_runs_once(monkeypatch):
    entered = threading.Event()
    release = threading.Event()
    calls = []

    def recover_runtime():
        calls.append('runtime')
        entered.set()
        assert release.wait(3)

    runtime = SimpleNamespace(
        RUNTIME_JOB_RECOVERY_ENABLED=True, BATCH_JOB_RECOVERY_ENABLED=True,
        run_startup_recovery_once=recover_runtime, logger=logging.getLogger('synthetic-recovery'),
    )
    monkeypatch.setattr(batch_orchestrator, 'run_startup_batch_recovery_once', lambda runtime=None: calls.append('batch'))
    container._start_recovery_thread_once(runtime)
    try:
        assert entered.wait(1)
        assert runtime._startup_recovery_thread.daemon
        container._start_recovery_thread_once(runtime)
        assert calls == ['runtime']
    finally:
        release.set()
        runtime._startup_recovery_thread.join(2)
    container._start_recovery_thread_once(runtime)
    assert calls == ['runtime', 'batch']


@pytest.mark.parametrize('runtime_enabled,batch_enabled', [(False, False), (True, False), (False, True)])
def test_startup_recovery_honors_each_disabled_flag(monkeypatch, runtime_enabled, batch_enabled):
    calls = []
    runtime = SimpleNamespace(
        RUNTIME_JOB_RECOVERY_ENABLED=runtime_enabled, BATCH_JOB_RECOVERY_ENABLED=batch_enabled,
        run_startup_recovery_once=lambda: calls.append('runtime'), logger=logging.getLogger('synthetic-recovery'),
    )
    monkeypatch.setattr(batch_orchestrator, 'run_startup_batch_recovery_once', lambda runtime=None: calls.append('batch'))
    container._start_recovery_thread_once(runtime)
    thread = getattr(runtime, '_startup_recovery_thread', None)
    if thread is not None:
        thread.join(2)
    assert calls == (['runtime'] if runtime_enabled else []) + (['batch'] if batch_enabled else [])
    if not (runtime_enabled or batch_enabled):
        assert thread is None


def test_runtime_startup_failure_does_not_skip_batch_recovery(monkeypatch):
    calls = []

    def fail():
        raise RuntimeError('Synthetic recovery failure')

    runtime = SimpleNamespace(
        RUNTIME_JOB_RECOVERY_ENABLED=True, BATCH_JOB_RECOVERY_ENABLED=True,
        run_startup_recovery_once=fail, logger=logging.getLogger('synthetic-recovery'),
    )
    monkeypatch.setattr(batch_orchestrator, 'run_startup_batch_recovery_once', lambda runtime=None: calls.append('batch'))
    container._start_recovery_thread_once(runtime)
    runtime._startup_recovery_thread.join(2)
    assert calls == ['batch']
