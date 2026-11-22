from datetime import datetime, timezone
from types import SimpleNamespace

import pytest

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.runtime.container import get_runtime
from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures("disable_sentry")


@pytest.fixture
def allow_progress_account_access(monkeypatch):
    # These progress-shape tests use minimal database fakes. Transactional
    # account-deletion behavior is exercised in test_study_progress_rollup.py.
    monkeypatch.setattr(account_lifecycle, 'require_account_access', lambda *_args, **_kwargs: None)


def test_merge_streak_data_keeps_most_recent_progress_day():
    server = {
        "last_study_date": "2026-02-26",
        "current_streak": 4,
        "daily_progress_date": "2026-02-26",
        "daily_progress_count": 7,
    }
    incoming = {
        "last_study_date": "2026-02-25",
        "current_streak": 1,
        "daily_progress_date": "2026-02-25",
        "daily_progress_count": 2,
    }

    merged = core.merge_streak_data(server, incoming)

    assert merged["last_study_date"] == "2026-02-26"
    assert merged["current_streak"] == 4
    assert merged["daily_progress_date"] == "2026-02-26"
    assert merged["daily_progress_count"] == 7


def test_merge_card_state_entries_keeps_counts_monotonic():
    server = {
        "seen": 5,
        "correct": 4,
        "wrong": 1,
        "level": "familiar",
        "interval_days": 7,
        "next_review_date": "2026-02-28",
        "last_review_date": "2026-02-26",
        "difficulty": "hard",
    }
    incoming = {
        "seen": 2,
        "correct": 2,
        "wrong": 0,
        "level": "familiar",
        "interval_days": 1,
        "next_review_date": "2026-02-27",
        "last_review_date": "2026-02-27",
        "difficulty": "easy",
    }

    merged = core.merge_card_state_entries(server, incoming)

    assert merged["seen"] == 5
    assert merged["correct"] == 4
    assert merged["wrong"] == 1
    assert merged["last_review_date"] == "2026-02-27"
    assert merged["next_review_date"] == "2026-02-27"
    assert merged["interval_days"] == 1
    assert merged["difficulty"] == "easy"


def test_merge_card_state_entries_keeps_interaction_metadata_and_mastery_history():
    server = {
        "seen": 4,
        "correct": 4,
        "wrong": 0,
        "level": "mastered",
        "interval_days": 21,
        "max_interval_days": 21,
        "next_review_date": "2026-03-10",
        "last_review_date": "2026-03-01",
        "difficulty": "easy",
        "last_action": "easy",
        "flip_count": 2,
        "write_count": 1,
    }
    incoming = {
        "seen": 5,
        "correct": 4,
        "wrong": 1,
        "level": "familiar",
        "interval_days": 1,
        "max_interval_days": 21,
        "next_review_date": "2026-03-05",
        "last_review_date": "2026-03-05",
        "difficulty": "hard",
        "last_action": "hard",
        "flip_count": 4,
        "write_count": 2,
    }

    merged = core.merge_card_state_entries(server, incoming)

    assert merged["seen"] == 5
    assert merged["correct"] == 4
    assert merged["wrong"] == 1
    assert merged["interval_days"] == 1
    assert merged["max_interval_days"] == 21
    assert merged["difficulty"] == "hard"
    assert merged["last_action"] == "hard"
    assert merged["flip_count"] == 4
    assert merged["write_count"] == 2
    assert merged["level"] == "familiar"


