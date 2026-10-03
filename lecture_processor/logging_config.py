import logging
from lecture_processor.calendar_observability import install_calendar_log_filters


def configure_logging(level: str = 'INFO') -> None:
    """Idempotent logging setup for app-factory flow."""
    root = logging.getLogger()
    if root.handlers:
        install_calendar_log_filters()
        return
    numeric_level = getattr(logging, str(level or 'INFO').upper(), logging.INFO)
    logging.basicConfig(
        level=numeric_level,
        format='%(asctime)s %(levelname)s %(name)s %(message)s',
    )
    install_calendar_log_filters()
