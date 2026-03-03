import app as app_module
import pytest

from lecture_processor.runtime.container import get_runtime


@pytest.fixture(scope="session")
def app():
    return app_module.app


@pytest.fixture(scope="session")
def runtime(app):
    return get_runtime(app)


@pytest.fixture()
def core(runtime):
    return runtime.core


@pytest.fixture()
def client(app, core):
    app.config["TESTING"] = True
    jobs = getattr(core, "jobs", None)
    if isinstance(jobs, dict):
        jobs.clear()
    with app.test_client() as test_client:
        yield test_client
    if isinstance(jobs, dict):
        jobs.clear()


@pytest.fixture()
def disable_sentry(monkeypatch, core):
    monkeypatch.setattr(core, "sentry_sdk", None)
