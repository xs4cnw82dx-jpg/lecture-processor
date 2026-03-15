"""Persistence helpers for Physio Assistant cases and sessions."""

from __future__ import annotations

from dataclasses import dataclass

from .query_utils import apply_where

_CASE_STORE = {}
_SESSION_STORE = {}


@dataclass
class _MemorySnapshot:
    exists: bool
    payload: dict
    id: str

    def to_dict(self):
        return dict(self.payload or {})


class _MemoryReference:
    def __init__(self, collection_name, doc_id):
        self.collection_name = str(collection_name or "").strip()
        self.id = str(doc_id or "").strip()

    def get(self):
        if self.collection_name == "physio_cases":
            payload = _CASE_STORE.get(self.id)
        else:
            payload = _SESSION_STORE.get(self.id)
        if not isinstance(payload, dict):
            return _MemorySnapshot(False, {}, self.id)
        return _MemorySnapshot(True, dict(payload), self.id)

    def set(self, payload, merge=False):
        safe_payload = dict(payload or {})
        if self.collection_name == "physio_cases":
            existing = dict(_CASE_STORE.get(self.id, {}))
            _CASE_STORE[self.id] = {**existing, **safe_payload} if merge else safe_payload
        else:
            existing = dict(_SESSION_STORE.get(self.id, {}))
            _SESSION_STORE[self.id] = {**existing, **safe_payload} if merge else safe_payload
        return None

    def delete(self):
        if self.collection_name == "physio_cases":
            _CASE_STORE.pop(self.id, None)
        else:
            _SESSION_STORE.pop(self.id, None)
        return None


def _sort_payloads(items, *, key_name="updated_at", reverse=True):
    def _sort_key(item):
        if isinstance(item, tuple):
            _doc_id, payload = item
        else:
            payload = item
        try:
            return float((payload or {}).get(key_name, 0) or 0)
        except Exception:
            return 0.0

    return sorted(items, key=_sort_key, reverse=bool(reverse))


def physio_case_doc_ref(db, case_id):
    if db is None:
        return _MemoryReference("physio_cases", case_id)
    return db.collection("physio_cases").document(case_id)


def create_physio_case_doc_ref(db):
    if db is None:
        next_id = f"physio-case-{len(_CASE_STORE) + 1}"
        return _MemoryReference("physio_cases", next_id)
    return db.collection("physio_cases").document()


def get_physio_case_doc(db, case_id):
    return physio_case_doc_ref(db, case_id).get()


def set_physio_case(db, case_id, payload, merge=True):
    return physio_case_doc_ref(db, case_id).set(dict(payload or {}), merge=merge)


def delete_physio_case(db, case_id):
    return physio_case_doc_ref(db, case_id).delete()


def list_physio_cases_by_uid(db, uid, limit=200):
    safe_uid = str(uid or "").strip()
    safe_limit = max(1, int(limit or 1))
    if db is None:
        records = []
        for case_id, payload in _sort_payloads(_CASE_STORE.items()):
            _case_id, case_payload = case_id, payload
            if str(case_payload.get("uid", "") or "").strip() != safe_uid:
                continue
            item = dict(case_payload)
            item.setdefault("case_id", str(item.get("case_id", "") or _case_id))
            records.append(item)
            if len(records) >= safe_limit:
                break
        return records
    query = apply_where(db.collection("physio_cases"), "uid", "==", safe_uid).limit(safe_limit)
    docs = list(query.stream())
    docs = sorted(
        docs,
        key=lambda doc: float((doc.to_dict() or {}).get("updated_at", 0) or 0),
        reverse=True,
    )
    records = []
    for doc in docs:
        payload = doc.to_dict() or {}
        payload.setdefault("case_id", str(payload.get("case_id", "") or doc.id))
        records.append(payload)
    return records


def physio_session_doc_ref(db, session_id):
    if db is None:
        return _MemoryReference("physio_case_sessions", session_id)
    return db.collection("physio_case_sessions").document(session_id)


def create_physio_session_doc_ref(db):
    if db is None:
        next_id = f"physio-session-{len(_SESSION_STORE) + 1}"
        return _MemoryReference("physio_case_sessions", next_id)
    return db.collection("physio_case_sessions").document()


def get_physio_session_doc(db, session_id):
    return physio_session_doc_ref(db, session_id).get()


def set_physio_session(db, session_id, payload, merge=True):
    return physio_session_doc_ref(db, session_id).set(dict(payload or {}), merge=merge)


def delete_physio_session(db, session_id):
    return physio_session_doc_ref(db, session_id).delete()


def list_physio_sessions_by_case(db, uid, case_id, limit=300):
    safe_uid = str(uid or "").strip()
    safe_case_id = str(case_id or "").strip()
    safe_limit = max(1, int(limit or 1))
    if db is None:
        records = []
        for session_id, payload in _sort_payloads(_SESSION_STORE.items()):
            _session_id, session_payload = session_id, payload
            if str(session_payload.get("uid", "") or "").strip() != safe_uid:
                continue
            if str(session_payload.get("case_id", "") or "").strip() != safe_case_id:
                continue
            item = dict(session_payload)
            item.setdefault("session_id", str(item.get("session_id", "") or _session_id))
            records.append(item)
            if len(records) >= safe_limit:
                break
        return records
    query = apply_where(db.collection("physio_case_sessions"), "uid", "==", safe_uid)
    query = apply_where(query, "case_id", "==", safe_case_id).limit(safe_limit)
    docs = list(query.stream())
    docs = sorted(
        docs,
        key=lambda doc: float((doc.to_dict() or {}).get("session_date_ts", (doc.to_dict() or {}).get("updated_at", 0)) or 0),
        reverse=True,
    )
    records = []
    for doc in docs:
        payload = doc.to_dict() or {}
        payload.setdefault("session_id", str(payload.get("session_id", "") or doc.id))
        records.append(payload)
    return records


def list_physio_sessions_by_uid(db, uid, limit=300):
    safe_uid = str(uid or "").strip()
    safe_limit = max(1, int(limit or 1))
    if db is None:
        records = []
        for session_id, payload in _sort_payloads(_SESSION_STORE.items()):
            _session_id, session_payload = session_id, payload
            if str(session_payload.get("uid", "") or "").strip() != safe_uid:
                continue
            item = dict(session_payload)
            item.setdefault("session_id", str(item.get("session_id", "") or _session_id))
            records.append(item)
            if len(records) >= safe_limit:
                break
        return records
    query = apply_where(db.collection("physio_case_sessions"), "uid", "==", safe_uid).limit(safe_limit)
    docs = list(query.stream())
    docs = sorted(
        docs,
        key=lambda doc: float((doc.to_dict() or {}).get("updated_at", 0) or 0),
        reverse=True,
    )
    records = []
    for doc in docs:
        payload = doc.to_dict() or {}
        payload.setdefault("session_id", str(payload.get("session_id", "") or doc.id))
        records.append(payload)
    return records


def clear_memory_state():
    _CASE_STORE.clear()
    _SESSION_STORE.clear()
