from __future__ import annotations

from collections.abc import Mapping

from lecture_processor.runtime.environment import env_truthy


def should_enable_debug(env: Mapping[str, str] | None = None) -> bool:
    return env_truthy('FLASK_DEBUG', environ=env)
