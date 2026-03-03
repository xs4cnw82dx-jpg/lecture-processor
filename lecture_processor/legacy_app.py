"""Compatibility shim for legacy imports.

Deprecated: import runtime symbols from `lecture_processor.runtime.core` or use
`lecture_processor.runtime.container.get_runtime()` from Flask app context.
"""

from __future__ import annotations

import warnings

warnings.warn(
    "`lecture_processor.legacy_app` is deprecated and will be removed in the next release. "
    "Use `lecture_processor.runtime.core` or app runtime accessors instead.",
    DeprecationWarning,
    stacklevel=2,
)

from lecture_processor.runtime.core import *  # noqa: F401,F403
