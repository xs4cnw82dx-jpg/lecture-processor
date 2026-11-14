from types import SimpleNamespace
from threading import RLock

from tests.credit_test_support import make_credit_runtime
from lecture_processor.repositories import runtime_jobs_repo
from lecture_processor.services import job_state_service

from lecture_processor.domains.runtime_jobs import recovery
from lecture_processor.domains.runtime_jobs import store
from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
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


def test_runtime_job_schema_persists_operational_fields_after_restart(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime, "db", object())
    monkeypatch.setattr(runtime.time, "time", lambda: 100.0)
    captured = {}
    monkeypatch.setattr(
        runtime.runtime_jobs_repo,
        "set_doc",
        lambda _db, _collection, _job_id, payload, merge=True: captured.update(payload),
    )

    operational = {
        "failed_stage": "audio_transcription",
        "provider_error_code": "HTTP_503",
        "retry_attempts": 2,
        "file_size_mb": 12.5,
        "source_type": "url",
        "source_name": "lecture.mp3",
        "prompt_template_key": "lecture-notes",
        "prompt_source": "registry",
        "custom_prompt_length": 42,
        "credit_scheme": 2,
        "charge_ref": "runtime-job:job-operational",
        "charged_credits": 8,
        "refunded_credits": 2,
        "credit_admission_state": "admitted",
        "billing_receipt": {"credit_scheme": 2, "charged": {"credits": 8}, "refunded": {"credits": 2}},
    }
    store.persist_runtime_job_snapshot("job-operational", operational, runtime=runtime)

    assert set(operational).issubset(PERSISTED_RUNTIME_JOB_FIELDS)
    assert {field: captured[field] for field in operational} == operational


def test_runtime_exposes_explicit_runtime_jobs_capability(app):
    runtime = get_runtime(app)
    assert callable(runtime.runtime_jobs.get_job_snapshot)
    assert callable(runtime.runtime_jobs.update_job_fields)


def test_runtime_job_update_persists_only_changed_fields(app, monkeypatch):
    runtime = get_runtime(app)
    with runtime.JOBS_LOCK:
        runtime.jobs.clear()
    monkeypatch.setattr(runtime, "db", object())
    monkeypatch.setattr(runtime, "RUNTIME_JOBS_COLLECTION", "runtime_jobs")
    monkeypatch.setattr(runtime, "RUNTIME_JOB_PERSISTED_FIELDS", ("status", "result", "finished_at"))
    monkeypatch.setattr(runtime.time, "time", lambda: 200.0)
    writes = []

    def _set_doc(_db, collection, job_id, payload, merge=True):
        writes.append(dict(payload))

    monkeypatch.setattr(runtime.runtime_jobs_repo, "set_doc", _set_doc)

    store.set_job("job-large", {"status": "processing", "result": "large artifact"}, runtime=runtime)
    store.update_job_fields("job-large", runtime=runtime, status="complete")
    store.update_job_fields("job-large", runtime=runtime, finished_at=205.0)

    assert writes[0]["result"] == "large artifact"
    assert writes[1]["status"] == "complete"
    assert "result" not in writes[1]
    assert writes[2]["finished_at"] == 205.0
    assert "result" not in writes[2]


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


class _RuntimeJobDoc:
    def __init__(self, doc_id, payload):
        self.id = doc_id
        self._payload = dict(payload)

    def to_dict(self):
        return dict(self._payload)


def _runtime_for_recovery_docs(docs, *, now_ts=1000.0):
    runtime, credit_store = make_credit_runtime(
        users={"user-1": {"uid": "user-1", "lecture_credits_standard": 0,
                          "slides_credits": 0, "total_processed": 1}},
        documents={("runtime_jobs", doc.id): doc.to_dict() for doc in docs},
        unified_enabled=False,
    )
    credit_store.now = now_ts
    runtime.runtime_jobs_repo = runtime_jobs_repo
    runtime.RUNTIME_JOBS_COLLECTION = "runtime_jobs"
    runtime.RUNTIME_JOB_RECOVERY_BATCH_LIMIT = 10
    runtime.RUNTIME_JOB_RECOVERY_STALE_SECONDS = 300
    runtime.RUNTIME_JOB_RECOVERY_LEASE_SECONDS = 300
    runtime.RUNTIME_JOB_PERSISTED_FIELDS = PERSISTED_RUNTIME_JOB_FIELDS
    runtime.job_state_service = job_state_service
    runtime.jobs, runtime.JOBS_LOCK = {}, RLock()
    runtime.os = SimpleNamespace(getenv=lambda *_args: '', getpid=lambda: 7)
    runtime.save_job_log = lambda *_args, **_kwargs: None
    runtime._credit_test_store = credit_store
    return runtime


