from lecture_processor.domains.account import lifecycle
from lecture_processor.runtime.container import get_runtime


def test_account_lifecycle_dispatch_uses_explicit_runtime():
    class _Runtime:
        def count_active_jobs_for_user(self, uid):
            return len(uid)

        def list_docs_by_uid(self, collection, uid, limit):
            return ([{"collection": collection, "uid": uid}], limit > 10)

        def delete_docs_by_uid(self, collection, uid, limit):
            return (min(limit, 3), False)

        def remove_upload_artifacts_for_job_ids(self, job_ids):
            return len(job_ids)

        def anonymize_purchase_docs_by_uid(self, uid, limit):
            return (1, limit > 100)

        def collect_user_export_payload(self, uid, email):
            return {"uid": uid, "email": email}

    runtime = _Runtime()
    assert lifecycle.count_active_jobs_for_user("abc", runtime=runtime) == 3
    assert lifecycle.list_docs_by_uid("job_logs", "u1", 5, runtime=runtime) == ([{"collection": "job_logs", "uid": "u1"}], False)
    assert lifecycle.delete_docs_by_uid("job_logs", "u1", 2, runtime=runtime) == (2, False)
    assert lifecycle.remove_upload_artifacts_for_job_ids({"j1", "j2"}, runtime=runtime) == 2
    assert lifecycle.anonymize_purchase_docs_by_uid("u1", 20, runtime=runtime) == (1, False)
    assert lifecycle.collect_user_export_payload("u1", "u@example.com", runtime=runtime) == {
        "uid": "u1",
        "email": "u@example.com",
    }


def test_account_lifecycle_dispatch_uses_current_app_runtime(app, monkeypatch):
    runtime = get_runtime(app)
    monkeypatch.setattr(runtime.core, "count_active_jobs_for_user", lambda uid: f"jobs:{uid}")
    monkeypatch.setattr(runtime.core, "collect_user_export_payload", lambda uid, email: {"uid": uid, "email": email, "from": "core"})

    with app.app_context():
        assert lifecycle.count_active_jobs_for_user("u9") == "jobs:u9"
        assert lifecycle.collect_user_export_payload("u9", "x@y.z") == {"uid": "u9", "email": "x@y.z", "from": "core"}
