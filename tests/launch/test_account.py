import io
import json
import zipfile

import pytest

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.study import export as study_export
from lecture_processor.domains.upload import import_audio as upload_import_audio
from lecture_processor.runtime.job_dispatcher import JobQueueFullError
from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures("disable_sentry")


@pytest.fixture(autouse=True)
def isolate_book_account_boundary(monkeypatch):
    # Book ownership cleanup has its own transactional tests; these tests isolate account orchestration.
    from lecture_processor.services import (
        book_account_service,
        elearning_account_service,
    )
    monkeypatch.setattr(elearning_account_service, 'delete_owned', lambda *args: 0)
    monkeypatch.setattr(elearning_account_service, 'collect', lambda *args: [])
    monkeypatch.setattr(book_account_service, 'delete_owned', lambda *args: 0)
    monkeypatch.setattr(book_account_service, 'collect', lambda *args: [])
    from lecture_processor.services import study_picture_service
    monkeypatch.setattr(study_picture_service, 'delete_owned', lambda *args: 0)
    monkeypatch.setattr(study_picture_service, 'collect', lambda *args: [])
    monkeypatch.setattr(study_picture_service, 'add_bundle_assets', lambda *args: None)


def test_account_export_requires_auth(client):
    response = client.get("/api/account/export")
    assert response.status_code == 401
    assert response.get_json()["error"] == "Unauthorized"


def test_account_export_returns_json_attachment(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u6", "email": "user@gmail.com", "auth_time": core.time.time()})
    monkeypatch.setattr(
        account_lifecycle,
        "collect_user_export_payload",
        lambda uid, email, runtime=None: {"meta": {"uid": uid, "email": email}, "collections": {}},
    )

    response = client.get("/api/account/export", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    assert response.mimetype == "application/json"
    content_disposition = response.headers.get("Content-Disposition", "")
    assert "attachment;" in content_disposition
    assert "lecture-processor-account-export-" in content_disposition
    parsed = json.loads(response.data.decode("utf-8"))
    assert parsed["meta"]["uid"] == "u6"


def test_account_export_bundle_requires_auth(client):
    response = client.post(
        "/api/account/export-bundle",
        json={"scope": "account", "include": {"account_json": True}},
    )
    assert response.status_code == 401
    assert response.get_json()["error"] == "Unauthorized"


def test_account_export_bundle_rejects_empty_selection(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "bundle-u1", "email": "user@gmail.com", "auth_time": core.time.time()})

    response = client.post(
        "/api/account/export-bundle",
        json={"scope": "account", "include": {}},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "select at least one export option" in response.get_json()["error"].lower()


def test_account_export_requires_live_recent_authentication(client, monkeypatch):
    revocation_checks = []

    def _verify_token(_request, check_revoked=False):
        revocation_checks.append(check_revoked)
        return {
            "uid": "stale-export-user",
            "email": "user@gmail.com",
            "auth_time": core.time.time() - core.ACCOUNT_RECENT_AUTH_MAX_AGE_SECONDS - 1,
        }

    monkeypatch.setattr(core, "verify_firebase_token", _verify_token)

    response = client.post(
        "/api/account/export-bundle",
        json={"scope": "account", "include": {"account_json": True}},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 403
    assert response.get_json()["error_code"] == "recent_authentication_required"
    assert revocation_checks == [True]


def test_account_export_queue_backpressure_is_explicit(client, monkeypatch, tmp_path):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "queue-u", "email": "user@gmail.com", "auth_time": core.time.time()})
    monkeypatch.setattr(core, "UPLOAD_FOLDER", str(tmp_path))

    def _queue_full(*_args, **_kwargs):
        raise JobQueueFullError("full")

    monkeypatch.setattr(core, "submit_background_job", _queue_full)

    response = client.post(
        "/api/account/export-bundle",
        json={"scope": "account", "include": {"account_json": True}},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 503
    assert "queue is busy" in response.get_json()["error"].lower()


def test_account_export_status_hides_other_users_jobs(client, monkeypatch):
    core.jobs["account-export-private"] = {
        "job_id": "account-export-private",
        "job_scope": "account-export",
        "user_id": "owner-u",
        "status": "completed",
    }
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "other-u", "email": "user@gmail.com"})

    response = client.get(
        "/api/account/exports/account-export-private",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 404
    assert response.get_json()["error"] == "Export not found"


def _download_completed_bundle_export(client, queued_response):
    assert queued_response.status_code == 202
    queued_payload = queued_response.get_json()
    status_response = client.get(queued_payload["status_url"], headers={"Authorization": "Bearer dev"})
    assert status_response.status_code == 200
    status_payload = status_response.get_json()
    assert status_payload["status"] == "completed"
    return client.get(status_payload["download_url"], headers={"Authorization": "Bearer dev"})


def test_account_export_bundle_returns_selected_folders_and_files(client, monkeypatch, tmp_path):
    class _PackDoc:
        def __init__(self, pack_id, payload):
            self.id = pack_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "bundle-u2", "email": "user@gmail.com", "auth_time": core.time.time()})
    monkeypatch.setattr(core, "UPLOAD_FOLDER", str(tmp_path))
    monkeypatch.setattr(core, "submit_background_job", lambda target, *args, **kwargs: target(*args, **kwargs))
    monkeypatch.setattr(
        core.study_repo,
        "list_study_packs_by_uid",
        lambda _db, _uid, _limit: [
            _PackDoc(
                "pack-1",
                {
                    "study_pack_id": "pack-1",
                    "title": "Biology Week 1",
                    "flashcards": [{"front": "Q1", "back": "A1"}],
                    "test_questions": [],
                    "notes_markdown": "",
                },
            )
        ],
    )
    monkeypatch.setattr(
        account_lifecycle,
        "collect_user_export_payload",
        lambda uid, email, runtime=None: {"meta": {"uid": uid, "email": email}, "collections": {}},
    )

    response = client.post(
        "/api/account/export-bundle",
        json={
            "scope": "account",
            "include": {
                "flashcards_csv": True,
                "account_json": True,
            },
        },
        headers={"Authorization": "Bearer dev"},
    )

    download = _download_completed_bundle_export(client, response)
    assert download.status_code == 200
    assert download.mimetype == "application/zip"
    with zipfile.ZipFile(io.BytesIO(download.data), "r") as archive:
        names = set(archive.namelist())
    assert "flashcards_csv/" in names
    assert "account_json/" in names
    assert any(name.startswith("flashcards_csv/") and name.endswith(".csv") for name in names)
    assert "account_json/account-export.json" in names
    assert not any(name.startswith("practice_tests_csv/") for name in names)
    assert not any(name.startswith("lecture_notes_docx/") for name in names)
    assert not any(name.startswith("lecture_notes_pdf_marked/") for name in names)
    assert not any(name.startswith("lecture_notes_pdf_unmarked/") for name in names)


