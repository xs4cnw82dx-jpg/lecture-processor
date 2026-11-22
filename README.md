# Lecture Processor

Lecture Processor turns lecture recordings, slides and interviews into study materials. The Flask application also supports review sessions, study planning and overnight batch processing.

## Local development

Use the Python version in `.python-version` and Node.js 22. From the repository root, install the dependencies and start a preview with temporary storage and synthetic services.

```sh
python3 -m venv .venv
.venv/bin/python -m pip install -r requirements.txt -r requirements-dev.txt -c requirements.constraints.txt
npm ci
.venv/bin/python scripts/run_ui_preview.py --port 5113
```

Open [the local preview](http://127.0.0.1:5113). Run the Python and JavaScript suites with `.venv/bin/python scripts/run_pytest_isolated.py -q` and `npm run test:client-goals`.

See the [documentation index](docs/README.md) for product guides and release runbooks. The [production readiness record](PRODUCTION_READINESS.md) lists launch decisions and deferred integrations.
