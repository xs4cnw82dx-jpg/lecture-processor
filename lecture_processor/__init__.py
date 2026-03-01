from .config import load_config
from .extensions import init_extensions
from .logging_config import configure_logging


def create_app():
    """App factory entrypoint.

    In Batch R1 we keep all route and behavior definitions in legacy_app,
    while exposing a factory contract for the upcoming modular batches.
    """
    config = load_config()
    configure_logging(config.log_level)

    from .legacy_app import app as legacy_app

    init_extensions(legacy_app)
    return legacy_app