def test_account_export_bundle_marked_and_unmarked_pdf_flags_are_independent(client, monkeypatch, tmp_path):
    class _PackDoc:
        def __init__(self, pack_id, payload):
            self.id = pack_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "bundle-u3", "email": "user@gmail.com", "auth_time": core.time.time()})
    monkeypatch.setattr(core, "UPLOAD_FOLDER", str(tmp_path))
    monkeypatch.setattr(core, "submit_background_job", lambda target, *args, **kwargs: target(*args, **kwargs))
    monkeypatch.setattr(
        core.study_repo,
        "list_study_packs_by_uid",
        lambda _db, _uid, _limit: [
            _PackDoc(
                "pack-2",
                {
                    "study_pack_id": "pack-2",
                    "title": "Calculus Midterm",
                    "flashcards": [],
                    "test_questions": [],
                    "notes_markdown": "# Notes",
                },
            )
        ],
    )

    def _fake_pdf(_pack, include_answers=True, runtime=None):
        _ = runtime
        return b"marked-pdf" if include_answers else b"unmarked-pdf"

    monkeypatch.setattr(study_export, "build_notes_pdf_bytes", _fake_pdf)

    marked_only = client.post(
        "/api/account/export-bundle",
        json={"scope": "account", "include": {"lecture_notes_pdf_marked": True}},
        headers={"Authorization": "Bearer dev"},
    )
    marked_download = _download_completed_bundle_export(client, marked_only)
    assert marked_download.status_code == 200
    with zipfile.ZipFile(io.BytesIO(marked_download.data), "r") as archive:
        marked_names = set(archive.namelist())
    assert any(name.startswith("lecture_notes_pdf_marked/") and name.endswith("-marked.pdf") for name in marked_names)
    assert not any(name.startswith("lecture_notes_pdf_unmarked/") and name.endswith("-unmarked.pdf") for name in marked_names)

    unmarked_only = client.post(
        "/api/account/export-bundle",
        json={"scope": "account", "include": {"lecture_notes_pdf_unmarked": True}},
        headers={"Authorization": "Bearer dev"},
    )
    unmarked_download = _download_completed_bundle_export(client, unmarked_only)
    assert unmarked_download.status_code == 200
    with zipfile.ZipFile(io.BytesIO(unmarked_download.data), "r") as archive:
        unmarked_names = set(archive.namelist())
    assert any(name.startswith("lecture_notes_pdf_unmarked/") and name.endswith("-unmarked.pdf") for name in unmarked_names)
    assert not any(name.startswith("lecture_notes_pdf_marked/") and name.endswith("-marked.pdf") for name in unmarked_names)


