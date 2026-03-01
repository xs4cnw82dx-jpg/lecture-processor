"""Compatibility bootstrap for Gunicorn and local `python app.py` runs.

Batch R1 introduces an app-factory skeleton while preserving existing behavior.
"""

import sys

from lecture_processor import create_app as _factory_create_app
from lecture_processor import legacy_app as _legacy_app


# Keep runtime behavior unchanged while exposing an app-factory contract.
_legacy_app.create_app = _factory_create_app
_legacy_app.app = _factory_create_app()

if __name__ != '__main__':
    # Make `import app` return the legacy module object so monkeypatching and
    # global lookups behave exactly as before the skeleton refactor.
    sys.modules[__name__] = _legacy_app
else:
    _legacy_app.app.run(debug=True, threaded=True)
