"""Persistence helpers for planner sessions and synced reminder settings."""

from __future__ import annotations

from dataclasses import dataclass

from .query_utils import apply_where

_SETTINGS_STORE = {}
_SESSIONS_STORE = {}
_PREFERENCES_STORE = {}
_GOALS_STORE = {}
_PROPOSALS_STORE = {}
_ACTIVITY_STORE = {}
_CALENDAR_FEED_STORE = {}


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


def list_planner_sessions_by_uid(db, uid, limit, *, start_date=None):
    safe_limit = max(1, int(limit or 1))
    safe_start_date = str(start_date or '').strip()
    if db is None:
        sessions = list(_SESSIONS_STORE.get(uid, {}).values())
        if safe_start_date:
            sessions = [
                item for item in sessions
                if str(item.get('date', '') or '') >= safe_start_date
            ]
            sessions.sort(
                key=lambda item: (
                    str(item.get('date', '') or ''),
                    str(item.get('time', '') or ''),
                    str(item.get('id', '') or ''),
                )
            )
        return [dict(item) for item in sessions[:safe_limit]]
    query = apply_where(db.collection('planner_sessions'), 'uid', '==', uid)
    if safe_start_date:
        query = apply_where(query, 'date', '>=', safe_start_date)
        query = query.order_by('date', direction='ASCENDING').order_by('time', direction='ASCENDING')
    query = query.limit(safe_limit)
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
    _PREFERENCES_STORE.clear()
    _GOALS_STORE.clear()
    _PROPOSALS_STORE.clear()
    _ACTIVITY_STORE.clear()
    _CALENDAR_FEED_STORE.clear()


def _memory_snapshot(store, key):
    payload = store.get(key)
    if not isinstance(payload, dict):
        return PlannerSnapshot(False, {})
    return PlannerSnapshot(True, payload)


def _set_memory_doc(store, key, payload, merge=True):
    safe_payload = dict(payload or {})
    if merge:
        existing = dict(store.get(key, {}))
        existing.update(safe_payload)
        store[key] = existing
    else:
        store[key] = safe_payload


def study_plan_preferences_doc_ref(db, uid):
    return db.collection('study_plan_preferences').document(uid)


def get_study_plan_preferences(db, uid):
    if db is None:
        return _memory_snapshot(_PREFERENCES_STORE, uid)
    doc = study_plan_preferences_doc_ref(db, uid).get()
    return PlannerSnapshot(bool(getattr(doc, 'exists', False)), doc.to_dict() or {} if getattr(doc, 'exists', False) else {})


def set_study_plan_preferences(db, uid, payload, merge=True):
    safe_payload = dict(payload or {})
    safe_payload['uid'] = uid
    if db is None:
        _set_memory_doc(_PREFERENCES_STORE, uid, safe_payload, merge=merge)
        return
    study_plan_preferences_doc_ref(db, uid).set(safe_payload, merge=merge)


def study_goal_doc_ref(db, goal_id):
    return db.collection('study_goals').document(goal_id)


def get_study_goal(db, uid, goal_id):
    if db is None:
        return _memory_snapshot(_GOALS_STORE, f'{uid}__{goal_id}')
    doc = study_goal_doc_ref(db, goal_id).get()
    payload = doc.to_dict() or {} if getattr(doc, 'exists', False) else {}
    exists = bool(getattr(doc, 'exists', False)) and str(payload.get('uid', '') or '') == str(uid or '')
    return PlannerSnapshot(exists, payload if exists else {})


def set_study_goal(db, uid, goal_id, payload, merge=True):
    safe_payload = dict(payload or {})
    safe_payload['uid'] = uid
    if db is None:
        _set_memory_doc(_GOALS_STORE, f'{uid}__{goal_id}', safe_payload, merge=merge)
        return
    study_goal_doc_ref(db, goal_id).set(safe_payload, merge=merge)


def list_study_goals_by_uid(db, uid, limit=100):
    safe_limit = max(1, min(200, int(limit or 100)))
    if db is None:
        prefix = f'{uid}__'
        records = [dict(value) for key, value in _GOALS_STORE.items() if key.startswith(prefix)]
        records.sort(key=lambda item: (str(item.get('status', 'active')), str(item.get('exam_date', '9999-12-31')), str(item.get('title', '')).lower()))
        return records[:safe_limit]
    query = apply_where(db.collection('study_goals'), 'uid', '==', uid).limit(safe_limit)
    records = []
    for doc in query.stream():
        payload = doc.to_dict() or {}
        payload.setdefault('goal_id', doc.id)
        records.append(payload)
    records.sort(key=lambda item: (str(item.get('status', 'active')), str(item.get('exam_date', '9999-12-31')), str(item.get('title', '')).lower()))
    return records


