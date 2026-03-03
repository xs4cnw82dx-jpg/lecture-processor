"""Bootstrap for Gunicorn and local `python app.py` runs."""

import os

from lecture_processor import create_app
from lecture_processor.runtime.dev_server import should_enable_debug

app = create_app()

if __name__ == '__main__':
    port = int(os.getenv('PORT', '5000') or 5000)
    debug = should_enable_debug()
    app.run(debug=debug, use_reloader=debug, threaded=True, port=port)