def test_get_study_progress_pack_returns_only_requested_pack_state(client, monkeypatch):
    class _FakeSnapshot:
        def __init__(self, payload=None, exists=True):
            self._payload = payload or {}
            self.exists = exists

        def to_dict(self):
            return dict(self._payload)

    class _FakeProgressDoc:
        def get(self):
            return _FakeSnapshot(
                {
                    "daily_goal": 12,
                    "timezone": "Europe/Amsterdam",
                    "streak_data": {
                        "last_study_date": "2026-06-28",
                        "current_streak": 3,
                        "longest_streak": 5,
                    },
                },
                exists=True,
            )

    class _FakeCardStateDoc:
        def __init__(self, pack_id):
            self.pack_id = pack_id

        def get(self):
            return _FakeSnapshot(
                {
                    "uid": "u-pack-progress",
                    "pack_id": self.pack_id,
                    "state": {
                        "fc_1": {
                            "seen": 1,
                            "correct": 1,
                            "wrong": 0,
                            "interval_days": 1,
                            "next_review_date": "2026-06-28",
                            "last_review_date": "2026-06-27",
                        }
                    },
                },
                exists=True,
            )

    class _FakePackDoc:
        exists = True

        def to_dict(self):
            return {"uid": "u-pack-progress", "study_pack_id": "pack-42"}

    runtime = get_runtime(client.application)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-pack-progress", "email": "user@gmail.com"})
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _FakePackDoc())
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda _uid: _FakeProgressDoc(), raising=False)
    monkeypatch.setattr(runtime, "get_study_card_state_doc", lambda _uid, pack_id: _FakeCardStateDoc(pack_id), raising=False)

    response = client.get(
        "/api/study-progress/packs/pack-42",
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    body = response.get_json()
    assert body["daily_goal"] == 12
    assert body["timezone"] == "Europe/Amsterdam"
    assert set(body["card_states"].keys()) == {"pack-42"}
    assert body["card_states"]["pack-42"]["fc_1"]["seen"] == 1
    assert body["summary"]["due_today"] >= 1


def test_update_study_progress_empty_card_state_payload_does_not_delete_existing_pack(allow_progress_account_access, allow_account_writes, client, monkeypatch):
    class _FakeSnapshot:
        def __init__(self, payload=None, exists=True):
            self._payload = payload or {}
            self.exists = exists

        def to_dict(self):
            return dict(self._payload)

    class _FakeProgressDoc:
        def __init__(self):
            self.set_calls = []

        def get(self):
            return _FakeSnapshot({}, exists=False)

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))
            return None

    class _FakeCardStateDoc:
        def __init__(self):
            self.set_calls = []
            self.delete_calls = 0

        def get(self):
            return _FakeSnapshot(
                {
                    "uid": "u10",
                    "pack_id": "pack-1",
                    "state": {"fc_1": {"seen": 1, "correct": 1, "wrong": 0, "interval_days": 1, "last_review_date": "2026-02-26"}},
                },
                exists=True,
            )

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))
            return None

        def delete(self):
            self.delete_calls += 1
            return None

    class _FakePackDoc:
        exists = True

        def to_dict(self):
            return {"uid": "u10", "study_pack_id": "pack-1"}

    fake_progress_doc = _FakeProgressDoc()
    fake_card_doc = _FakeCardStateDoc()
    runtime = get_runtime(client.application)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u10", "email": "user@gmail.com"})
    monkeypatch.setattr(runtime, "db", object(), raising=False)
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _FakePackDoc())
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda _uid: fake_progress_doc, raising=False)
    monkeypatch.setattr(runtime, "get_study_card_state_doc", lambda _uid, _pack_id: fake_card_doc, raising=False)
    monkeypatch.setattr(core.study_repo, "list_all_study_card_states_by_uid", lambda *_args, **_kwargs: [fake_card_doc.get()])
    monkeypatch.setattr(core.study_repo, "get_study_pack_owner_docs", lambda *_args, **_kwargs: [SimpleNamespace(id="pack-1", exists=True, to_dict=lambda: {"uid": "u10"})])

    response = client.put(
        "/api/study-progress",
        json={"card_states": {"pack-1": {}}},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 200
    assert fake_progress_doc.set_calls, "progress doc should still be updated"
    assert fake_card_doc.delete_calls == 0
    assert fake_card_doc.set_calls == []


def test_update_study_progress_rejects_unknown_pack_without_writes(allow_progress_account_access, client, monkeypatch):
    class _FakeSnapshot:
        exists = False

        def to_dict(self):
            return {}

    class _FakeProgressDoc:
        def __init__(self):
            self.set_calls = []

        def get(self):
            return _FakeSnapshot()

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))

    fake_progress_doc = _FakeProgressDoc()
    runtime = get_runtime(client.application)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-progress-unknown", "email": "user@gmail.com"})
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(runtime, "db", object(), raising=False)
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda _uid: fake_progress_doc, raising=False)
    # Ownership is a projected uid read; a missing pack returns no owner document.
    monkeypatch.setattr(core.study_repo, "get_study_pack_owner_docs", lambda _db, _ids, transaction=None: [])

    response = client.put(
        "/api/study-progress",
        json={"card_states": {"missing-pack": {"fc_1": {"seen": 1}}}},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 404
    assert fake_progress_doc.set_calls == []


def test_update_study_progress_invalid_card_states_returns_400_without_writes(client, monkeypatch):
    class _FakeSnapshot:
        exists = False

        def to_dict(self):
            return {}

    class _FakeProgressDoc:
        def __init__(self):
            self.set_calls = []

        def get(self):
            return _FakeSnapshot()

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))

    class _FakeCardDoc:
        def __init__(self):
            self.set_calls = []
            self.delete_calls = 0

        def get(self):
            return _FakeSnapshot()

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))

        def delete(self):
            self.delete_calls += 1

    fake_progress_doc = _FakeProgressDoc()
    fake_card_doc = _FakeCardDoc()
    runtime = get_runtime(client.application)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-invalid-cards", "email": "user@gmail.com"})
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda _uid: fake_progress_doc, raising=False)
    monkeypatch.setattr(runtime, "get_study_card_state_doc", lambda _uid, _pack_id: fake_card_doc, raising=False)

    response = client.put(
        "/api/study-progress",
        json={"card_states": ["not", "an", "object"]},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert fake_progress_doc.set_calls == []
    assert fake_card_doc.set_calls == []
    assert fake_card_doc.delete_calls == 0


def test_update_study_progress_invalid_remove_pack_ids_returns_400_without_writes(client, monkeypatch):
    class _FakeSnapshot:
        exists = False

        def to_dict(self):
            return {}

    class _FakeProgressDoc:
        def __init__(self):
            self.set_calls = []

        def get(self):
            return _FakeSnapshot()

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))

    class _FakeCardDoc:
        def __init__(self):
            self.set_calls = []
            self.delete_calls = 0

        def get(self):
            return _FakeSnapshot()

        def set(self, payload, merge=False):
            self.set_calls.append((payload, merge))

        def delete(self):
            self.delete_calls += 1

    fake_progress_doc = _FakeProgressDoc()
    fake_card_doc = _FakeCardDoc()
    runtime = get_runtime(client.application)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u-invalid-remove", "email": "user@gmail.com"})
    monkeypatch.setattr(account_lifecycle, "ensure_account_allows_writes", lambda _uid, runtime=None: (True, ""))
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda _uid: fake_progress_doc, raising=False)
    monkeypatch.setattr(runtime, "get_study_card_state_doc", lambda _uid, _pack_id: fake_card_doc, raising=False)

    response = client.put(
        "/api/study-progress",
        json={"remove_pack_ids": "pack-1"},
        headers={"Authorization": "Bearer dev"},
    )

    assert response.status_code == 400
    assert fake_progress_doc.set_calls == []
    assert fake_card_doc.set_calls == []
    assert fake_card_doc.delete_calls == 0


