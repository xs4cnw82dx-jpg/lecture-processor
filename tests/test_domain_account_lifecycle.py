from types import SimpleNamespace

from lecture_processor.domains.account import lifecycle
from lecture_processor.runtime.container import get_runtime


def test_count_active_jobs_for_user_uses_in_memory_job_store(app):
    runtime = get_runtime(app)
    with runtime.JOBS_LOCK:
        runtime.jobs.clear()
        runtime.jobs["j1"] = {"user_id": "u1", "status": "processing"}
        runtime.jobs["j2"] = {"user_id": "u1", "status": "complete"}
        runtime.jobs["j3"] = {"user_id": "u2", "status": "starting"}

    assert lifecycle.count_active_jobs_for_user("u1", runtime=runtime) == 1


def test_list_docs_by_uid_flattens_documents(app, monkeypatch):
    runtime = get_runtime(app)

    class _Doc:
        def __init__(self, doc_id, payload):
            self.id = doc_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    monkeypatch.setattr(
        runtime.admin_repo,
        "query_by_uid",
        lambda _db, _collection, _uid, _limit: [_Doc("d1", {"x": 1}), _Doc("d2", {"x": 2})],
    )
    rows, truncated = lifecycle.list_docs_by_uid("job_logs", "u1", 1, runtime=runtime)
    assert truncated is True
    assert rows == [{"x": 1, "_id": "d1"}]


def test_collect_user_export_payload_returns_expected_shape(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.users_repo, "get_doc", lambda _db, _uid: SimpleNamespace(exists=True, to_dict=lambda: {"uid": "u1"}))
    monkeypatch.setattr(
        runtime.study_repo,
        "study_progress_doc_ref",
        lambda _db, _uid: SimpleNamespace(get=lambda: SimpleNamespace(exists=True, to_dict=lambda: {"daily_goal": 20})),
    )
    monkeypatch.setattr(
        lifecycle,
        "list_docs_by_uid",
        lambda _collection, _uid, _max_docs, runtime=None: ([], False),
    )

    payload = lifecycle.collect_user_export_payload("u1", "u@example.com", runtime=runtime)
    assert payload["meta"]["uid"] == "u1"
    assert payload["account"]["profile"] == {"uid": "u1"}
    assert "collections" in payload
