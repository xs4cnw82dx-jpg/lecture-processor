"""Bootstrap for Gunicorn and local `python app.py` runs."""

from lecture_processor import create_app
from lecture_processor.runtime.dev_server import should_enable_debug
from lecture_processor.runtime.environment import strict_int_env

app = create_app()

if __name__ == '__main__':
    port = strict_int_env('PORT', 5000, blank_uses_default=True)
    debug = should_enable_debug()
    app.run(debug=debug, use_reloader=debug, threaded=True, port=port)
