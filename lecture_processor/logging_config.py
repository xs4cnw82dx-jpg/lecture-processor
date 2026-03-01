import logging


def configure_logging(level: str = 'INFO') -> None:
    """Idempotent logging setup for app-factory flow."""
    root = logging.getLogger()
    if root.handlers:
        return
    numeric_level = getattr(logging, str(level or 'INFO').upper(), logging.INFO)
    logging.basicConfig(
        level=numeric_level,
        format='%(asctime)s %(levelname)s %(name)s %(message)s',
    )
