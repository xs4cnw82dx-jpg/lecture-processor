import io
import json
import re
import zipfile
import pytest
from types import SimpleNamespace

from flask import request

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.admin import rollups as admin_rollups
from lecture_processor.domains.admin import metrics as admin_metrics
from lecture_processor.domains.ai import batch_orchestrator
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.study import export as study_export
from lecture_processor.services import upload_api_service
from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures("disable_sentry")


class _StoredDoc:
    def __init__(self, doc_id, store):
        self.id = doc_id
        self._store = store
        self.reference = _StoredRef(store, doc_id)

    @property
    def exists(self):
        return self.id in self._store

    def to_dict(self):
        return dict(self._store.get(self.id, {}))


class _StoredRef:
    def __init__(self, store, doc_id):
        self.id = doc_id
        self._store = store

    def get(self):
        return _StoredDoc(self.id, self._store)

    def set(self, payload, merge=False):
        if merge and self.id in self._store:
            existing = dict(self._store[self.id])
            existing.update(dict(payload))
            self._store[self.id] = existing
            return None
        self._store[self.id] = dict(payload)
        return None

    def delete(self):
        self._store.pop(self.id, None)


class _StaticDoc:
    def __init__(self, doc_id, payload):
        self.id = doc_id
        self._payload = dict(payload)
        self.reference = SimpleNamespace(id=doc_id)

    @property
    def exists(self):
        return True

    def to_dict(self):
        return dict(self._payload)


class _MissingDoc:
    id = ""
    reference = SimpleNamespace(id="")
    exists = False

    def to_dict(self):
        return {}


class _FakeUuidValue:
    def __init__(self, value):
        self.hex = value
        self._value = value

    def __str__(self):
        return self._value


def test_config_endpoint_shape(client, monkeypatch):
    monkeypatch.setattr(core, "STRIPE_PUBLISHABLE_KEY", "pk_test_contract")

    response = client.get("/api/config")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["stripe_publishable_key"] == "pk_test_contract"
    assert isinstance(payload.get("bundles"), dict)
    assert "lecture_5" in payload["bundles"]
    assert "interview_3" in payload["bundles"]


def test_security_headers_present_on_html_and_api_routes(client):
    html_response = client.get("/lecture-notes")
    api_response = client.get("/api/config")

    for response in (html_response, api_response):
        assert response.status_code == 200
        assert "Content-Security-Policy" in response.headers
        assert response.headers["Permissions-Policy"] == "camera=(), microphone=(self), geolocation=()"
        assert response.headers["X-Content-Type-Options"] == "nosniff"
        assert response.headers["Referrer-Policy"] == "strict-origin-when-cross-origin"
        assert response.headers["X-Frame-Options"] == "DENY"

    csp = html_response.headers["Content-Security-Policy"]
    assert "script-src" in csp
    assert "https://apis.google.com" in csp
    assert "https://identitytoolkit.googleapis.com" in csp
    assert "https://securetoken.googleapis.com" in csp
    assert "https://lecture-processor-cdff6.firebaseapp.com" in csp
    assert "https://accounts.google.com" in csp
    assert "script-src 'self' 'unsafe-inline'" not in csp
    assert "style-src 'self' 'unsafe-inline'" not in csp
    assert "style-src-attr" not in csp

    html_body = html_response.get_data(as_text=True)
    assert re.search(r'<script nonce="[^"]+">\s*window\.LectureProcessorRuntime', html_body, re.S)


def test_planner_api_requires_auth(client):
    assert client.get("/api/planner/settings").status_code == 401
    assert client.get("/api/planner/sessions").status_code == 401
    assert client.put("/api/planner/settings", json={}).status_code == 401
    assert client.put("/api/planner/sessions/session-one", json={}).status_code == 401
    assert client.delete("/api/planner/sessions/session-one").status_code == 401


def test_planner_api_crud_and_future_only_filter(client, monkeypatch):
    monkeypatch.setattr(core, "db", None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "planner-u1", "email": "u@example.com"})
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    core.planner_repo.clear_memory_state()

    settings_response = client.put(
        "/api/planner/settings",
        json={"enabled": "on", "offset": "15", "daily_enabled": "off", "daily_time": "08:30"},
        headers={"Authorization": "Bearer dev"},
    )
    assert settings_response.status_code == 200
    assert settings_response.get_json()["settings"]["offset"] == "15"

    future_response = client.put(
        "/api/planner/sessions/future-session",
        json={
            "title": "Future review",
            "date": "2099-04-01",
            "time": "09:30",
            "duration": 45,
            "notes": "Review chapter 4",
            "pack_id": "pack-1",
            "pack_title": "Biology",
        },
        headers={"Authorization": "Bearer dev"},
    )
    assert future_response.status_code == 200

    past_response = client.put(
        "/api/planner/sessions/past-session",
        json={
            "title": "Past review",
            "date": "2000-04-01",
            "time": "10:00",
            "duration": 30,
        },
        headers={"Authorization": "Bearer dev"},
    )
    assert past_response.status_code == 200

    all_sessions = client.get("/api/planner/sessions?limit=10", headers={"Authorization": "Bearer dev"})
    assert all_sessions.status_code == 200
    assert [item["id"] for item in all_sessions.get_json()["sessions"]] == ["past-session", "future-session"]

    future_only = client.get("/api/planner/sessions?future_only=1&limit=10", headers={"Authorization": "Bearer dev"})
    assert future_only.status_code == 200
    assert [item["id"] for item in future_only.get_json()["sessions"]] == ["future-session"]

    delete_response = client.delete("/api/planner/sessions/past-session", headers={"Authorization": "Bearer dev"})
    assert delete_response.status_code == 200
    remaining = client.get("/api/planner/sessions?limit=10", headers={"Authorization": "Bearer dev"})
    assert [item["id"] for item in remaining.get_json()["sessions"]] == ["future-session"]

    core.planner_repo.clear_memory_state()


