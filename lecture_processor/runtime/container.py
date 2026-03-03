from __future__ import annotations

from dataclasses import dataclass

from flask import current_app

from .clients import RuntimeClients, build_clients
from .settings import AppSettings


@dataclass
class AppRuntime:
    """Typed runtime object exposed to blueprints/services."""

    app: object
    settings: AppSettings
    clients: RuntimeClients
    core: object

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


def build_runtime(app, settings: AppSettings) -> AppRuntime:
    from lecture_processor.runtime import core

    # Keep legacy helper code wired to the app created by the factory.
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
    return runtime


def get_runtime(app_obj=None) -> AppRuntime:
    if app_obj is None:
        app_obj = current_app
    runtime = app_obj.extensions.get('lecture_processor', {}).get('runtime')
    if runtime is None:
        raise RuntimeError('Lecture Processor runtime is not initialized on this app.')
    return runtime
