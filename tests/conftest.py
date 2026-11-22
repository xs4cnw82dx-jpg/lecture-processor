import pytest

from lecture_processor import create_app
from lecture_processor.runtime.container import get_runtime
from tests.support import (
    background_lecture_download,
    batch_slide_conversion,
    book_cloud_sync,
    interview_coding_background,
    pack_background_concurrency,
    pack_content_revision_concurrency,
    runtime_job_recovery,
    runtime_job_retention,
    study_picture_retention,
    study_plan_api,
    study_plan_daily,
    study_tools_regeneration,
    unified_processing_routes,
)
from tests.support import study_pictures as study_pictures_support


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


@pytest.fixture()
def allow_account_writes(monkeypatch):
    """Isolate non-account unit scenarios that have no account database fixture."""
    from lecture_processor.domains.account import lifecycle
    monkeypatch.setattr(lifecycle, 'ensure_account_allows_writes', lambda _uid, runtime=None: (True, ''))


# Register shared synthetic environments here so pytest can inject their
# dependencies and run teardown even for a single selected test module.
background = pytest.fixture(pack_background_concurrency.make_background)
cloud_setup = pytest.fixture(book_cloud_sync.make_cloud_setup)
coding = pytest.fixture(interview_coding_background.make_coding)
downloads = pytest.fixture(background_lecture_download.make_downloads)
editor = pytest.fixture(pack_content_revision_concurrency.make_editor)
october_clock = pytest.fixture(study_plan_daily.make_october_clock)
processing = pytest.fixture(unified_processing_routes.make_processing)
recovery_state = pytest.fixture(runtime_job_recovery.make_recovery_state)
regeneration = pytest.fixture(study_tools_regeneration.make_regeneration)
retention = pytest.fixture(study_picture_retention.make_retention)
retention_state = pytest.fixture(runtime_job_retention.make_retention_state)
slides = pytest.fixture(batch_slide_conversion.make_slides)
study_pictures = pytest.fixture(study_pictures_support.make_study_pictures)
study_plan_runtime = pytest.fixture(study_plan_api.make_study_plan_runtime)