def test_planner_api_respects_account_write_guard(client, monkeypatch):
    monkeypatch.setattr(core, "db", None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "planner-u2", "email": "u@example.com"})
    monkeypatch.setattr(
        account_lifecycle,
        "ensure_account_allows_writes",
        lambda _uid, runtime=None: (False, "Account deletion is in progress."),
    )

    response = client.put(
        "/api/planner/settings",
        json={"enabled": "on"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 409
    assert response.get_json()["status"] == "account_deletion_in_progress"


def test_admin_overview_uses_rollups_and_limited_recent_queries(client, monkeypatch):
    class _Doc:
        def __init__(self, payload):
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u1", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    now_ts = 1_762_000_000.0
    monkeypatch.setattr(core.time, "time", lambda: now_ts)
    monkeypatch.setattr(admin_metrics, "safe_count_collection", lambda collection_name, filters=None, runtime=None: 12 if collection_name == "users" else 34)
    monkeypatch.setattr(admin_metrics, "safe_count_window", lambda *_args, **_kwargs: 3)

    _labels, bucket_keys, _granularity = admin_metrics.build_time_buckets("7d", now_ts, runtime=core)
    rollups = []
    for index, bucket_key in enumerate(bucket_keys, start=1):
        funnel_counts = {stage["event"]: index for stage in core.ANALYTICS_FUNNEL_STAGES}
        rollups.append({
            "bucket_key": bucket_key,
            "purchases": {"count": 1, "total_revenue_cents": index * 100},
            "jobs": {
                "total": 2,
                "complete": 1,
                "error": 1,
                "refunded": 1 if index % 2 == 0 else 0,
                "duration_sum_seconds": float(index * 30),
                "duration_count": 1,
                "by_mode": {
                    "lecture-notes": {"total": 1, "complete": 1, "error": 0},
                    "slides-only": {"total": 1, "complete": 0, "error": 1},
                    "interview": {"total": 0, "complete": 0, "error": 0},
                    "other": {"total": 0, "complete": 0, "error": 0},
                },
            },
            "analytics": {
                "event_count": 5,
                "funnel_counts": funnel_counts,
            },
            "rate_limits": {"upload": 1, "checkout": 0, "analytics": 0, "tools": 0},
        })
    monkeypatch.setattr(admin_rollups, "load_window_rollups", lambda *_args, **_kwargs: rollups)

    query_calls = []

    def _safe_query_docs_in_window(collection_name, timestamp_field, window_start, window_end=None, order_desc=False, limit=None, filters=None, allow_unfiltered_fallback=True, runtime=None):
        query_calls.append({
            "collection_name": collection_name,
            "order_desc": order_desc,
            "limit": limit,
            "allow_unfiltered_fallback": allow_unfiltered_fallback,
        })
        if collection_name == "job_logs":
            return [_Doc({"job_id": "job-1", "email": "u@example.com", "mode": "lecture-notes", "status": "complete", "finished_at": now_ts, "duration_seconds": 42})]
        if collection_name == "purchases":
            return [_Doc({"uid": "admin-u1", "bundle_name": "Lecture 5", "price_cents": 999, "currency": "eur", "created_at": now_ts})]
        if collection_name == "rate_limit_logs":
            return [_Doc({"created_at": now_ts, "limit_name": "upload", "retry_after_seconds": 30})]
        return []

    monkeypatch.setattr(admin_metrics, "safe_query_docs_in_window", _safe_query_docs_in_window)

    response = client.get("/api/admin/overview?window=7d", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["metrics"]["total_users"] == 12
    assert payload["metrics"]["purchase_count"] == 7
    assert payload["metrics"]["total_revenue_cents"] == 2800
    assert payload["metrics"]["success_jobs"] == 7
    assert payload["metrics"]["failed_jobs"] == 7
    assert payload["metrics"]["rate_limit_429_total"] == 7
    assert payload["trends"]["revenue_cents"][0] == 100
    assert payload["recent_jobs"][0]["job_id"] == "job-1"
    assert payload["recent_purchases"][0]["bundle_name"] == "Lecture 5"
    assert payload["recent_rate_limits"][0]["limit_name"] == "upload"
    assert len(query_calls) == 3
    assert all(call["limit"] == 20 for call in query_calls)
    assert all(call["order_desc"] is True for call in query_calls)
    assert any(call["collection_name"] == "job_logs" and call["allow_unfiltered_fallback"] is True for call in query_calls)


def test_checkout_invalid_bundle_returns_400(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "contract-u1", "email": "u@example.com"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: True)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))

    response = client.post("/api/create-checkout-session", json={"bundle_id": "not_real"})

    assert response.status_code == 400
    assert "invalid bundle" in response.get_json()["error"].lower()


def test_status_not_found_contract(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "contract-u2", "email": "u@example.com"})

    response = client.get("/status/job-does-not-exist")

    assert response.status_code == 404
    body = response.get_json()
    assert body.get("job_lost") is True
    assert body.get("retryable") is True
    assert body.get("error_code") == "JOB_TEMPORARILY_UNAVAILABLE"
    assert "temporarily unavailable" in body.get("error", "").lower()


def test_active_runtime_jobs_contract_returns_only_active_regular_jobs(client, monkeypatch):
    class _Doc:
        def __init__(self, doc_id, payload):
            self.id = doc_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    monkeypatch.setattr(core, "db", object())
    monkeypatch.setattr(core, "run_startup_recovery_once", lambda: None)
    monkeypatch.setattr(batch_orchestrator, "run_startup_batch_recovery_once", lambda runtime=None: None)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "contract-active", "email": "u@example.com"})
    monkeypatch.setattr(
        core,
        "jobs",
        {
            "job-local-active": {
                "user_id": "contract-active",
                "mode": "lecture-notes",
                "status": "processing",
                "step": 2,
                "step_description": "Transcribing audio...",
                "study_pack_title": "Biology",
                "started_at": 200.0,
                "study_pack_id": "",
                "error": "",
                "is_batch": False,
            },
            "job-local-batch": {
                "user_id": "contract-active",
                "mode": "lecture-notes",
                "status": "processing",
                "step": 1,
                "step_description": "Queued",
                "started_at": 250.0,
                "is_batch": True,
            },
            "job-local-complete": {
                "user_id": "contract-active",
                "mode": "slides-only",
                "status": "complete",
                "step": 2,
                "step_description": "Complete!",
                "started_at": 150.0,
                "is_batch": False,
            },
            "job-other-user": {
                "user_id": "someone-else",
                "mode": "interview",
                "status": "processing",
                "step": 1,
                "step_description": "Transcribing",
                "started_at": 300.0,
                "is_batch": False,
            },
        },
    )
    monkeypatch.setattr(
        core.runtime_jobs_repo,
        "query_by_user_and_statuses",
        lambda *_args, **_kwargs: [
            _Doc(
                "job-persisted-active",
                {
                    "user_id": "contract-active",
                    "mode": "interview",
                    "status": "starting",
                    "step": 0,
                    "step_description": "Starting...",
                    "study_pack_title": "Hiring panel",
                    "started_at": 400.0,
                    "study_pack_id": "",
                    "error": "",
                    "is_batch": False,
                },
            )
        ],
    )

    response = client.get("/api/runtime-jobs/active", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    payload = response.get_json()
    assert [job["job_id"] for job in payload["jobs"]] == ["job-persisted-active", "job-local-active"]
    assert payload["jobs"][0]["study_pack_title"] == "Hiring panel"
    assert payload["jobs"][1]["step_description"] == "Transcribing audio..."


def test_stripe_webhook_requires_secret(client, monkeypatch):
    monkeypatch.setattr(core, "STRIPE_WEBHOOK_SECRET", "")

    response = client.post("/api/stripe-webhook", data=b"{}", headers={"Content-Type": "application/json"})

    assert response.status_code == 500
    assert response.get_json().get("error") == "Webhook not configured"


def test_study_pack_get_missing_returns_404(client, monkeypatch):
    class _MissingDoc:
        exists = False

    class _Collection:
        def document(self, _pack_id):
            return self

        def get(self):
            return _MissingDoc()

    class _DB:
        def collection(self, _name):
            return _Collection()

    monkeypatch.setattr(core, "db", _DB())
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "contract-u3", "email": "u@example.com"})

    response = client.get("/api/study-packs/missing-pack")

    assert response.status_code == 404
    assert "not found" in response.get_json().get("error", "").lower()


