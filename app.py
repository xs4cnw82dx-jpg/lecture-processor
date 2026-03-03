"""Bootstrap for Gunicorn and local `python app.py` runs."""

import os
import sys
import warnings

from lecture_processor import create_app

app = create_app()
runtime = app.extensions.get('lecture_processor', {}).get('runtime')
core = getattr(runtime, 'core', None)
if core is not None:
    # Preserve one-release compatibility for monkeypatch-heavy tests/scripts that
    # import `app` as a module of runtime attributes.
    core.app = app
    core.create_app = create_app

if __name__ != '__main__':
    if core is not None:
        warnings.warn(
            "`import app` compatibility module export is deprecated and will be removed in the next release.",
            DeprecationWarning,
            stacklevel=2,
        )
        sys.modules[__name__] = core
else:
    port = int(os.getenv('PORT', '5000') or 5000)
    app.run(debug=True, threaded=True, port=port)
