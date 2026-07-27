import pytest

from lecture_processor import create_app
from lecture_processor.runtime.container import get_runtime


@pytest.fixture(scope="session")
def app():
    return create_app()


@pytest.fixture(scope="session")
def runtime(app):
    return get_runtime(app)


@pytest.fixture()
def core(runtime):
    return runtime.core


@pytest.fixture()
def client(app, core):
    app.config["TESTING"] = True
    firestore_rate_limit_enabled = getattr(core, "RATE_LIMIT_FIRESTORE_ENABLED", False)
    core.RATE_LIMIT_FIRESTORE_ENABLED = False
    jobs = getattr(core, "jobs", None)
    if isinstance(jobs, dict):
        jobs.clear()
    rate_limit_events = getattr(core, "RATE_LIMIT_EVENTS", None)
    if isinstance(rate_limit_events, dict):
        rate_limit_events.clear()
    with app.test_client() as test_client:
        yield test_client
    if isinstance(jobs, dict):
        jobs.clear()
    if isinstance(rate_limit_events, dict):
        rate_limit_events.clear()
    core.RATE_LIMIT_FIRESTORE_ENABLED = firestore_rate_limit_enabled


@pytest.fixture()
def disable_sentry(monkeypatch, core):
    monkeypatch.setattr(core, "sentry_sdk", None)