def test_recover_stale_runtime_jobs_skips_fresh_active_jobs():
    runtime = _runtime_for_recovery_docs([
        _RuntimeJobDoc("job-fresh", {
            "status": "processing", "user_id": "user-1",
            "credit_deducted": "lecture_credits_standard", "updated_at": 920.0,
        })
    ])
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 0
    assert not runtime._credit_test_store.docs("credit_refunds")
    assert all(not operations for operations in runtime._credit_test_store.commits)


def test_recover_stale_runtime_jobs_refunds_and_marks_stale_job():
    runtime = _runtime_for_recovery_docs([
        _RuntimeJobDoc("job-stale", {
            "status": "processing", "user_id": "user-1",
            "credit_deducted": "lecture_credits_standard", "updated_at": 100.0,
        })
    ])
    logs = []
    runtime.save_job_log = lambda *args, **_kwargs: logs.append(args)
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert runtime._credit_test_store.docs("users")["user-1"]["lecture_credits_standard"] == 1
    assert runtime._credit_test_store.docs("users")["user-1"]["total_processed"] == 0
    assert len(runtime._credit_test_store.docs("credit_refunds")) == 1
    recovered = runtime._credit_test_store.docs("runtime_jobs")["job-stale"]
    assert recovered["status"] == "error"
    assert recovered["credit_refunded"] is True
    assert recovered["billing_receipt"]["refunded"] == {"lecture_credits_standard": 1}
    assert logs and logs[0][0] == "job-stale"
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 0
    assert runtime._credit_test_store.docs("users")["user-1"]["lecture_credits_standard"] == 1


def test_recover_stale_runtime_jobs_refunds_study_tools_credit():
    runtime = _runtime_for_recovery_docs([
        _RuntimeJobDoc("job-stale-study-tools", {
            "status": "queued", "user_id": "user-1", "updated_at": 100.0,
            "study_tools_credit_cost": 1, "extra_slides_refunded": 0,
            "billing_receipt": {"charged": {"slides_credits": 1}},
        })
    ])
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    user = runtime._credit_test_store.docs("users")["user-1"]
    assert user["slides_credits"] == 1 and user["lecture_credits_standard"] == 0
    assert user["total_processed"] == 1  # Regeneration is not another processed job.
    recovered = runtime._credit_test_store.docs("runtime_jobs")["job-stale-study-tools"]
    assert recovered["status"] == "error"
    assert recovered["credit_refunded"] is True
    assert recovered["extra_slides_refunded"] == 1
    assert recovered["billing_receipt"]["refunded"]["slides_credits"] == 1


def test_recover_stale_runtime_jobs_keeps_failed_refund_pending():
    runtime = _runtime_for_recovery_docs([
        _RuntimeJobDoc("job-stale-refund-fail", {
            "status": "processing", "user_id": "user-1",
            "credit_deducted": "lecture_credits_standard", "updated_at": 100.0,
        })
    ])
    runtime._credit_test_store.fail_writes.add(("users", "user-1"))
    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert not runtime._credit_test_store.docs("credit_refunds")
    recovered = runtime._credit_test_store.docs("runtime_jobs")["job-stale-refund-fail"]
    assert recovered.get("credit_refunded") is not True
    assert recovered["credit_refund_pending"] is True
    assert recovered["credit_refund_error"] == "runtime_recovery_refund_failed"
    assert "contact support" in recovered["error"].lower()
