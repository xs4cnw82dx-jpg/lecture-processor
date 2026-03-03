"""Bootstrap for Gunicorn and local `python app.py` runs."""

import os

from lecture_processor import create_app

app = create_app()

if __name__ == '__main__':
    port = int(os.getenv('PORT', '5000') or 5000)
    app.run(debug=True, threaded=True, port=port)