def test_compute_study_progress_summary_uses_server_logic_for_overview():
    now = datetime(2026, 10, 3, 12, tzinfo=timezone.utc)
    today = now.strftime("%Y-%m-%d")
    tomorrow = (now + core.timedelta(days=1)).strftime("%Y-%m-%d")

    progress_data = {
        "daily_goal": 30,
        "streak_data": {
            "last_study_date": today,
            "current_streak": 6,
            "daily_progress_date": today,
            "daily_progress_count": 9,
        },
    }
    card_state_maps = [
        {
            "fc_1": {"seen": 1, "correct": 1, "wrong": 0, "interval_days": 1, "next_review_date": today},
            "fc_2": {"seen": 1, "correct": 1, "wrong": 0, "interval_days": 1, "next_review_date": tomorrow},
        }
    ]

    summary = core.compute_study_progress_summary(progress_data, card_state_maps, base_now=now)

    assert summary["daily_goal"] == 30
    assert summary["current_streak"] == 6
    assert summary["today_progress"] == 9
    assert summary["due_today"] == 1


def test_compute_study_progress_summary_respects_timezone_boundary():
    base_now = datetime(2026, 2, 25, 23, 30, tzinfo=timezone.utc)
    progress_data = {
        "daily_goal": 20,
        "timezone": "Europe/Amsterdam",
        "streak_data": {
            "last_study_date": "2026-02-26",
            "current_streak": 3,
            "daily_progress_date": "2026-02-26",
            "daily_progress_count": 2,
        },
    }

    summary = core.compute_study_progress_summary(progress_data, [], base_now=base_now)

    assert summary["current_streak"] == 3
    assert summary["today_progress"] == 2


