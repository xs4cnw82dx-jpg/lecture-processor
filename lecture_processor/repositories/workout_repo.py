"""Server-owned Firestore persistence for the private workout tracker."""

from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass

from .query_utils import apply_where


PROFILE_COLLECTION = 'workout_profiles'
EXERCISE_COLLECTION = 'workout_exercises'
ROUTINE_COLLECTION = 'workout_routines'
CYCLE_COLLECTION = 'workout_cycles'
OCCURRENCE_COLLECTION = 'workout_occurrences'
SESSION_COLLECTION = 'workout_sessions'
BODYWEIGHT_COLLECTION = 'workout_bodyweight'
SHARE_COLLECTION = 'workout_shares'

WORKOUT_COLLECTIONS = (
    PROFILE_COLLECTION,
    EXERCISE_COLLECTION,
    ROUTINE_COLLECTION,
    CYCLE_COLLECTION,
    OCCURRENCE_COLLECTION,
    SESSION_COLLECTION,
    BODYWEIGHT_COLLECTION,
    SHARE_COLLECTION,
)

_MEMORY = {name: {} for name in WORKOUT_COLLECTIONS}


@dataclass
class WorkoutSnapshot:
    exists: bool
    payload: dict

    def to_dict(self):
        return deepcopy(self.payload or {})


def _document_key(uid: str, record_id: str) -> str:
    return f'{uid}__{record_id}'


def get_profile(db, uid: str) -> WorkoutSnapshot:
    if db is None:
        payload = _MEMORY[PROFILE_COLLECTION].get(uid)
        return WorkoutSnapshot(isinstance(payload, dict), deepcopy(payload or {}))
    doc = db.collection(PROFILE_COLLECTION).document(uid).get()
    return WorkoutSnapshot(bool(getattr(doc, 'exists', False)), doc.to_dict() or {})


def set_profile(db, uid: str, payload: dict) -> None:
    safe = deepcopy(payload or {})
    if db is None:
        _MEMORY[PROFILE_COLLECTION][uid] = safe
        return
    db.collection(PROFILE_COLLECTION).document(uid).set(safe, merge=False)


def get_record(db, collection_name: str, uid: str, record_id: str) -> WorkoutSnapshot:
    if collection_name not in _MEMORY:
        return WorkoutSnapshot(False, {})
    key = _document_key(uid, record_id)
    if db is None:
        payload = _MEMORY[collection_name].get(key)
        return WorkoutSnapshot(isinstance(payload, dict), deepcopy(payload or {}))
    doc = db.collection(collection_name).document(key).get()
    return WorkoutSnapshot(bool(getattr(doc, 'exists', False)), doc.to_dict() or {})


def set_record(db, collection_name: str, uid: str, record_id: str, payload: dict) -> None:
    if collection_name not in _MEMORY:
        raise ValueError('Unknown workout collection')
    key = _document_key(uid, record_id)
    safe = deepcopy(payload or {})
    safe['uid'] = uid
    safe['id'] = record_id
    if db is None:
        _MEMORY[collection_name][key] = safe
        return
    db.collection(collection_name).document(key).set(safe, merge=False)


def delete_record(db, collection_name: str, uid: str, record_id: str) -> None:
    if collection_name not in _MEMORY:
        return
    key = _document_key(uid, record_id)
    if db is None:
        _MEMORY[collection_name].pop(key, None)
        return
    db.collection(collection_name).document(key).delete()


def list_records(db, collection_name: str, uid: str, limit=500) -> list[dict]:
    if collection_name not in _MEMORY:
        return []
    safe_limit = max(1, min(int(limit or 1), 2000))
    if db is None:
        records = [deepcopy(item) for item in _MEMORY[collection_name].values() if isinstance(item, dict) and item.get('uid') == uid]
        return records[:safe_limit]
    query = apply_where(db.collection(collection_name), 'uid', '==', uid).limit(safe_limit)
    records = []
    for doc in query.stream():
        payload = doc.to_dict() or {}
        if payload:
            payload.setdefault('id', doc.id.split('__', 1)[-1])
            records.append(payload)
    return records


def get_share(db, token: str) -> WorkoutSnapshot:
    if db is None:
        payload = _MEMORY[SHARE_COLLECTION].get(token)
        return WorkoutSnapshot(isinstance(payload, dict), deepcopy(payload or {}))
    doc = db.collection(SHARE_COLLECTION).document(token).get()
    return WorkoutSnapshot(bool(getattr(doc, 'exists', False)), doc.to_dict() or {})


def set_share(db, token: str, payload: dict) -> None:
    safe = deepcopy(payload or {})
    safe['token'] = token
    if db is None:
        _MEMORY[SHARE_COLLECTION][token] = safe
        return
    db.collection(SHARE_COLLECTION).document(token).set(safe, merge=False)


def delete_share(db, token: str) -> None:
    if db is None:
        _MEMORY[SHARE_COLLECTION].pop(token, None)
        return
    db.collection(SHARE_COLLECTION).document(token).delete()


def clear_memory_state() -> None:
    for store in _MEMORY.values():
        store.clear()