def study_plan_proposal_doc_ref(db, uid):
    return db.collection('study_plan_proposals').document(uid)


def get_study_plan_proposal(db, uid):
    if db is None:
        return _memory_snapshot(_PROPOSALS_STORE, uid)
    doc = study_plan_proposal_doc_ref(db, uid).get()
    return PlannerSnapshot(bool(getattr(doc, 'exists', False)), doc.to_dict() or {} if getattr(doc, 'exists', False) else {})


def set_study_plan_proposal(db, uid, payload):
    safe_payload = dict(payload or {})
    safe_payload['uid'] = uid
    if db is None:
        _set_memory_doc(_PROPOSALS_STORE, uid, safe_payload, merge=False)
        return
    study_plan_proposal_doc_ref(db, uid).set(safe_payload, merge=False)


def study_activity_doc_ref(db, uid, session_id):
    return db.collection('study_activity_sessions').document(f'{uid}__{session_id}')


def get_study_activity(db, uid, session_id):
    if db is None:
        return _memory_snapshot(_ACTIVITY_STORE, f'{uid}__{session_id}')
    doc = study_activity_doc_ref(db, uid, session_id).get()
    return PlannerSnapshot(bool(getattr(doc, 'exists', False)), doc.to_dict() or {} if getattr(doc, 'exists', False) else {})


def set_study_activity(db, uid, session_id, payload, merge=True):
    safe_payload = dict(payload or {})
    safe_payload['uid'] = uid
    if db is None:
        _set_memory_doc(_ACTIVITY_STORE, f'{uid}__{session_id}', safe_payload, merge=merge)
        return
    study_activity_doc_ref(db, uid, session_id).set(safe_payload, merge=merge)


def list_study_activity_by_uid(db, uid, limit=500, start_ts=0):
    safe_limit = max(1, min(1000, int(limit or 500)))
    safe_start = max(0.0, float(start_ts or 0))
    if db is None:
        prefix = f'{uid}__'
        records = [dict(value) for key, value in _ACTIVITY_STORE.items() if key.startswith(prefix)]
        if safe_start:
            records = [item for item in records if float(item.get('started_at', 0) or 0) >= safe_start]
        records.sort(key=lambda item: float(item.get('started_at', 0) or 0), reverse=True)
        return records[:safe_limit]
    query = apply_where(db.collection('study_activity_sessions'), 'uid', '==', uid)
    if safe_start:
        query = apply_where(query, 'started_at', '>=', safe_start).order_by('started_at', direction='DESCENDING')
    query = query.limit(safe_limit)
    return [doc.to_dict() or {} for doc in query.stream()]


def calendar_feed_doc_ref(db, feed_id):
    return db.collection('study_calendar_feeds').document(feed_id)


def get_calendar_feed(db, feed_id):
    if db is None:
        return _memory_snapshot(_CALENDAR_FEED_STORE, feed_id)
    doc = calendar_feed_doc_ref(db, feed_id).get()
    return PlannerSnapshot(bool(getattr(doc, 'exists', False)), doc.to_dict() or {} if getattr(doc, 'exists', False) else {})


def set_calendar_feed(db, feed_id, payload, merge=True):
    if db is None:
        _set_memory_doc(_CALENDAR_FEED_STORE, feed_id, payload, merge=merge)
        return
    calendar_feed_doc_ref(db, feed_id).set(dict(payload or {}), merge=merge)


def list_calendar_feeds_by_uid(db, uid, limit=5, *, active_only=False):
    safe_limit = max(1, min(10, int(limit or 5)))
    if db is None:
        records = [dict(value) for value in _CALENDAR_FEED_STORE.values() if str(value.get('uid', '') or '') == str(uid or '')]
        if active_only:
            records = [item for item in records if not item.get('revoked_at')]
        records.sort(key=lambda item: float(item.get('created_at', 0) or 0), reverse=True)
        return records[:safe_limit]
    query = apply_where(db.collection('study_calendar_feeds'), 'uid', '==', uid)
    if active_only:
        query = apply_where(query, 'revoked_at', '==', 0)
    query = query.limit(safe_limit)
    records = [doc.to_dict() or {} for doc in query.stream()]
    records.sort(key=lambda item: float(item.get('created_at', 0) or 0), reverse=True)
    return records
