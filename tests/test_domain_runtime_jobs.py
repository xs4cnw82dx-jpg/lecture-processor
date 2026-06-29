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
    return SimpleNamespace(
        db=object(),
        firestore=None,
        time=SimpleNamespace(time=lambda: now_ts),
        runtime_jobs_repo=SimpleNamespace(query_statuses=lambda *_args, **_kwargs: docs),
        RUNTIME_JOBS_COLLECTION="runtime_jobs",
        RUNTIME_JOB_RECOVERY_BATCH_LIMIT=10,
        RUNTIME_JOB_RECOVERY_STALE_SECONDS=300,
        RUNTIME_JOB_RECOVERY_LEASE_SECONDS=300,
        logger=SimpleNamespace(warning=lambda *_args, **_kwargs: None),
        save_job_log=lambda *_args, **_kwargs: None,
    )


def test_recover_stale_runtime_jobs_skips_fresh_active_jobs(monkeypatch):
    writes = []
    refunds = []
    runtime = _runtime_for_recovery_docs([
        _RuntimeJobDoc(
            "job-fresh",
            {
                "status": "processing",
                "user_id": "user-1",
                "credit_deducted": "lecture_credits_standard",
                "updated_at": 920.0,
            },
        )
    ])

    monkeypatch.setattr(recovery.billing_credits, "refund_credit", lambda *args, **kwargs: refunds.append(args))
    monkeypatch.setattr(recovery.runtime_jobs_store, "set_job", lambda *args, **kwargs: writes.append(args))

    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 0
    assert refunds == []
    assert writes == []


def test_recover_stale_runtime_jobs_refunds_and_marks_stale_job(monkeypatch):
    writes = []
    refunds = []
    receipt_refunds = []
    logs = []
    runtime = _runtime_for_recovery_docs([
        _RuntimeJobDoc(
            "job-stale",
            {
                "status": "processing",
                "user_id": "user-1",
                "credit_deducted": "lecture_credits_standard",
                "updated_at": 100.0,
            },
        )
    ])
    runtime.save_job_log = lambda *args, **_kwargs: logs.append(args)

    monkeypatch.setattr(recovery.billing_credits, "refund_credit", lambda *args, **kwargs: refunds.append(args) or True)
    monkeypatch.setattr(recovery.billing_receipts, "add_job_credit_refund", lambda *args, **kwargs: receipt_refunds.append(args))
    monkeypatch.setattr(recovery.billing_receipts, "ensure_job_billing_receipt", lambda *args, **kwargs: None)
    monkeypatch.setattr(recovery.runtime_jobs_store, "set_job", lambda *args, **kwargs: writes.append(args))

    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert refunds == [("user-1", "lecture_credits_standard")]
    assert len(receipt_refunds) == 1
    assert writes[0][0] == "job-stale"
    assert writes[0][1]["status"] == "error"
    assert writes[0][1]["credit_refunded"] is True
    assert logs and logs[0][0] == "job-stale"


def test_recover_stale_runtime_jobs_refunds_study_tools_credit(monkeypatch):
    writes = []
    refunds = []
    runtime = _runtime_for_recovery_docs([
        _RuntimeJobDoc(
            "job-stale-study-tools",
            {
                "status": "queued",
                "user_id": "user-1",
                "updated_at": 100.0,
                "study_tools_credit_cost": 1,
                "extra_slides_refunded": 0,
                "billing_receipt": {"charged": {"slides_credits": 1}},
            },
        )
    ])

    monkeypatch.setattr(recovery.billing_credits, "refund_credit", lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("primary refund should not run")))
    monkeypatch.setattr(recovery.billing_credits, "refund_slides_credits", lambda *args, **kwargs: refunds.append(args) or True)
    monkeypatch.setattr(recovery.runtime_jobs_store, "set_job", lambda *args, **kwargs: writes.append(args))

    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    assert refunds == [("user-1", 1)]
    recovered = writes[0][1]
    assert recovered["status"] == "error"
    assert recovered["credit_refunded"] is True
    assert recovered["extra_slides_refunded"] == 1
    assert recovered["billing_receipt"]["refunded"]["slides_credits"] == 1


def test_recover_stale_runtime_jobs_keeps_failed_refund_pending(monkeypatch):
    writes = []
    runtime = _runtime_for_recovery_docs([
        _RuntimeJobDoc(
            "job-stale-refund-fail",
            {
                "status": "processing",
                "user_id": "user-1",
                "credit_deducted": "lecture_credits_standard",
                "updated_at": 100.0,
            },
        )
    ])

    monkeypatch.setattr(recovery.billing_credits, "refund_credit", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(
        recovery.billing_receipts,
        "add_job_credit_refund",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("failed refund should not be recorded")),
    )
    monkeypatch.setattr(recovery.runtime_jobs_store, "set_job", lambda *args, **kwargs: writes.append(args))

    assert recovery.recover_stale_runtime_jobs(runtime=runtime) == 1
    recovered = writes[0][1]
    assert recovered.get("credit_refunded") is not True
    assert recovered["credit_refund_pending"] is True
    assert recovered["credit_refund_error"] == "runtime_recovery_refund_failed"
    assert "contact support" in recovered["error"].lower()
