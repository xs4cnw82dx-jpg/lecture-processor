from lecture_processor.domains.runtime_jobs import recovery
from lecture_processor.domains.runtime_jobs import store
from lecture_processor.runtime.container import get_runtime


def test_runtime_jobs_dispatch_uses_explicit_runtime():
    class _Runtime:
        def _runtime_job_storage_enabled(self):
            return True

        def _runtime_job_sanitize_value(self, value):
            return f"san:{value}"

        def _build_runtime_job_payload(self, job):
            return {"payload": job}

        def persist_runtime_job_snapshot(self, job_id):
            return f"persist:{job_id}"

        def load_runtime_job_snapshot(self, job_id):
            return {"job_id": job_id}

        def delete_runtime_job_snapshot(self, job_id):
            return f"delete:{job_id}"

        def update_job_fields(self, job_id, fields):
            return {"job_id": job_id, "fields": fields}

        def get_job_snapshot(self, job_id):
            return {"id": job_id}

        def mutate_job(self, job_id, mutator):
            return mutator({"id": job_id})

        def set_job(self, job_id, payload):
            return {"id": job_id, "payload": payload}

        def delete_job(self, job_id):
            return f"deleted:{job_id}"

        def recover_stale_runtime_jobs(self):
            return 3

        def acquire_runtime_job_recovery_lease(self, now_ts=None):
            return bool(now_ts is not None)

        def run_startup_recovery_once(self):
            return "ran"

    runtime = _Runtime()
    assert store._runtime_job_storage_enabled(runtime=runtime) is True
    assert store._runtime_job_sanitize_value("x", runtime=runtime) == "san:x"
    assert store._build_runtime_job_payload({"id": "j1"}, runtime=runtime) == {"payload": {"id": "j1"}}
    assert store.persist_runtime_job_snapshot("j1", runtime=runtime) == "persist:j1"
    assert store.load_runtime_job_snapshot("j1", runtime=runtime) == {"job_id": "j1"}
    assert store.delete_runtime_job_snapshot("j1", runtime=runtime) == "delete:j1"
    assert store.update_job_fields("j1", {"status": "done"}, runtime=runtime) == {"job_id": "j1", "fields": {"status": "done"}}
    assert store.get_job_snapshot("j1", runtime=runtime) == {"id": "j1"}
    assert store.mutate_job("j1", lambda job: dict(job, status="ok"), runtime=runtime) == {"id": "j1", "status": "ok"}
    assert store.set_job("j1", {"status": "new"}, runtime=runtime) == {"id": "j1", "payload": {"status": "new"}}
    assert store.delete_job("j1", runtime=runtime) == "deleted:j1"
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 3
    assert recovery.acquire_runtime_job_recovery_lease(now_ts=1, runtime=runtime) is True
    assert recovery.run_startup_recovery_once(runtime=runtime) == "ran"


def test_runtime_jobs_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "get_job_snapshot", lambda job_id: {"job_id": job_id, "from": "core"})
    monkeypatch.setattr(runtime.core, "run_startup_recovery_once", lambda: "ok")

    with app.app_context():
        assert store.get_job_snapshot("job-1") == {"job_id": "job-1", "from": "core"}
        assert recovery.run_startup_recovery_once() == "ok"
