"""Local-first Physio clinical companion.

This package is deliberately independent of the hosted Physio APIs. Consumers
can run :func:`create_companion_app` on loopback or mount the blueprint into a
dedicated local Flask process.
"""

from .api import create_companion_app, create_companion_blueprint
from .config import CompanionConfig
from .service import CompanionService

__all__ = [
    "CompanionConfig",
    "CompanionService",
    "create_companion_app",
    "create_companion_blueprint",
]
