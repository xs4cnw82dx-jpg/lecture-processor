from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RuntimeClients:
    """References to initialized external clients/providers."""

    firebase_db: object
    firebase_auth: object
    firestore_module: object
    stripe_module: object
    gemini_client: object
    sentry_sdk: object


def build_clients(core_module) -> RuntimeClients:
    return RuntimeClients(
        firebase_db=getattr(core_module, 'db', None),
        firebase_auth=getattr(core_module, 'auth', None),
        firestore_module=getattr(core_module, 'firestore', None),
        stripe_module=getattr(core_module, 'stripe', None),
        gemini_client=getattr(core_module, 'client', None),
        sentry_sdk=getattr(core_module, 'sentry_sdk', None),
    )