def test_study_pack_get_returns_source_export_flags(client, monkeypatch):
    class _Doc:
        exists = True

        def to_dict(self):
            return {
                "uid": "study-u-flags",
                "title": "Pack with sources",
                "mode": "lecture-notes",
                "notes_markdown": "# Notes",
                "flashcards": [],
                "test_questions": [],
                "created_at": 10,
            }

        @property
        def reference(self):
            return object()

    class _SourceDoc:
        exists = True

        def to_dict(self):
            return {
                "slide_text": "Slides",
                "transcript": "Transcript",
            }

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u-flags", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _Doc())
    monkeypatch.setattr(core.study_repo, "get_study_pack_source_doc", lambda _db, _pack_id: _SourceDoc())
    monkeypatch.setattr("lecture_processor.services.study_api_service.study_audio.ensure_pack_audio_storage_key", lambda *_args, **_kwargs: "")
    monkeypatch.setattr("lecture_processor.services.study_api_service.study_audio.get_audio_storage_key_from_pack", lambda *_args, **_kwargs: "")

    response = client.get("/api/study-packs/pack-with-sources", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["has_source_slides"] is True
    assert payload["has_source_transcript"] is True


def test_study_pack_list_uses_repo_order_and_count_fallback(client, monkeypatch):
    class _Doc:
        def __init__(self, doc_id, payload):
            self.id = doc_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u1", "email": "u@example.com"})
    monkeypatch.setattr(
        core.study_repo,
        "list_study_pack_summaries_by_uid",
        lambda _db, _uid, _limit, after_doc=None: [
            _Doc(
                "pack-new",
                {
                    "title": "Newest",
                    "mode": "manual",
                    "flashcards_count": 9,
                    "test_questions_count": 4,
                    "daily_card_goal": 32,
                    "created_at": 200,
                },
            ),
            _Doc(
                "pack-old",
                {
                    "title": "Older",
                    "mode": "manual",
                    "flashcards": [{"front": "a", "back": "b"}, {"front": "c", "back": "d"}],
                    "test_questions": [{"question": "Q1"}, {"question": "Q2"}, {"question": "Q3"}],
                    "created_at": 100,
                },
            ),
        ],
    )

    response = client.get("/api/study-packs", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    payload = response.get_json()
    packs = payload["study_packs"]
    assert [pack["study_pack_id"] for pack in packs] == ["pack-new", "pack-old"]
    assert packs[0]["flashcards_count"] == 9
    assert packs[0]["test_questions_count"] == 4
    assert packs[0]["daily_card_goal"] == 32
    assert packs[1]["flashcards_count"] == 2
    assert packs[1]["test_questions_count"] == 3
    assert packs[1]["daily_card_goal"] is None
    assert payload["has_more"] is False
    assert payload["next_cursor"] == ""


def test_study_pack_list_supports_cursor_pagination_contract(client, monkeypatch):
    class _Doc:
        def __init__(self, doc_id, payload):
            self.id = doc_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    repo_calls = {}

    def _get_doc(_db, pack_id):
        repo_calls["cursor_id"] = pack_id

        class _CursorDoc:
            exists = True

            def to_dict(self):
                return {"uid": "study-u1"}

        return _CursorDoc()

    def _list_docs(_db, _uid, limit, after_doc=None):
        repo_calls["limit"] = limit
        repo_calls["after_doc"] = after_doc
        return [
            _Doc("pack-b", {"title": "Pack B", "created_at": 200}),
            _Doc("pack-a", {"title": "Pack A", "created_at": 100}),
        ]

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u1", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", _get_doc)
    monkeypatch.setattr(core.study_repo, "list_study_pack_summaries_by_uid", _list_docs)

    response = client.get("/api/study-packs?limit=1&after=pack-cursor", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["has_more"] is True
    assert payload["next_cursor"] == "pack-b"
    assert [item["study_pack_id"] for item in payload["study_packs"]] == ["pack-b"]
    assert repo_calls["cursor_id"] == "pack-cursor"
    assert repo_calls["limit"] == 2


def test_study_pack_list_rejects_invalid_cursor(client, monkeypatch):
    class _MissingDoc:
        exists = False

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u1", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _MissingDoc())

    response = client.get("/api/study-packs?after=missing-pack", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 400
    assert "cursor" in response.get_json()["error"].lower()


def test_study_pack_get_returns_goal_and_notes_highlights(client, monkeypatch):
    class _Doc:
        exists = True

        def to_dict(self):
            return {
                "uid": "study-u2",
                "title": "Pack with highlights",
                "mode": "manual",
                "output_language": "English",
                "notes_markdown": "# Notes",
                "flashcards": [],
                "test_questions": [],
                "study_features": "both",
                "interview_features": [],
                "daily_card_goal": 24,
                "notes_highlights": {
                    "base_key": "pack-1:1:7",
                    "ranges": [{"start": 0, "end": 5, "color": "yellow"}],
                    "updated_at": 123.0,
                },
                "created_at": 10,
            }

        @property
        def reference(self):
            return object()

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u2", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _Doc())
    monkeypatch.setattr("lecture_processor.services.study_api_service.study_audio.ensure_pack_audio_storage_key", lambda *_args, **_kwargs: "")
    monkeypatch.setattr("lecture_processor.services.study_api_service.study_audio.get_audio_storage_key_from_pack", lambda *_args, **_kwargs: "")

    response = client.get("/api/study-packs/pack-1", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["daily_card_goal"] == 24
    assert payload["notes_highlights"]["base_key"] == "pack-1:1:7"
    assert payload["notes_highlights"]["ranges"] == [{"start": 0, "end": 5, "color": "yellow"}]


def test_study_pack_export_source_returns_markdown_download(client, monkeypatch):
    class _PackDoc:
        exists = True

        def to_dict(self):
            return {
                "uid": "study-export-u1",
                "title": "Biology Week 1",
                "mode": "lecture-notes",
            }

    class _SourceDoc:
        exists = True

        def to_dict(self):
            return {
                "slide_text": "# Slide Extract\n\nCell respiration",
                "transcript": "Transcript text",
            }

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-export-u1", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _PackDoc())
    monkeypatch.setattr(core.study_repo, "get_study_pack_source_doc", lambda _db, _pack_id: _SourceDoc())

    response = client.get(
        "/api/study-packs/pack-1/export-source?type=slides&format=md",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    assert response.mimetype == "text/markdown"
    assert "biology-week-1-slide-extract.md" in response.headers["Content-Disposition"]
    assert response.get_data(as_text=True) == "# Slide Extract\n\nCell respiration"


def test_study_pack_export_source_returns_404_when_requested_source_missing(client, monkeypatch):
    class _PackDoc:
        exists = True

        def to_dict(self):
            return {
                "uid": "study-export-u2",
                "title": "Interview pack",
                "mode": "interview",
            }

    class _SourceDoc:
        exists = True

        def to_dict(self):
            return {
                "slide_text": "",
                "transcript": "",
            }

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-export-u2", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _PackDoc())
    monkeypatch.setattr(core.study_repo, "get_study_pack_source_doc", lambda _db, _pack_id: _SourceDoc())

    response = client.get(
        "/api/study-packs/pack-2/export-source?type=transcript&format=md",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 404
    assert "no transcript source export" in response.get_json()["error"].lower()


def test_study_pack_export_source_rejects_non_owner(client, monkeypatch):
    class _PackDoc:
        exists = True

        def to_dict(self):
            return {
                "uid": "different-user",
                "title": "Other pack",
                "mode": "lecture-notes",
            }

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-export-u3", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _PackDoc())

    response = client.get(
        "/api/study-packs/pack-3/export-source?type=slides&format=md",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 403
    assert response.get_json()["error"] == "Forbidden"


def test_study_pack_create_accepts_daily_card_goal_and_notes_highlights(client, monkeypatch):
    stored = {}

    class _DocRef:
        id = "pack-created"

        def set(self, payload):
            stored.update(dict(payload))

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u3", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "create_study_pack_doc_ref", lambda _db: _DocRef())

    response = client.post(
        "/api/study-packs",
        json={
            "title": "Manual pack",
            "daily_card_goal": 18,
            "notes_markdown": "# Notes",
            "notes_highlights": {
                "base_key": "pack-created:1:7",
                "ranges": [{"start": 0, "end": 5, "color": "yellow"}],
                "updated_at": 456,
            },
        },
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    assert response.get_json()["study_pack_id"] == "pack-created"
    assert stored["daily_card_goal"] == 18
    assert stored["notes_highlights"]["ranges"] == [{"start": 0, "end": 5, "color": "yellow"}]


def test_study_pack_update_round_trips_daily_card_goal_and_notes_highlights(client, monkeypatch):
    stored = {
        "uid": "study-u4",
        "title": "Existing pack",
        "notes_markdown": "# Notes",
        "daily_card_goal": 12,
        "notes_highlights": None,
    }

    class _Doc:
        exists = True

        def to_dict(self):
            return dict(stored)

    class _DocRef:
        def get(self):
            return _Doc()

        def update(self, updates):
            stored.update(dict(updates))

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u4", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "study_pack_doc_ref", lambda _db, _pack_id: _DocRef())
    monkeypatch.setattr("lecture_processor.services.study_api_service.study_audio.ensure_pack_audio_storage_key", lambda *_args, **_kwargs: "")
    monkeypatch.setattr("lecture_processor.services.study_api_service.study_audio.get_audio_storage_key_from_pack", lambda *_args, **_kwargs: "")

    response = client.patch(
        "/api/study-packs/pack-1",
        json={
            "daily_card_goal": 40,
            "notes_highlights": {
                "base_key": "pack-1:2:7",
                "ranges": [{"start": 1, "end": 4, "color": "blue"}],
                "updated_at": 789,
            },
        },
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    assert stored["daily_card_goal"] == 40
    assert stored["notes_highlights"] == {
        "base_key": "pack-1:2:7",
        "ranges": [{"start": 1, "end": 4, "color": "blue"}],
        "updated_at": 789.0,
    }


def test_study_pack_update_rejects_invalid_notes_highlights(client, monkeypatch):
    class _Doc:
        exists = True

        def to_dict(self):
            return {"uid": "study-u5", "title": "Existing pack"}

    class _DocRef:
        def get(self):
            return _Doc()

        def update(self, _updates):
            raise AssertionError("Should not update for invalid highlight payload")

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u5", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "study_pack_doc_ref", lambda _db, _pack_id: _DocRef())
    monkeypatch.setattr("lecture_processor.services.study_api_service.study_audio.ensure_pack_audio_storage_key", lambda *_args, **_kwargs: "")
    monkeypatch.setattr("lecture_processor.services.study_api_service.study_audio.get_audio_storage_key_from_pack", lambda *_args, **_kwargs: "")

    response = client.patch(
        "/api/study-packs/pack-1",
        json={
            "notes_highlights": {
                "base_key": "pack-1:2:7",
                "ranges": [{"start": 8, "end": 3, "color": "blue"}],
                "updated_at": 789,
            },
        },
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert "notes_highlights" in response.get_json()["error"]


def test_study_pack_delete_respects_account_write_guard(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u-delete", "email": "u@example.com"})
    monkeypatch.setattr(
        account_lifecycle,
        "ensure_account_allows_writes",
        lambda _uid, runtime=None: (False, "Account deletion is in progress."),
    )

    response = client.delete("/api/study-packs/pack-1", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 409
    assert response.get_json()["status"] == "account_deletion_in_progress"


def test_study_folder_delete_respects_account_write_guard(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u-folder-delete", "email": "u@example.com"})
    monkeypatch.setattr(
        account_lifecycle,
        "ensure_account_allows_writes",
        lambda _uid, runtime=None: (False, "Account deletion is in progress."),
    )

    response = client.delete("/api/study-folders/folder-1", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 409
    assert response.get_json()["status"] == "account_deletion_in_progress"


def test_study_pack_annotated_pdf_export_returns_generated_pdf(client, monkeypatch):
    class _Doc:
        exists = True

        def to_dict(self):
            return {"uid": "study-u6", "title": "Annotated Neuro Pack"}

    captured = {}

    def _fake_build_annotated_notes_pdf(title, annotated_html, runtime=None):
        _ = runtime
        captured["title"] = title
        captured["annotated_html"] = annotated_html
        buffer = io.BytesIO(b"%PDF-1.4\nannotated")
        buffer.seek(0)
        return buffer

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "study-u6", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _Doc())
    monkeypatch.setattr(study_export, "build_annotated_notes_pdf", _fake_build_annotated_notes_pdf)

    response = client.post(
        "/api/study-packs/pack-1/export-annotated-pdf",
        json={"annotated_html": '<p><mark data-hl="yellow">Important</mark> note.</p>'},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    assert response.data.startswith(b"%PDF-")
    assert captured["title"] == "Annotated Neuro Pack"
    assert 'mark data-hl="yellow"' in captured["annotated_html"]
    assert "annotated-neuro-pack-annotated.pdf" in (response.headers.get("Content-Disposition") or "")


def test_admin_overview_contract_fields(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(core, "db", None)

    response = client.get("/api/admin/overview?window=7d")

    assert response.status_code == 200
    data = response.get_json()
    assert "window" in data
    assert "metrics" in data
    assert "recent_jobs" in data
    assert "recent_purchases" in data


def test_admin_overview_returns_partial_payload_when_rollup_loader_crashes(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(admin_rollups, "load_window_rollups", lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("missing firestore index")))
    monkeypatch.setattr(admin_metrics, "safe_count_collection", lambda *args, **kwargs: 0)
    monkeypatch.setattr(admin_metrics, "safe_count_window", lambda *args, **kwargs: 0)
    monkeypatch.setattr(admin_metrics, "safe_query_docs_in_window", lambda *args, **kwargs: [])

    response = client.get("/api/admin/overview?window=7d", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["recent_jobs"] == []
    assert payload["recent_purchases"] == []
    assert "admin_rollups:load_failed" in payload["data_warnings"]


def test_admin_overview_uses_filtered_job_count(client, monkeypatch):
    count_calls = []

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(admin_rollups, "load_window_rollups", lambda *_args, **_kwargs: [])
    monkeypatch.setattr(admin_metrics, "safe_count_collection", lambda collection_name, filters=None, runtime=None: count_calls.append((collection_name, filters)) or 0)
    monkeypatch.setattr(admin_metrics, "safe_count_window", lambda *args, **kwargs: 0)
    monkeypatch.setattr(admin_metrics, "safe_query_docs_in_window", lambda *args, **kwargs: [])

    response = client.get("/api/admin/overview?window=7d")

    assert response.status_code == 200
    assert ("job_logs", admin_metrics.admin_job_filters()) in count_calls


def test_admin_overview_returns_partial_payload_when_rollup_backfill_queries_fail(client, monkeypatch):
    class _RollupDoc:
        exists = False

        def to_dict(self):
            return {}

    class _RollupRef:
        def get(self):
            return _RollupDoc()

        def set(self, _payload, merge=False):
            _ = merge
            return None

    class _Collection:
        def __init__(self, name):
            self.name = name

        def document(self, _doc_id):
            return _RollupRef()

    class _DB:
        def collection(self, name):
            return _Collection(name)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(core, "db", _DB())
    monkeypatch.setattr(
        core.admin_repo,
        "query_docs_in_window",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(RuntimeError("missing firestore index")),
    )

    response = client.get("/api/admin/overview?window=7d", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["metrics"]["job_count"] == 0
    assert payload["recent_jobs"] == []
    assert "job_logs:query_failed" in payload["data_warnings"]


def test_admin_overview_uses_filtered_query_fallback_without_partial_warning(client, monkeypatch):
    class _Doc:
        def __init__(self, doc_id, payload):
            self.id = doc_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    class _RollupDoc:
        exists = True

        def __init__(self, payload=None):
            self._payload = payload or {}

        def to_dict(self):
            return dict(self._payload)

    class _RollupRef:
        def get(self):
            return _RollupDoc()

        def set(self, _payload, merge=False):
            _ = merge
            return None

    class _Collection:
        def __init__(self, name):
            self.name = name

        def document(self, _doc_id):
            return _RollupRef()

    class _DB:
        def collection(self, name):
            return _Collection(name)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(core, "db", _DB())
    monkeypatch.setattr(admin_rollups, "load_window_rollups", lambda *_args, **_kwargs: [])

    def _query_docs_in_window(_db, collection_name, timestamp_field, window_start, window_end=None, order_desc=False, limit=None, firestore_module=None, filters=None):
        _ = (_db, timestamp_field, window_start, window_end, order_desc, limit, firestore_module)
        if collection_name == "job_logs" and filters:
            raise RuntimeError("missing firestore index")
        if collection_name != "job_logs":
            return []
        return [
            _Doc("job-1", {"job_id": "job-1", "email": "u1@example.com", "mode": "lecture-notes", "status": "complete", "finished_at": 1, "admin_visible": True}),
            _Doc("job-2", {"job_id": "job-2", "email": "batch@example.com", "mode": "lecture-notes", "status": "complete", "finished_at": 1, "admin_visible": False}),
            _Doc("job-3", {"job_id": "job-3", "email": "u3@example.com", "mode": "interview", "status": "error", "finished_at": 1, "admin_visible": True}),
        ]

    monkeypatch.setattr(core.admin_repo, "query_docs_in_window", _query_docs_in_window)
    monkeypatch.setattr(core.admin_repo, "count_collection", lambda _db, collection_name, filters=None: 2 if collection_name == "job_logs" and filters else 0)
    monkeypatch.setattr(core.admin_repo, "count_window", lambda *_args, **_kwargs: 0)

    response = client.get("/api/admin/overview?window=7d", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["data_warnings"] == []
    assert payload["metrics"]["total_processed"] == 2
    assert [job["job_id"] for job in payload["recent_jobs"]] == ["job-1", "job-3"]


def test_admin_prompts_markdown_contract(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(core, "get_prompt_inventory_markdown", lambda: "# Prompt Inventory")

    response = client.get("/api/admin/prompts?format=markdown")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload.get("markdown") == "# Prompt Inventory"


def test_admin_batch_jobs_contract_fields(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(
        batch_orchestrator,
        "list_batches_for_admin",
        lambda statuses=None, limit=200, runtime=None: [
            {
                "batch_id": "batch-1",
                "uid": "u-1",
                "email": "u@example.com",
                "mode": "lecture-notes",
                "batch_title": "Batch A",
                "status": "processing",
                "total_rows": 2,
                "completed_rows": 1,
                "failed_rows": 0,
                "created_at": 1,
                "updated_at": 2,
                "current_stage": "audio_transcription",
                "current_stage_state": "running",
                "provider_state": "JOB_STATE_RUNNING",
                "completion_email_status": "pending",
                "credits_charged": 2,
                "credits_refunded": 0,
                "credits_refund_pending": 0,
            }
        ],
    )

    response = client.get("/api/admin/batch-jobs?status=processing&mode=lecture-notes&limit=50")

    assert response.status_code == 200
    payload = response.get_json()
    assert isinstance(payload.get("batches"), list)
    assert payload["batches"][0]["batch_id"] == "batch-1"
    assert payload["batches"][0]["status"] == "processing"


def test_admin_batch_jobs_hides_fixture_batches(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(
        batch_orchestrator,
        "list_batches_for_admin",
        lambda statuses=None, limit=200, runtime=None: [
            {
                "batch_id": "batch-hidden",
                "uid": "fixture-u",
                "email": "batch@example.com",
                "mode": "lecture-notes",
                "batch_title": "Batch Notify",
                "status": "error",
            },
            {
                "batch_id": "batch-real",
                "uid": "u-1",
                "email": "real@example.com",
                "mode": "lecture-notes",
                "batch_title": "Actual batch",
                "status": "processing",
            },
        ],
    )

    response = client.get("/api/admin/batch-jobs?limit=50")

    assert response.status_code == 200
    payload = response.get_json()
    assert [item["batch_id"] for item in payload["batches"]] == ["batch-real"]


def test_user_batch_jobs_list_contract_fields(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-batch", "email": "batch@example.com"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: True)
    monkeypatch.setattr(
        batch_orchestrator,
        "list_batches_for_uid",
        lambda uid, statuses=None, limit=100, runtime=None: [
            {
                "batch_id": "batch-1",
                "mode": "lecture-notes",
                "batch_title": "Batch A",
                "status": "queued",
                "total_rows": 2,
                "completed_rows": 0,
                "failed_rows": 0,
                "created_at": 1,
                "updated_at": 1,
                "current_stage": "file_upload",
                "current_stage_state": "running",
                "provider_state": "FILE_UPLOAD",
                "can_download_zip": False,
                "export_options": {"include_combined_docx": True},
                "completion_email_status": "pending",
                "credits_charged": 2,
                "credits_refunded": 0,
                "credits_refund_pending": 0,
            }
        ],
    )

    response = client.get("/api/batch/jobs?status=queued&mode=lecture-notes&limit=100")

    assert response.status_code == 200
    payload = response.get_json()
    assert isinstance(payload.get("batches"), list)
    assert payload["batches"][0]["batch_id"] == "batch-1"
    assert payload["batches"][0]["status"] == "queued"
    assert payload["batches"][0]["can_download_zip"] is False
    assert payload["batches"][0]["export_options"] == {"include_combined_docx": True}


def test_study_pack_share_contract_and_public_visibility(client, monkeypatch):
    share_store = {}

    def _find_share(_db, owner_uid, entity_type, entity_id):
        for share_token, payload in share_store.items():
            if (
                payload.get("owner_uid") == owner_uid
                and payload.get("entity_type") == entity_type
                and payload.get("entity_id") == entity_id
            ):
                return _StoredDoc(share_token, share_store)
        return None

    monkeypatch.setattr(core, "db", object())
    monkeypatch.setattr(core, "PUBLIC_BASE_URL", "https://share.example")
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "user-1", "email": "owner@example.com"})
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(core.time, "time", lambda: 123.0)
    monkeypatch.setattr(core.uuid, "uuid4", lambda: _FakeUuidValue("sharetoken123"))
    monkeypatch.setattr(
        core.study_repo,
        "get_study_pack_doc",
        lambda _db, pack_id: _StaticDoc(
            pack_id,
            {
                "uid": "user-1",
                "title": "Biology Pack",
                "notes_markdown": "Notes",
                "flashcards": [{"front": "What is ATP?", "back": "Energy currency"}],
                "test_questions": [],
                "folder_id": "",
                "folder_name": "",
                "created_at": 10,
            },
        ),
    )
    monkeypatch.setattr(core.study_repo, "find_study_share_by_owner_and_entity", _find_share)
    monkeypatch.setattr(core.study_repo, "create_study_share_doc_ref", lambda _db, share_token: _StoredRef(share_store, share_token))
    monkeypatch.setattr(core.study_repo, "get_study_share_doc", lambda _db, share_token: _StoredDoc(share_token, share_store))

    initial_response = client.get("/api/study-packs/pack-1/share", headers={"Authorization": "Bearer dev"})
    assert initial_response.status_code == 200
    assert initial_response.get_json() == {
        "entity_type": "pack",
        "entity_id": "pack-1",
        "access_scope": "private",
        "share_url": "",
        "updated_at": 0.0,
    }

    update_response = client.put(
        "/api/study-packs/pack-1/share",
        json={"access_scope": "public"},
        headers={"Authorization": "Bearer dev"},
    )

    assert update_response.status_code == 200
    share_payload = update_response.get_json()
    assert share_payload["entity_type"] == "pack"
    assert share_payload["entity_id"] == "pack-1"
    assert share_payload["access_scope"] == "public"
    assert share_payload["share_url"] == "https://share.example/shared/sharetoken123"
    assert share_payload["updated_at"] == 123.0

    pack_share_response = client.get("/api/shared/sharetoken123")
    assert pack_share_response.status_code == 200
    pack_payload = pack_share_response.get_json()
    assert pack_payload["entity_type"] == "pack"
    assert pack_payload["access_scope"] == "public"
    assert pack_payload["study_pack"]["study_pack_id"] == "pack-1"
    assert pack_payload["study_pack"]["title"] == "Biology Pack"

    private_response = client.put(
        "/api/study-packs/pack-1/share",
        json={"access_scope": "private"},
        headers={"Authorization": "Bearer dev"},
    )
    assert private_response.status_code == 200
    assert private_response.get_json()["access_scope"] == "private"

    hidden_response = client.get("/api/shared/sharetoken123")
    assert hidden_response.status_code == 404
    assert "not found" in hidden_response.get_json()["error"].lower()


def test_study_pack_share_requires_ownership(client, monkeypatch):
    monkeypatch.setattr(core, "db", object())
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "user-2", "email": "viewer@example.com"})
    monkeypatch.setattr(
        core.study_repo,
        "get_study_pack_doc",
        lambda _db, pack_id: _StaticDoc(pack_id, {"uid": "user-1", "title": "Private pack"}),
    )

    response = client.get("/api/study-packs/pack-1/share", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 403
    assert response.get_json()["error"] == "Forbidden"


def test_study_folder_public_share_contract_and_membership_guard(client, monkeypatch):
    share_store = {}
    pack_docs = {
        "pack-1": {
            "uid": "user-1",
            "title": "Earlier Pack",
            "folder_id": "folder-1",
            "folder_name": "Folder A",
            "flashcards": [],
            "test_questions": [],
            "created_at": 5,
        },
        "pack-2": {
            "uid": "user-1",
            "title": "Latest Pack",
            "folder_id": "folder-1",
            "folder_name": "Folder A",
            "notes_markdown": "Readable notes",
            "flashcards": [{"front": "What is DNA?", "back": "Genetic material"}],
            "test_questions": [{"question": "What is DNA?", "options": ["A", "B"], "answer": "A"}],
            "created_at": 20,
        },
        "pack-outside": {
            "uid": "user-1",
            "title": "Outside Pack",
            "folder_id": "folder-2",
            "folder_name": "Folder B",
            "created_at": 1,
        },
    }

    def _find_share(_db, owner_uid, entity_type, entity_id):
        for share_token, payload in share_store.items():
            if (
                payload.get("owner_uid") == owner_uid
                and payload.get("entity_type") == entity_type
                and payload.get("entity_id") == entity_id
            ):
                return _StoredDoc(share_token, share_store)
        return None

    monkeypatch.setattr(core, "db", object())
    monkeypatch.setattr(core, "PUBLIC_BASE_URL", "https://share.example")
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "user-1", "email": "owner@example.com"})
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(core.time, "time", lambda: 456.0)
    monkeypatch.setattr(core.uuid, "uuid4", lambda: _FakeUuidValue("foldershare456"))
    monkeypatch.setattr(
        core.study_repo,
        "get_study_folder_doc",
        lambda _db, folder_id: _StaticDoc(
            folder_id,
            {
                "uid": "user-1",
                "name": "Folder A",
                "course": "Biology",
                "created_at": 2,
                "updated_at": 9,
            },
        ),
    )
    monkeypatch.setattr(
        core.study_repo,
        "list_study_packs_by_uid_and_folder",
        lambda _db, uid, folder_id: [
            _StaticDoc("pack-1", pack_docs["pack-1"]),
            _StaticDoc("pack-2", pack_docs["pack-2"]),
        ],
    )
    monkeypatch.setattr(
        core.study_repo,
        "get_study_pack_doc",
        lambda _db, pack_id: _StaticDoc(pack_id, pack_docs[pack_id]) if pack_id in pack_docs else _MissingDoc(),
    )
    monkeypatch.setattr(core.study_repo, "find_study_share_by_owner_and_entity", _find_share)
    monkeypatch.setattr(core.study_repo, "create_study_share_doc_ref", lambda _db, share_token: _StoredRef(share_store, share_token))
    monkeypatch.setattr(core.study_repo, "get_study_share_doc", lambda _db, share_token: _StoredDoc(share_token, share_store))

    update_response = client.put(
        "/api/study-folders/folder-1/share",
        json={"access_scope": "public"},
        headers={"Authorization": "Bearer dev"},
    )

    assert update_response.status_code == 200
    assert update_response.get_json()["share_url"] == "https://share.example/shared/foldershare456"

    folder_response = client.get("/api/shared/foldershare456")
    assert folder_response.status_code == 200
    folder_payload = folder_response.get_json()
    assert folder_payload["entity_type"] == "folder"
    assert folder_payload["folder"]["folder_id"] == "folder-1"
    assert [item["study_pack_id"] for item in folder_payload["study_packs"]] == ["pack-2", "pack-1"]

    nested_pack_response = client.get("/api/shared/foldershare456/packs/pack-2")
    assert nested_pack_response.status_code == 200
    nested_pack_payload = nested_pack_response.get_json()
    assert nested_pack_payload["study_pack_id"] == "pack-2"
    assert nested_pack_payload["folder_id"] == "folder-1"

    outside_pack_response = client.get("/api/shared/foldershare456/packs/pack-outside")
    assert outside_pack_response.status_code == 404
    assert "not found" in outside_pack_response.get_json()["error"].lower()


def test_admin_cost_analysis_contract_fields(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(core, "db", None)

    response = client.post("/api/admin/cost-analysis", json={"period": "monthly", "usd_to_eur": 0.9})

    assert response.status_code == 200
    payload = response.get_json()
    assert "filters" in payload
    assert "summary" in payload
    assert "jobs" in payload
    assert "stages" in payload


def test_admin_route_requires_server_session_cookie(client):
    response = client.get("/admin", follow_redirects=False)
    assert response.status_code in {302, 301}
    assert response.headers.get("Location", "").endswith("/dashboard")


def test_admin_session_login_sets_cookie(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(core, "_extract_bearer_token", lambda _request: "id-token")
    monkeypatch.setattr(core.auth, "create_session_cookie", lambda _id_token, expires_in: "session-cookie")

    response = client.post("/api/session/login", headers={"Authorization": "Bearer test"})

    assert response.status_code == 200
    assert response.get_json().get("ok") is True
    set_cookie = response.headers.get("Set-Cookie", "")
    assert "lp_admin_session=session-cookie" in set_cookie


def test_admin_session_login_allows_admin_page_access(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)
    monkeypatch.setattr(core, "_extract_bearer_token", lambda _request: "id-token")
    monkeypatch.setattr(core.auth, "create_session_cookie", lambda _id_token, expires_in: "session-cookie")
    monkeypatch.setattr(core.auth, "verify_session_cookie", lambda _cookie, check_revoked=True: {"uid": "admin-u", "email": "admin@example.com"})

    login = client.post("/api/session/login", headers={"Authorization": "Bearer test"})
    assert login.status_code == 200
    raw_cookie = login.headers.get("Set-Cookie", "")
    cookie = raw_cookie.split(";", 1)[0]

    response = client.get("/admin", headers={"Cookie": cookie}, follow_redirects=False)

    assert response.status_code == 200
    assert "text/html" in response.content_type


def test_status_uses_runtime_job_fallback(client, monkeypatch):
    core.jobs.clear()
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-fallback", "email": "user@example.com"})
    monkeypatch.setattr(
        runtime_jobs_store,
        "load_runtime_job_snapshot",
        lambda _job_id, runtime=None: {
            "job_id": "job-fallback",
            "status": "processing",
            "step": 2,
            "step_description": "Processing",
            "total_steps": 3,
            "mode": "lecture-notes",
            "user_id": "u-fallback",
            "billing_receipt": {"charged": {"lecture_credits_standard": 1}, "refunded": {}},
        },
    )

    response = client.get("/status/job-fallback")

    assert response.status_code == 200
    body = response.get_json()
    assert body["status"] == "processing"
    assert body["step"] == 2


def test_verify_email_handles_empty_body(client, monkeypatch):
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))

    response = client.post("/api/verify-email", data=b"", headers={"Content-Type": "text/plain"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload.get("allowed") is False


def test_processing_averages_error_returns_empty_fallback_without_raw_details(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u", "email": "user@example.com"})

    class _BrokenDB:
        def collection(self, _name):
            raise RuntimeError("firestore internal detail")

    monkeypatch.setattr(core, "db", _BrokenDB())

    response = client.get("/api/processing-averages")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload.get("averages") == {}
    assert payload.get("total_jobs") == 0
    assert "error" not in payload


def test_processing_averages_success_uses_private_cache_header(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u", "email": "user@example.com"})

    class _Doc:
        def to_dict(self):
            return {
                "status": "complete",
                "mode": "lecture-notes",
                "duration_seconds": 123,
                "finished_at": 1,
            }

    class _Query:
        def where(self, *_args, **_kwargs):
            return self

        def order_by(self, *_args, **_kwargs):
            return self

        def limit(self, *_args, **_kwargs):
            return self

        def stream(self):
            return [_Doc()]

    class _DB:
        def collection(self, _name):
            return _Query()

    monkeypatch.setattr(core, "db", _DB())

    with client.application.test_request_context("/api/processing-averages"):
        response = upload_api_service.processing_averages(core, request)

    assert response.status_code == 200
    assert response.headers["Cache-Control"] == "private, max-age=300"


def test_processing_estimate_uses_sanitized_total_mb_and_percentiles(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u", "email": "user@example.com"})

    class _Doc:
        def __init__(self, row):
            self._row = row

        def to_dict(self):
            return dict(self._row)

    durations = [90, 100, 110, 120, 130, 140, 150, 160]
    docs = [
        _Doc({
            "status": "complete",
            "mode": "lecture-notes",
            "duration_seconds": d,
            "study_features": "both",
            "file_size_mb": 55.0,
        })
        for d in durations
    ]
    monkeypatch.setattr(admin_metrics, "safe_query_docs_in_window", lambda *_args, **_kwargs: docs)

    response = client.get("/api/processing-estimate?mode=lecture-notes&study_features=both&total_mb=55.25")

    assert response.status_code == 200
    payload = response.get_json()
    assert payload.get("source") == "strict"
    assert payload.get("sample_count") == 8
    assert payload["range"]["low_seconds"] > 0
    assert payload["range"]["typical_seconds"] >= payload["range"]["low_seconds"]
    assert payload["range"]["high_seconds"] >= payload["range"]["typical_seconds"]


def test_checkout_session_uses_trusted_public_base_url(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "checkout-u1", "email": "u@example.com"})
    monkeypatch.setattr(auth_policy, "is_email_allowed", lambda _email, runtime=None: True)
    monkeypatch.setattr(rate_limiter, "check_rate_limit", lambda **_kwargs: (True, 0))
    monkeypatch.setattr(core, "PUBLIC_BASE_URL", "https://trusted.example")

    captured = {}

    def _fake_create(**kwargs):
        captured.update(kwargs)
        return SimpleNamespace(url="https://checkout.stripe.test/session/abc")

    monkeypatch.setattr(core.stripe.checkout.Session, "create", _fake_create)

    response = client.post(
        "/api/create-checkout-session",
        json={"bundle_id": "lecture_5"},
        headers={
            "Authorization": "Bearer dev",
            "Host": "attacker.invalid",
        },
    )

    assert response.status_code == 200
    assert response.get_json().get("checkout_url", "").startswith("https://checkout.stripe.test/")
    assert captured.get("success_url", "").startswith("https://trusted.example/buy_credits?payment=success")
    assert captured.get("cancel_url") == "https://trusted.example/buy_credits?payment=cancelled"


def test_download_flashcards_csv_sanitizes_formula_like_cells(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "csv-u1", "email": "u@example.com"})
    monkeypatch.setattr(
        runtime_jobs_store,
        "get_job_snapshot",
        lambda _job_id, runtime=None: {
            "user_id": "csv-u1",
            "status": "complete",
            "flashcards": [{"front": "=front", "back": "+back"}],
            "test_questions": [],
        },
    )

    response = client.get("/download-flashcards-csv/job-1", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    csv_text = response.get_data(as_text=True)
    assert "'=front" in csv_text
    assert "'+back" in csv_text


def test_study_pack_flashcards_csv_export_sanitizes_formula_like_cells(client, monkeypatch):
    class _Doc:
        exists = True

        def to_dict(self):
            return {
                "uid": "csv-u2",
                "flashcards": [{"front": "@front", "back": "-back"}],
            }

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "csv-u2", "email": "u@example.com"})
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _Doc())

    response = client.get("/api/study-packs/pack-1/export-flashcards-csv", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    csv_text = response.get_data(as_text=True)
    assert "'@front" in csv_text
    assert "'-back" in csv_text


def test_index_auth_query_redirects_to_lecture_notes_modal_page(client):
    response = client.get("/?auth=signin", follow_redirects=False)

    assert response.status_code in {301, 302}
    assert response.headers.get("Location", "").endswith("/lecture-notes?auth=signin")


def test_admin_export_sanitizes_formula_like_cells(client, monkeypatch):
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "admin-u", "email": "admin@example.com"})
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: True)

    class _Doc:
        def __init__(self, doc_id, payload):
            self.id = doc_id
            self._payload = payload

        def to_dict(self):
            return dict(self._payload)

    docs = [
        _Doc(
            "job-1",
            {
                "job_id": "job-1",
                "uid": "u-1",
                "email": "=malicious@example.com",
                "mode": "lecture-notes",
                "source_type": "url",
                "source_url": "+https://evil.example",
                "custom_prompt": "-SUM(1,1)",
                "prompt_template_key": "@template",
                "prompt_source": "custom",
                "status": "complete",
                "credit_deducted": "slides_credits",
                "credit_refund_method": "",
                "credit_refunded": False,
                "error_message": "",
                "started_at": 1,
                "finished_at": 2,
                "duration_seconds": 1,
            },
        )
    ]
    monkeypatch.setattr(admin_metrics, "safe_query_docs_in_window", lambda **_kwargs: docs)

    response = client.get("/api/admin/export?type=jobs&window=7d", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    csv_text = response.get_data(as_text=True)
    assert "'=malicious@example.com" in csv_text
    assert "'+https://evil.example" in csv_text
    assert "'-SUM(1,1)" in csv_text
    assert "'@template" in csv_text


def test_safe_query_docs_in_window_skips_streaming_fallback(monkeypatch):
    monkeypatch.setattr(core, "db", object())

    def _raise(*_args, **_kwargs):
        raise RuntimeError("missing index")

    stream_called = {"value": False}

    def _stream(*_args, **_kwargs):
        stream_called["value"] = True
        return []

    monkeypatch.setattr(core, "query_docs_in_window", _raise)
    monkeypatch.setattr(core.admin_repo, "stream_collection", _stream)

    docs = core.safe_query_docs_in_window(
        collection_name="job_logs",
        timestamp_field="finished_at",
        window_start=1,
        window_end=2,
        order_desc=True,
    )

    assert docs == []
    assert stream_called["value"] is False
