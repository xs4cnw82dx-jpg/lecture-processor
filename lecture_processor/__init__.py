from .blueprints import account_bp, admin_bp, auth_bp, payments_bp, physio_bp, study_bp, upload_bp
from .config import load_config
from .extensions import init_extensions
from .logging_config import configure_logging
from .runtime.container import build_runtime
from .runtime.hooks import register_runtime_hooks
from .runtime.proxy import apply_proxy_fix
from .runtime.settings import load_runtime_settings
from .web import health_bp, pages_bp


def create_app():
    """Canonical app-factory entrypoint for the modular runtime."""

    config = load_config()
    configure_logging(config.log_level)

    from .runtime import core

    app = core.app
    apply_proxy_fix(app, getattr(core, 'TRUSTED_PROXY_HOPS', 1))
    init_extensions(app)

    settings = load_runtime_settings(config=config)
    runtime = build_runtime(app, settings)
    state = app.extensions.setdefault('lecture_processor', {})

    if not state.get('blueprints_registered'):
        for blueprint in (pages_bp, health_bp, auth_bp, account_bp, study_bp, upload_bp, admin_bp, payments_bp, physio_bp):
            if blueprint.name not in app.blueprints:
                app.register_blueprint(blueprint)
        state['blueprints_registered'] = True

    register_runtime_hooks(app, runtime)
    state.setdefault('runtime_version', 'runtime')
    if not state.get('runtime_version_logged'):
        runtime.logger.info("runtime initialized: blueprints=%s hooks_registered=%s", len(app.blueprints), bool(state.get('hooks_registered')))
        state['runtime_version_logged'] = True
    return app
