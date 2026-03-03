from types import SimpleNamespace

from lecture_processor.domains.runtime_jobs import recovery
from lecture_processor.domains.runtime_jobs import store
from lecture_processor.runtime.container import get_runtime


def test_runtime_job_store_roundtrip_in_memory(app):
    runtime = get_runtime(app)
    with runtime.JOBS_LOCK:
        runtime.jobs.clear()

    store.set_job("job-1", {"status": "processing", "step": 1}, runtime=runtime)
    snapshot = store.get_job_snapshot("job-1", runtime=runtime)
    assert snapshot["status"] == "processing"

    store.update_job_fields("job-1", runtime=runtime, status="complete")
    updated = store.get_job_snapshot("job-1", runtime=runtime)
    assert updated["status"] == "complete"

    deleted = store.delete_job("job-1", runtime=runtime)
    assert isinstance(deleted, dict)
    assert deleted["status"] == "complete"


def test_runtime_job_snapshot_persist_uses_repo(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "db", object())
    monkeypatch.setattr(runtime, "RUNTIME_JOBS_COLLECTION", "runtime_jobs")
    monkeypatch.setattr(runtime, "RUNTIME_JOB_PERSISTED_FIELDS", ("status",))
    monkeypatch.setattr(runtime.time, "time", lambda: 100.0)

    captured = {}

    def _set_doc(_db, collection, job_id, payload, merge=True):
        captured["collection"] = collection
        captured["job_id"] = job_id
        captured["payload"] = payload

    monkeypatch.setattr(runtime.runtime_jobs_repo, "set_doc", _set_doc)
    store.persist_runtime_job_snapshot("job-2", {"status": "processing", "ignored": "x"}, runtime=runtime)
    assert captured["collection"] == "runtime_jobs"
    assert captured["payload"]["status"] == "processing"
    assert "ignored" not in captured["payload"]


def test_run_startup_recovery_once_honors_disabled_flag():
    class _Lock:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

    log_messages = []

    class _Runtime:
        core = SimpleNamespace(RUNTIME_JOB_RECOVERY_LOCK=_Lock(), RUNTIME_JOB_RECOVERY_DONE=False)
        RUNTIME_JOB_RECOVERY_ENABLED = False
        logger = SimpleNamespace(info=lambda msg: log_messages.append(msg))

    recovery.run_startup_recovery_once(runtime=_Runtime())
    assert any("disabled" in msg.lower() for msg in log_messages)
