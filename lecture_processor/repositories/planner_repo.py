"""Persistence helpers for planner sessions and synced reminder settings."""

from __future__ import annotations

from dataclasses import dataclass

from .query_utils import apply_where

_SETTINGS_STORE = {}
_SESSIONS_STORE = {}


@dataclass
class PlannerSnapshot:
    exists: bool
    payload: dict

    def to_dict(self):
        return dict(self.payload or {})


def _memory_settings(uid):
    payload = _SETTINGS_STORE.get(uid)
    if not isinstance(payload, dict):
        return PlannerSnapshot(False, {})
    return PlannerSnapshot(True, payload)


def _memory_session(uid, session_id):
    payload = _SESSIONS_STORE.get(uid, {}).get(session_id)
    if not isinstance(payload, dict):
        return PlannerSnapshot(False, {})
    return PlannerSnapshot(True, payload)


def planner_settings_doc_ref(db, uid):
    return db.collection('planner_settings').document(uid)


def get_planner_settings(db, uid):
    if db is None:
        return _memory_settings(uid)
    doc = planner_settings_doc_ref(db, uid).get()
    if not getattr(doc, 'exists', False):
        return PlannerSnapshot(False, {})
    return PlannerSnapshot(True, doc.to_dict() or {})


def set_planner_settings(db, uid, payload, merge=True):
    safe_payload = dict(payload or {})
    if db is None:
        existing = dict(_SETTINGS_STORE.get(uid, {}))
        if merge:
            existing.update(safe_payload)
            _SETTINGS_STORE[uid] = existing
        else:
            _SETTINGS_STORE[uid] = safe_payload
        return
    planner_settings_doc_ref(db, uid).set(safe_payload, merge=merge)


def planner_session_doc_ref(db, uid, session_id):
    return db.collection('planner_sessions').document(f'{uid}__{session_id}')


def get_planner_session(db, uid, session_id):
    if db is None:
        return _memory_session(uid, session_id)
    doc = planner_session_doc_ref(db, uid, session_id).get()
    if not getattr(doc, 'exists', False):
        return PlannerSnapshot(False, {})
    return PlannerSnapshot(True, doc.to_dict() or {})


def set_planner_session(db, uid, session_id, payload, merge=True):
    safe_payload = dict(payload or {})
    if db is None:
        existing = dict(_SESSIONS_STORE.setdefault(uid, {}).get(session_id, {}))
        if merge:
            existing.update(safe_payload)
            _SESSIONS_STORE.setdefault(uid, {})[session_id] = existing
        else:
            _SESSIONS_STORE.setdefault(uid, {})[session_id] = safe_payload
        return
    planner_session_doc_ref(db, uid, session_id).set(safe_payload, merge=merge)


def delete_planner_session(db, uid, session_id):
    if db is None:
        _SESSIONS_STORE.setdefault(uid, {}).pop(session_id, None)
        return
    planner_session_doc_ref(db, uid, session_id).delete()


def list_planner_sessions_by_uid(db, uid, limit):
    safe_limit = max(1, int(limit or 1))
    if db is None:
        sessions = list(_SESSIONS_STORE.get(uid, {}).values())
        return [dict(item) for item in sessions[:safe_limit]]
    query = apply_where(db.collection('planner_sessions'), 'uid', '==', uid).limit(safe_limit)
    records = []
    for doc in query.stream():
        payload = doc.to_dict() or {}
        if not payload:
            continue
        payload.setdefault('id', str(payload.get('id', '') or doc.id.split('__', 1)[-1]))
        records.append(payload)
    return records


def clear_memory_state():
    _SETTINGS_STORE.clear()
    _SESSIONS_STORE.clear()