def test_account_export_bundle_limits_heavy_exports_and_writes_warning_manifest(client, monkeypatch, tmp_path):
    class _PackDoc:
        def __init__(self, pack_id, payload):
            self.id = pack_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "bundle-u4", "email": "user@gmail.com", "auth_time": core.time.time()})
    monkeypatch.setattr(core, "UPLOAD_FOLDER", str(tmp_path))
    monkeypatch.setattr(core, "submit_background_job", lambda target, *args, **kwargs: target(*args, **kwargs))
    monkeypatch.setattr(core, "ACCOUNT_EXPORT_MAX_CSV_PACKS", 1)
    monkeypatch.setattr(core, "ACCOUNT_EXPORT_MAX_DOCX_PACKS", 1)
    monkeypatch.setattr(core, "ACCOUNT_EXPORT_MAX_PDF_PACKS", 1)
    monkeypatch.setattr(
        core.study_repo,
        "list_study_packs_by_uid",
        lambda _db, _uid, _limit: [
            _PackDoc("pack-1", {"study_pack_id": "pack-1", "title": "Pack One", "flashcards": [{"front": "Q1", "back": "A1"}], "test_questions": [], "notes_markdown": "# Notes"}),
            _PackDoc("pack-2", {"study_pack_id": "pack-2", "title": "Pack Two", "flashcards": [{"front": "Q2", "back": "A2"}], "test_questions": [], "notes_markdown": "# Notes"}),
        ],
    )
    monkeypatch.setattr(study_export, "build_notes_docx_bytes", lambda *_args, **_kwargs: b"docx-bytes")
    monkeypatch.setattr(study_export, "build_notes_pdf_bytes", lambda *_args, **_kwargs: b"pdf-bytes")

    response = client.post(
        "/api/account/export-bundle",
        json={
            "scope": "account",
            "include": {
                "flashcards_csv": True,
                "lecture_notes_docx": True,
                "lecture_notes_pdf_marked": True,
            },
        },
        headers={"Authorization": "Bearer dev"},
    )

    download = _download_completed_bundle_export(client, response)
    assert download.status_code == 200
    with zipfile.ZipFile(io.BytesIO(download.data), "r") as archive:
        names = set(archive.namelist())
        warnings_payload = json.loads(archive.read("export_warnings.json").decode("utf-8"))
    assert "export_warnings.json" in names
    assert any(name.endswith("pack-1.csv") for name in names)
    assert any(name.endswith("pack-1.docx") for name in names)
    assert any(name.endswith("pack-1-marked.pdf") for name in names)
    assert not any(name.endswith("pack-2.csv") for name in names)
    omitted = {(entry["pack_id"], entry["reason"]) for entry in warnings_payload["omitted_exports"]}
    assert ("pack-2", "csv_pack_limit_exceeded") in omitted
    assert ("pack-2", "docx_pack_limit_exceeded") in omitted
    assert ("pack-2", "pdf_pack_limit_exceeded") in omitted


