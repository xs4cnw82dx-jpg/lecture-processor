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


def test_count_active_jobs_for_user_includes_runtime_and_batch_jobs(app, monkeypatch):
    runtime = get_runtime(app)
    with runtime.JOBS_LOCK:
        runtime.jobs.clear()

    monkeypatch.setattr(
        runtime.runtime_jobs_repo,
        "query_by_user_and_statuses",
        lambda _db, _collection, _uid, _statuses, limit=200: [SimpleNamespace(id="r1"), SimpleNamespace(id="r2")],
    )
    monkeypatch.setattr(
        runtime.batch_repo,
        "list_batch_jobs_by_uid_and_statuses",
        lambda _db, _uid, _statuses, limit=200: [SimpleNamespace(id="b1")],
    )

    assert lifecycle.count_active_jobs_for_user("u1", runtime=runtime) == 3


def test_ensure_account_allows_writes_rejects_deleting_accounts(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(
        runtime.users_repo,
        "get_doc",
        lambda _db, _uid: SimpleNamespace(exists=True, to_dict=lambda: {"account_status": "deleting"}),
    )

    allowed, message = lifecycle.ensure_account_allows_writes("u1", runtime=runtime)

    assert allowed is False
    assert "account deletion is in progress" in message.lower()


def test_restore_account_after_failed_deletion_sets_account_active(app, monkeypatch):
    runtime = get_runtime(app)
    calls = []
    monkeypatch.setattr(
        runtime.users_repo,
        "set_doc",
        lambda _db, _uid, payload, merge=False: calls.append((payload, merge)),
    )

    restored = lifecycle.restore_account_after_failed_deletion(
        "u1",
        email="u1@example.com",
        reason="Deletion step failed unexpectedly",
        runtime=runtime,
        existing_state={"uid": "u1", "lecture_credits_standard": 5, "account_status": "deleting"},
    )

    assert restored is True
    assert calls
    payload, merge = calls[-1]
    assert merge is False
    assert payload["account_status"] == "active"
    assert payload["delete_requested_at"] == 0
    assert payload["delete_started_at"] == 0
    assert payload["last_delete_failure_reason"] == "Deletion step failed unexpectedly"


def test_is_stuck_deletion_candidate_requires_old_deleting_state():
    assert lifecycle.is_stuck_deletion_candidate({"account_status": "active"}, now_ts=7200) is False
    assert lifecycle.is_stuck_deletion_candidate({"account_status": "deleting", "delete_started_at": 7190}, now_ts=7200) is False
    assert lifecycle.is_stuck_deletion_candidate({"account_status": "deleting", "delete_started_at": 1}, now_ts=7200) is True


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
    def _list_docs(collection_name, _uid, _max_docs, runtime=None):
        _ = runtime
        if collection_name == "planner_settings":
            return ([{"uid": "u1", "enabled": "on", "_id": "planner-settings"}], False)
        if collection_name == "planner_sessions":
            return ([{"id": "session-1", "title": "Review", "_id": "planner-session-1"}], False)
        return ([], False)

    monkeypatch.setattr(lifecycle, "list_docs_by_uid", _list_docs)

    payload = lifecycle.collect_user_export_payload("u1", "u@example.com", runtime=runtime)
    assert payload["meta"]["uid"] == "u1"
    assert payload["account"]["profile"] == {"uid": "u1"}
    assert payload["account"]["planner_settings"]["enabled"] == "on"
    assert payload["collections"]["planner_sessions"] == [{"id": "session-1", "title": "Review", "_id": "planner-session-1"}]
    assert "collections" in payload


def test_normalize_export_bundle_include_defaults_missing_keys_to_false():
    normalized = lifecycle.normalize_export_bundle_include({"flashcards_csv": True})
    assert normalized["flashcards_csv"] is True
    assert normalized["practice_tests_csv"] is False
    assert normalized["lecture_notes_docx"] is False
    assert normalized["lecture_notes_pdf_marked"] is False
    assert normalized["lecture_notes_pdf_unmarked"] is False
    assert normalized["account_json"] is False


def test_has_export_bundle_selection_requires_at_least_one_true_flag():
    assert lifecycle.has_export_bundle_selection({"flashcards_csv": False}) is False
    assert lifecycle.has_export_bundle_selection({"flashcards_csv": True}) is True
