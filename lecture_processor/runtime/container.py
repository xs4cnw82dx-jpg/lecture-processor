from __future__ import annotations

from dataclasses import dataclass, field
import threading
from typing import TYPE_CHECKING

from flask import current_app

from .clients import RuntimeClients, build_clients
from .repositories import RuntimeRepositories
from .settings import AppSettings

if TYPE_CHECKING:
    from lecture_processor.domains.runtime_jobs.schema import RuntimeJobsCapability

_RECOVERY_THREAD_LOCK = threading.Lock()


@dataclass
class AppRuntime:
    """Typed runtime object exposed to blueprints/services."""

    app: object
    settings: AppSettings
    clients: RuntimeClients
    core: object
    runtime_jobs: RuntimeJobsCapability = field(init=False)
    repositories: RuntimeRepositories = field(init=False)

    def __post_init__(self):
        # Import only after runtime.core has finished initializing. Importing
        # the runtime_jobs package at module load time creates a container/store
        # cycle because the store also resolves the active runtime.
        from lecture_processor.domains.runtime_jobs.capability import RuntimeJobsCapabilityAdapter

        self.runtime_jobs = RuntimeJobsCapabilityAdapter(self.core)
        self.repositories = RuntimeRepositories(self.core)

    @property
    def db(self):
        """Keep the legacy database binding live instead of shadowing it."""
        return self.core.db

    @db.setter
    def db(self, value):
        self.core.db = value

    def __getattr__(self, name):
        return getattr(self.core, name)


def _start_cleanup_thread_once(core_module) -> None:
    cleanup_thread = getattr(core_module, '_cleanup_thread', None)
    if cleanup_thread is None:
        return
    try:
        is_alive = bool(cleanup_thread.is_alive())
    except Exception:
        is_alive = False
    if is_alive:
        return
    try:
        cleanup_thread.start()
    except RuntimeError:
        # Thread already started in another factory lifecycle.
        return


def _start_recovery_thread_once(runtime) -> None:
    core_module = getattr(runtime, 'core', runtime)
    runtime_enabled = bool(getattr(runtime, 'RUNTIME_JOB_RECOVERY_ENABLED', False))
    batch_enabled = bool(getattr(runtime, 'BATCH_JOB_RECOVERY_ENABLED', False))
    if not (runtime_enabled or batch_enabled):
        return

    def recover():
        from lecture_processor.domains.ai import batch_orchestrator

        operations = []
        if runtime_enabled:
            operations.append(runtime.run_startup_recovery_once)
        if batch_enabled:
            operations.append(lambda: batch_orchestrator.run_startup_batch_recovery_once(runtime=runtime))
        for operation in operations:
            try:
                operation()
            except Exception:
                runtime.logger.warning('Startup recovery failed', exc_info=True)

    with _RECOVERY_THREAD_LOCK:
        if getattr(core_module, '_startup_recovery_thread', None) is not None:
            return
        thread = threading.Thread(target=recover, name='lp-startup-recovery', daemon=True)
        core_module._startup_recovery_thread = thread
        try:
            thread.start()
        except Exception:
            core_module._startup_recovery_thread = None
            raise


def build_runtime(app, settings: AppSettings) -> AppRuntime:
    from lecture_processor.runtime import core

    # Bind runtime helper module state to the app created by this factory instance.
    core.app = app
    app.config['MAX_CONTENT_LENGTH'] = int(getattr(core, 'MAX_CONTENT_LENGTH', app.config.get('MAX_CONTENT_LENGTH', 0)) or 0)

    runtime = AppRuntime(
        app=app,
        settings=settings,
        clients=build_clients(core),
        core=core,
    )

    app.extensions.setdefault('lecture_processor', {})
    app.extensions['lecture_processor']['runtime'] = runtime

    _start_cleanup_thread_once(core)
    _start_recovery_thread_once(runtime)
    return runtime


def get_runtime(app_obj=None) -> AppRuntime:
    if app_obj is None:
        app_obj = current_app
    runtime = app_obj.extensions.get('lecture_processor', {}).get('runtime')
    if runtime is None:
        raise RuntimeError('Lecture Processor runtime is not initialized on this app.')
    return runtime