def test_account_delete_rejects_bad_confirmation_text(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u7", "email": "user@gmail.com", "auth_time": core.time.time()})

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "nope", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "invalid confirmation text" in response.get_json()["error"].lower()


def test_account_delete_rejects_when_active_jobs_exist(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u8", "email": "user@gmail.com", "auth_time": core.time.time()})
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 1)

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "DELETE MY ACCOUNT", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 409
    assert "cannot delete account while 1 queued or processing job" in response.get_json()["error"].lower()


def test_account_delete_success_path_returns_ok(client, monkeypatch, tmp_path):
    class _FakeProgressSnapshot:
        exists = False

    class _FakeProgressDoc:
        def get(self):
            return _FakeProgressSnapshot()

        def delete(self):
            return None

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u9", "email": "user@gmail.com", "auth_time": core.time.time()})
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(account_lifecycle, "mark_account_deletion_requested", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "mark_account_data_purge_started", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "mark_account_auth_delete_pending", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "mark_account_auth_deleted", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "mark_account_deletion_complete", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "query_docs_by_field", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(account_lifecycle, "has_docs_by_field", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(account_lifecycle, "remove_upload_artifacts_for_job_ids", lambda _job_ids, runtime=None: 0)
    monkeypatch.setattr(core.batch_repo, "list_batch_jobs_by_uid", lambda _db, _uid, _limit: [])
    monkeypatch.setattr(core.batch_repo, "list_batch_rows", lambda _db, _batch_id: [])
    monkeypatch.setattr(core, "get_study_progress_doc", lambda _uid: _FakeProgressDoc())
    monkeypatch.setattr(core.auth, "delete_user", lambda _uid: None)
    monkeypatch.setattr(core.users_repo, "delete_doc", lambda _db, _uid: None)
    core.AUDIO_IMPORT_TOKENS.clear()
    pending_audio = tmp_path / "pending-import.mp3"
    pending_audio.write_bytes(b"ID3\x03\x00\x00pending")
    token = upload_import_audio.register_audio_import_token("u9", str(pending_audio), runtime=core)

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "DELETE MY ACCOUNT", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["ok"] is True
    assert body["auth_user_deleted"] is True
    assert body["deleted"]["pending_audio_import_tokens"] == {"tokens": 1, "files": 1}
    assert token not in core.AUDIO_IMPORT_TOKENS
    assert not pending_audio.exists()


def test_account_delete_exhaustively_deletes_paginated_docs(client, monkeypatch):
    store = {
        "credit_charges": {
            **{f"charge-{idx}": {"uid": "u-delete", "charged_credits": 8} for idx in range(101)},
            "foreign-charge": {"uid": "another-user", "charged_credits": 2},
        },
        "credit_refunds": {
            **{f"refund-{idx}": {"uid": "u-delete", "amount": 1} for idx in range(101)},
            "foreign-refund": {"uid": "another-user", "amount": 1},
            "legacy-refund": {"uid_hash": "historical-hash", "amount": 1},
        },
        "job_logs": {
            f"log-{idx}": {"uid": "u-delete", "job_id": f"job-{idx}"}
            for idx in range(101)
        },
        "purchases": {},
        "analytics_events": {},
        "study_folders": {},
        "study_card_states": {},
        "study_shares": {
            "share-1": {"owner_uid": "u-delete", "entity_type": "pack", "entity_id": "pack-1", "access_scope": "public"},
        },
        "study_packs": {},
        "planner_sessions": {
            "planner-session-1": {"uid": "u-delete", "id": "planner-session-1", "title": "Review lecture"},
        },
        "planner_settings": {
            "planner-settings": {"uid": "u-delete", "enabled": "on", "offset": "15"},
        },
        "study_plan_preferences": {"u-delete": {"uid": "u-delete", "timezone": "UTC"}},
        "study_goals": {"goal-1": {"uid": "u-delete", "goal_id": "goal-1"}},
        "study_plan_proposals": {"u-delete": {"uid": "u-delete", "proposal_id": "proposal-1"}},
        "study_activity_sessions": {"activity-1": {"uid": "u-delete", "activity_id": "activity-1"}},
        "study_calendar_feeds": {"feed-1": {"uid": "u-delete", "feed_id": "feed-1", "secret_hash": "hash"}},
        "physio_cases": {
            "physio-case-1": {"uid": "u-delete", "case_id": "physio-case-1", "display_label": "Casus 1"},
        },
        "physio_case_sessions": {
            "physio-session-1": {"uid": "u-delete", "case_id": "physio-case-1", "session_id": "physio-session-1"},
        },
        "workout_profiles": {"u-delete": {"uid": "u-delete", "setup_completed": True}},
        "workout_exercises": {"exercise-1": {"uid": "u-delete", "id": "exercise-1"}},
        "workout_routines": {"routine-1": {"uid": "u-delete", "id": "routine-1"}},
        "workout_cycles": {"cycle-1": {"uid": "u-delete", "id": "cycle-1"}},
        "workout_occurrences": {"occurrence-1": {"uid": "u-delete", "id": "occurrence-1"}},
        "workout_sessions": {"session-1": {"uid": "u-delete", "id": "session-1"}},
        "workout_bodyweight": {"weight-1": {"uid": "u-delete", "id": "weight-1"}},
        "workout_shares": {"share-workout-1": {"uid": "u-delete", "token": "share-workout-1"}},
        core.RUNTIME_JOBS_COLLECTION: {},
        "batch_jobs": {},
    }
    deleted_profiles = []
    deleted_auth_users = []
    removed_artifact_sets = []

    class _DocReference:
        def __init__(self, collection_name, doc_id):
            self.collection_name = collection_name
            self.doc_id = doc_id

        def delete(self):
            store[self.collection_name].pop(self.doc_id, None)
            return None

        def set(self, payload, merge=False):
            existing = dict(store[self.collection_name].get(self.doc_id) or {})
            store[self.collection_name][self.doc_id] = dict(existing, **payload) if merge else dict(payload)
            return None

    class _Doc:
        def __init__(self, collection_name, doc_id):
            self.id = doc_id
            self.reference = _DocReference(collection_name, doc_id)
            self._collection_name = collection_name

        def to_dict(self):
            return dict(store[self._collection_name].get(self.id) or {})

    class _ProgressSnapshot:
        exists = False

    class _ProgressDoc:
        def get(self):
            return _ProgressSnapshot()

        def delete(self):
            return None

    def _query_docs_by_field(collection_name, field_name, field_value, limit, runtime=None):
        _ = runtime
        matches = []
        for doc_id, payload in list(store.get(collection_name, {}).items()):
            if str(payload.get(field_name, "")) != str(field_value):
                continue
            matches.append(_Doc(collection_name, doc_id))
            if len(matches) >= limit:
                break
        return matches

    def _has_docs_by_field(collection_name, field_name, field_value, runtime=None):
        _ = runtime
        return any(str(payload.get(field_name, "")) == str(field_value) for payload in store.get(collection_name, {}).values())

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-delete", "email": "user@gmail.com", "auth_time": core.time.time()})
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(account_lifecycle, "mark_account_deletion_requested", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "mark_account_data_purge_started", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "mark_account_auth_delete_pending", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "mark_account_auth_deleted", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "mark_account_deletion_complete", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "query_docs_by_field", _query_docs_by_field)
    monkeypatch.setattr(account_lifecycle, "has_docs_by_field", _has_docs_by_field)
    monkeypatch.setattr(
        account_lifecycle,
        "remove_upload_artifacts_for_job_ids",
        lambda job_ids, runtime=None: removed_artifact_sets.append(set(job_ids)) or len(job_ids),
    )
    monkeypatch.setattr(core.batch_repo, "list_batch_jobs_by_uid", lambda _db, _uid, _limit: [])
    monkeypatch.setattr(core.batch_repo, "list_batch_rows", lambda _db, _batch_id: [])
    monkeypatch.setattr(core, "get_study_progress_doc", lambda _uid: _ProgressDoc())
    monkeypatch.setattr(core.auth, "delete_user", lambda uid: deleted_auth_users.append(uid))
    monkeypatch.setattr(core.users_repo, "delete_doc", lambda _db, uid: deleted_profiles.append(uid))

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "DELETE MY ACCOUNT", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["deleted"]["job_logs"] == 101
    assert body["deleted"]["credit_charges"] == 101
    assert body["deleted"]["credit_refunds"] == 101
    assert store["credit_charges"] == {"foreign-charge": {"uid": "another-user", "charged_credits": 2}}
    assert store["credit_refunds"] == {
        "foreign-refund": {"uid": "another-user", "amount": 1},
        "legacy-refund": {"uid_hash": "historical-hash", "amount": 1},
    }
    assert body["deleted"]["planner_sessions"] == 1
    assert body["deleted"]["planner_settings"] == 1
    assert body["deleted"]["study_plan_preferences"] == 1
    assert body["deleted"]["study_goals"] == 1
    assert body["deleted"]["study_plan_proposals"] == 1
    assert body["deleted"]["study_activity_sessions"] == 1
    assert body["deleted"]["study_calendar_feeds"] == 1
    assert body["deleted"]["physio_cases"] == 1
    assert body["deleted"]["physio_case_sessions"] == 1
    assert body["deleted"]["study_shares"] == 1
    for workout_collection in (
        "workout_profiles",
        "workout_exercises",
        "workout_routines",
        "workout_cycles",
        "workout_occurrences",
        "workout_sessions",
        "workout_bodyweight",
        "workout_shares",
    ):
        assert body["deleted"][workout_collection] == 1
        assert store[workout_collection] == {}
    assert store["job_logs"] == {}
    assert store["planner_sessions"] == {}
    assert store["planner_settings"] == {}
    assert store["study_plan_preferences"] == {}
    assert store["study_goals"] == {}
    assert store["study_plan_proposals"] == {}
    assert store["study_activity_sessions"] == {}
    assert store["study_calendar_feeds"] == {}
    assert store["physio_cases"] == {}
    assert store["physio_case_sessions"] == {}
    assert store["study_shares"] == {}
    assert deleted_auth_users == ["u-delete"]
    assert deleted_profiles == ["u-delete"]
    assert removed_artifact_sets and len(removed_artifact_sets[0]) == 101


def test_account_delete_failure_after_purge_requires_retry_without_restoring_account(client, monkeypatch):
    class _FakeProgressSnapshot:
        exists = False

    class _FakeProgressDoc:
        def get(self):
            return _FakeProgressSnapshot()

        def delete(self):
            return None

    set_doc_calls = []
    retry_calls = []

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-restore", "email": "user@gmail.com", "auth_time": core.time.time()})
    monkeypatch.setattr(core, "db", object())
    monkeypatch.setattr("lecture_processor.services.calendar_sync_service.delete_account_connection", lambda _ctx, _uid: None)
    monkeypatch.setattr(account_lifecycle, "count_active_jobs_for_user", lambda _uid, runtime=None: 0)
    monkeypatch.setattr(
        account_lifecycle,
        "mark_account_deletion_requested",
        lambda _uid, email="", runtime=None: set_doc_calls.append((
            {
                "account_status": "deleting",
                "delete_requested_at": 1,
                "delete_started_at": 1,
                "email": email,
            },
            True,
        )) or True,
    )
    monkeypatch.setattr(
        account_lifecycle,
        "restore_account_after_failed_deletion",
        lambda _uid, email="", reason="", runtime=None, existing_state=None: set_doc_calls.append((
            {
                "account_status": "active",
                "delete_requested_at": 0,
                "delete_started_at": 0,
                "last_delete_failure_reason": str(reason),
                "email": email,
            },
            False,
        )) or True,
    )
    monkeypatch.setattr(account_lifecycle, "mark_account_data_purge_started", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(account_lifecycle, "mark_account_auth_delete_pending", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(
        account_lifecycle,
        "mark_account_deletion_retry_required",
        lambda _uid, email="", reason="", runtime=None: retry_calls.append({
            "uid": _uid,
            "email": email,
            "reason": str(reason),
        }) or True,
    )
    monkeypatch.setattr(account_lifecycle, "query_docs_by_field", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(account_lifecycle, "has_docs_by_field", lambda *_args, **_kwargs: False)
    monkeypatch.setattr(account_lifecycle, "remove_upload_artifacts_for_job_ids", lambda _job_ids, runtime=None: 0)
    monkeypatch.setattr(core.batch_repo, "list_batch_jobs_by_uid", lambda _db, _uid, _limit: [])
    monkeypatch.setattr(core.batch_repo, "list_batch_rows", lambda _db, _batch_id: [])
    monkeypatch.setattr(core, "get_study_progress_doc", lambda _uid: _FakeProgressDoc())
    monkeypatch.setattr(core.users_repo, "delete_doc", lambda _db, _uid: None)
    monkeypatch.setattr(core.auth, "delete_user", lambda _uid: (_ for _ in ()).throw(RuntimeError("auth delete failed")))

    response = client.post(
        "/api/account/delete",
        json={"confirm_text": "DELETE MY ACCOUNT", "confirm_email": "user@gmail.com"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 500
    assert set_doc_calls[0][0]["account_status"] == "deleting"
    assert len(set_doc_calls) == 1
    assert retry_calls[0]["uid"] == "u-restore"
    assert retry_calls[0]["reason"] == "Could not completely delete account data"
    assert response.get_json()["status"] == "deletion_retry_required"