def test_compute_study_progress_summary_invalid_timezone_falls_back_to_utc():
    base_now = datetime(2026, 2, 25, 23, 30, tzinfo=timezone.utc)
    progress_data = {
        "daily_goal": 20,
        "timezone": "Invalid/Timezone",
        "streak_data": {
            "last_study_date": "2026-02-26",
            "current_streak": 3,
            "daily_progress_date": "2026-02-26",
            "daily_progress_count": 2,
        },
    }

    summary = core.compute_study_progress_summary(progress_data, [], base_now=base_now)

    assert summary["current_streak"] == 0
    assert summary["today_progress"] == 0


def test_compute_study_progress_summary_timezone_yesterday_window():
    base_now = datetime(2026, 2, 26, 0, 30, tzinfo=timezone.utc)
    progress_data = {
        "daily_goal": 25,
        "timezone": "Pacific/Honolulu",
        "streak_data": {
            "last_study_date": "2026-02-24",
            "current_streak": 4,
            "daily_progress_date": "2026-02-25",
            "daily_progress_count": 3,
        },
    }

    summary = core.compute_study_progress_summary(progress_data, [], base_now=base_now)

    assert summary["current_streak"] == 4
    assert summary["today_progress"] == 3
    assert summary["daily_goal"] == 25


def test_get_study_progress_summary_rebuilds_unversioned_compact_summaries_from_state(allow_progress_account_access, client, monkeypatch):
    class _FakeSnapshot:
        def __init__(self, payload=None, exists=True):
            self._payload = payload or {}
            self.exists = exists

        def to_dict(self):
            return dict(self._payload)

    class _FakeProgressDoc:
        def get(self):
            return _FakeSnapshot({"daily_goal": 30, "timezone": "UTC"})

        def set(self, payload, merge=False):
            assert payload["card_state_due_by_date_version"] == 1
            assert payload["card_state_due_by_date"] == {"2000-01-01": 2, "2099-01-01": 1}
            assert "card_state_due_by_date" in merge

    class _FakeSummaryDoc:
        id = "compact-u__pack-1"

        def to_dict(self):
            return {
                "uid": "compact-u",
                "pack_id": "pack-1",
                "state": {
                    "fc_1": {"seen": 1, "next_review_date": "2000-01-01"},
                    "fc_2": {"seen": 1, "next_review_date": "2000-01-01"},
                    "fc_3": {"seen": 1, "next_review_date": "2099-01-01"},
                },
                "summary": {
                    "due_by_date": {
                        "2000-01-01": 2,
                        "2099-01-01": 99,
                    }
                },
            }

    class _FakePackDoc:
        exists = True
        id = "pack-1"

        def to_dict(self):
            return {"uid": "compact-u", "study_pack_id": "pack-1"}

    runtime = get_runtime(client.application)

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "compact-u", "email": "user@gmail.com"})
    monkeypatch.setattr(runtime, "db", object(), raising=False)
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda _uid: _FakeProgressDoc(), raising=False)
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", lambda _db, _pack_id: _FakePackDoc())
    monkeypatch.setattr(
        core.study_repo,
        "list_all_study_card_states_by_uid",
        lambda *_args, **_kwargs: [_FakeSummaryDoc()],
    )
    monkeypatch.setattr(core.study_repo, "get_study_pack_owner_docs", lambda *_args, **_kwargs: [_FakePackDoc()])
    monkeypatch.setattr(
        runtime,
        "get_study_card_state_doc",
        lambda _uid, _pack_id: (_ for _ in ()).throw(AssertionError("full card state should not be loaded")),
        raising=False,
    )

    response = client.get("/api/study-progress/summary", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    payload = response.get_json()
    assert payload["daily_goal"] == 30
    assert payload["due_today"] == 2


def test_get_study_progress_summary_uses_rollup_without_scanning_pack_docs(client, monkeypatch):
    class _FakeSnapshot:
        def __init__(self, payload=None, exists=True):
            self._payload = payload or {}
            self.exists = exists

        def to_dict(self):
            return dict(self._payload)

    class _FakeProgressDoc:
        def get(self):
            return _FakeSnapshot(
                {
                    "daily_goal": 30,
                    "timezone": "UTC",
                    "card_state_due_by_date": {
                        "2000-01-01": 3,
                        "2099-01-01": 10,
                    },
                    "card_state_due_by_date_version": 1,
                }
            )

    runtime = get_runtime(client.application)
    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "rollup-u", "email": "user@gmail.com"})
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda _uid: _FakeProgressDoc(), raising=False)
    monkeypatch.setattr(
        core.study_repo,
        "list_all_study_card_states_by_uid",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("summary docs should not be scanned when rollup exists")),
    )

    response = client.get("/api/study-progress/summary", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    assert response.get_json()["due_today"] == 3


def test_get_study_progress_summary_falls_back_for_legacy_card_state_docs(allow_progress_account_access, client, monkeypatch):
    class _FakeSnapshot:
        def __init__(self, payload=None, exists=True):
            self._payload = payload or {}
            self.exists = exists

        def to_dict(self):
            return dict(self._payload)

    class _FakeProgressDoc:
        def __init__(self):
            self.writes = []

        def get(self):
            return _FakeSnapshot({"daily_goal": 20, "timezone": "UTC"})

        def set(self, payload, merge=False):
            self.writes.append((dict(payload), merge))

    class _LegacySummaryDoc:
        id = "legacy-u__pack-legacy"

        def to_dict(self):
            return {"pack_id": "pack-legacy"}

    class _FakeCardStateDoc:
        def to_dict(self):
            return {
                "uid": "legacy-u",
                "pack_id": "pack-legacy",
                "state": {
                    "fc_1": {"seen": 1, "next_review_date": "2000-01-01"},
                    "fc_2": {"seen": 1, "next_review_date": "2099-01-01"},
                },
            }

    runtime = get_runtime(client.application)
    progress_doc = _FakeProgressDoc()

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "legacy-u", "email": "user@gmail.com"})
    monkeypatch.setattr(runtime, "db", object(), raising=False)
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda _uid: progress_doc, raising=False)
    monkeypatch.setattr(
        core.study_repo,
        "list_study_card_state_summaries_by_uid",
        lambda _db, _uid, _limit: [_LegacySummaryDoc()],
    )

    monkeypatch.setattr(
        core.study_repo,
        "list_all_study_card_states_by_uid",
        lambda *_args, **_kwargs: [_FakeCardStateDoc()],
    )
    monkeypatch.setattr(core.study_repo, "get_study_pack_owner_docs", lambda *_args, **_kwargs: [SimpleNamespace(id="pack-legacy", exists=True, to_dict=lambda: {"uid": "legacy-u"})])
    monkeypatch.setattr(
        runtime,
        "get_study_card_state_doc",
        lambda *_args: (_ for _ in ()).throw(AssertionError("legacy fallback must not perform per-pack reads")),
        raising=False,
    )

    response = client.get("/api/study-progress/summary", headers={"Authorization": "Bearer dev"})

    assert response.status_code == 200
    assert response.get_json()["due_today"] == 1
    assert progress_doc.writes
    assert progress_doc.writes[0][0]["card_state_due_by_date"] == {
        "2000-01-01": 1,
        "2099-01-01": 1,
    }


