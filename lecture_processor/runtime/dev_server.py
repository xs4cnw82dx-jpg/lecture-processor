from __future__ import annotations

import os
from collections.abc import Mapping


_TRUTHY_VALUES = {'1', 'true', 'yes', 'on'}


def should_enable_debug(env: Mapping[str, str] | None = None) -> bool:
    source = env if env is not None else os.environ
    raw = source.get('FLASK_DEBUG')
    if raw is None:
        return False
    return str(raw).strip().lower() in _TRUTHY_VALUES