def test_update_study_progress_merges_cross_browser_card_states(allow_progress_account_access, allow_account_writes, client, monkeypatch):
    class _FakeSnapshot:
        def __init__(self, payload=None, exists=False):
            self._payload = payload or {}
            self.exists = exists

        def to_dict(self):
            return dict(self._payload)

    class _FakeDocRef:
        def __init__(self, store, key):
            self.store = store
            self.key = key

        def get(self, transaction=None):
            _ = transaction
            payload = self.store.get(self.key)
            return _FakeSnapshot(payload, exists=payload is not None)

        def set(self, payload, merge=False):
            if merge and self.key in self.store and isinstance(self.store[self.key], dict):
                merged = dict(self.store[self.key])
                merged.update(payload or {})
                self.store[self.key] = merged
            else:
                self.store[self.key] = dict(payload or {})
            return None

        def delete(self):
            self.store.pop(self.key, None)
            return None

    class _FakeTransaction:
        def set(self, doc_ref, payload, merge=False):
            return doc_ref.set(payload, merge=merge)

        def delete(self, doc_ref):
            return doc_ref.delete()

    class _FakeDb:
        def __init__(self):
            self.transaction_count = 0

        def transaction(self):
            self.transaction_count += 1
            return _FakeTransaction()

    progress_store = {}
    card_state_store = {}
    runtime = get_runtime(client.application)
    fake_db = _FakeDb()

    def full_pack_read(*_args, **_kwargs):
        raise AssertionError("Progress sync must not read whole study packs")

    monkeypatch.setattr(core, "verify_firebase_token", lambda _request: {"uid": "u12", "email": "user@gmail.com"})
    monkeypatch.setattr(runtime, "db", fake_db, raising=False)
    monkeypatch.setattr(core.firestore, "transactional", lambda fn: fn, raising=False)
    monkeypatch.setattr(core.study_repo, "list_all_study_card_states_by_uid", lambda *_args, **_kwargs: [])
    owner_reads = []

    def owner_docs(_db, ids, transaction=None):
        owner_reads.append(sorted(ids))
        return [SimpleNamespace(id=pack_id, exists=True, to_dict=lambda: {"uid": "u12"}) for pack_id in ids]

    monkeypatch.setattr(core.study_repo, "get_study_pack_owner_docs", owner_docs)
    monkeypatch.setattr(core.study_repo, "get_study_pack_doc", full_pack_read)
    monkeypatch.setattr(core.study_repo, "study_pack_doc_ref", full_pack_read)
    monkeypatch.setattr(runtime, "get_study_progress_doc", lambda uid: _FakeDocRef(progress_store, uid), raising=False)
    monkeypatch.setattr(
        runtime,
        "get_study_card_state_doc",
        lambda uid, pack_id: _FakeDocRef(card_state_store, f"{uid}:{pack_id}"),
        raising=False,
    )

    browser_a_payload = {
        "daily_goal": 20,
        "timezone": "Europe/Amsterdam",
        "streak_data": {
            "last_study_date": "2026-02-25",
            "current_streak": 2,
            "daily_progress_date": "2026-02-25",
            "daily_progress_count": 4,
        },
        "card_states": {
            "pack-sync-1": {
                "fc_1": {
                    "seen": 2,
                    "correct": 2,
                    "wrong": 0,
                    "interval_days": 1,
                    "next_review_date": "2026-02-26",
                    "last_review_date": "2026-02-25",
                    "difficulty": "medium",
                }
            }
        },
    }
    browser_b_payload = {
        "timezone": "Europe/Amsterdam",
        "streak_data": {
            "last_study_date": "2026-02-26",
            "current_streak": 3,
            "daily_progress_date": "2026-02-26",
            "daily_progress_count": 1,
        },
        "card_states": {
            "pack-sync-1": {
                "fc_1": {
                    "seen": 1,
                    "correct": 1,
                    "wrong": 0,
                    "interval_days": 3,
                    "next_review_date": "2026-03-01",
                    "last_review_date": "2026-02-26",
                    "difficulty": "easy",
                },
                "fc_2": {
                    "seen": 1,
                    "correct": 1,
                    "wrong": 0,
                    "interval_days": 1,
                    "next_review_date": "2026-02-27",
                    "last_review_date": "2026-02-26",
                    "difficulty": "hard",
                },
            }
        },
    }

    r1 = client.put("/api/study-progress", json=browser_a_payload, headers={"Authorization": "Bearer dev"})
    r2 = client.put("/api/study-progress", json=browser_b_payload, headers={"Authorization": "Bearer dev"})

    assert r1.status_code == 200
    assert r2.status_code == 200
    assert fake_db.transaction_count == 2

    saved_progress = progress_store["u12"]
    assert saved_progress["daily_goal"] == 20
    assert saved_progress["timezone"] == "Europe/Amsterdam"
    assert saved_progress["streak_data"]["last_study_date"] == "2026-02-26"
    assert saved_progress["streak_data"]["current_streak"] == 3
    assert saved_progress["streak_data"]["daily_progress_date"] == "2026-02-26"
    assert saved_progress["streak_data"]["daily_progress_count"] == 1

    saved_cards = card_state_store["u12:pack-sync-1"]["state"]
    assert set(saved_cards.keys()) == {"fc_1", "fc_2"}
    assert saved_cards["fc_1"]["seen"] == 2
    assert saved_cards["fc_1"]["correct"] == 2
    assert saved_cards["fc_1"]["last_review_date"] == "2026-02-26"
    assert saved_cards["fc_1"]["interval_days"] == 3
    assert saved_cards["fc_1"]["next_review_date"] == "2026-03-01"
    assert saved_cards["fc_1"]["difficulty"] == "easy"
    assert saved_cards["fc_2"]["seen"] == 1
    assert card_state_store["u12:pack-sync-1"]["summary"]["due_by_date"] == {
        "2026-02-27": 1,
        "2026-03-01": 1,
    }
    assert saved_progress["card_state_due_by_date"] == {
        "2026-02-27": 1,
        "2026-03-01": 1,
    }
    # One projected owner read per sync, never a whole-pack read.
    assert [ids for ids in owner_reads if ids] == [["pack-sync-1"], ["pack-sync-1"]]
