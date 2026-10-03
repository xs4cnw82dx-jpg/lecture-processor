"""Persistence helpers for planner sessions and synced reminder settings."""

from __future__ import annotations

from dataclasses import dataclass
from threading import RLock

from google.api_core.exceptions import NotFound

from .query_utils import apply_where

_SETTINGS_STORE = {}
_SESSIONS_STORE = {}
_PREFERENCES_STORE = {}
_GOALS_STORE = {}
_PROPOSALS_STORE = {}
_ACTIVITY_STORE = {}
_CALENDAR_FEED_STORE = {}
_PLAN_WRITE_LOCK = RLock()


class PlannerRevisionConflict(Exception):
    """A preview or edit no longer matches the committed planner state."""


def set_planner_session_if_revision(db, uid, session_id, payload, expected_revision):
    if db is None:
        with _PLAN_WRITE_LOCK:
            current = _memory_session(uid, session_id).to_dict()
            if int(current.get('revision', 0)) != expected_revision:
                raise PlannerRevisionConflict()
            set_planner_session(db, uid, session_id, payload, merge=False)
        return
    from google.cloud import firestore
    ref = planner_session_doc_ref(db, uid, session_id)

    @firestore.transactional
    def write(transaction):
        doc = ref.get(transaction=transaction)
        current = doc.to_dict() or {} if doc.exists else {}
        if int(current.get('revision', 0)) != expected_revision:
            raise PlannerRevisionConflict()
        transaction.set(ref, payload)

    write(db.transaction())


def commit_study_plan(db, uid, *, proposal, goal, preferences, sessions, cancellations, start_date, mark_dirty=None):
    """Validate the complete future schedule and publish a preview atomically."""
    def check(raw_proposal, raw_goal, raw_preferences, records):
        versions = {item['id']: int(item.get('revision', 0)) for item in records}
        runs = {item['id']: item['active_run_id'] for item in records if item.get('active_run_id')}
        if (raw_proposal.get('proposal_id') != proposal['proposal_id'] or raw_proposal.get('applied_at')
                or int(raw_goal.get('revision', 0)) != proposal['base_goal_revision']
                or int(raw_preferences.get('revision', 0)) != proposal['base_preferences_revision']
                or versions != proposal.get('base_session_versions', {})
                or runs != proposal.get('base_session_runs', {})):
            raise PlannerRevisionConflict()

    if db is None:
        with _PLAN_WRITE_LOCK:
            check(get_study_plan_proposal(db, uid, proposal['proposal_id']).to_dict(), get_study_goal(db, uid, goal['goal_id']).to_dict(),
                  get_study_plan_preferences(db, uid).to_dict(), list_planner_sessions_by_uid(db, uid, 2001, start_date=start_date))
            set_study_goal(db, uid, goal['goal_id'], goal, merge=False)
            set_study_plan_preferences(db, uid, preferences, merge=False)
            for item in cancellations + sessions:
                set_planner_session(db, uid, item['id'], item, merge=False)
            current = get_study_plan_proposal(db, uid).to_dict()
            if current.get('proposal_id') == proposal['proposal_id']:
                set_study_plan_proposal(db, uid, proposal)
            else:
                _set_memory_doc(_PROPOSALS_STORE, f"{uid}__{proposal['proposal_id']}", {**proposal, 'uid': uid}, merge=False)
        if mark_dirty:
            mark_dirty()
        return
    from google.cloud import firestore

    @firestore.transactional
    def write(transaction):
        current_proposal_ref = study_plan_proposal_doc_ref(db, uid)
        version_ref = study_plan_proposal_doc_ref(db, uid, proposal['proposal_id'])
        version_snapshot = version_ref.get(transaction=transaction)
        current_proposal = current_proposal_ref.get(transaction=transaction).to_dict() or {}
        proposal_ref = version_ref if version_snapshot.exists else current_proposal_ref
        goal_ref = study_goal_doc_ref(db, goal['goal_id'])
        preferences_ref = study_plan_preferences_doc_ref(db, uid)
        raw_proposal = proposal_ref.get(transaction=transaction).to_dict() or {}
        raw_goal = goal_ref.get(transaction=transaction).to_dict() or {}
        raw_preferences = preferences_ref.get(transaction=transaction).to_dict() or {}
        query = apply_where(apply_where(db.collection('planner_sessions'), 'uid', '==', uid), 'date', '>=', start_date)
        records = []
        for doc in transaction.get(query):
            raw = doc.to_dict() or {}
            raw.setdefault('id', doc.id.split('__', 1)[-1])
            records.append(raw)
        check(raw_proposal, raw_goal, raw_preferences, records)
        transaction.set(goal_ref, goal)
        transaction.set(preferences_ref, preferences)
        for item in cancellations + sessions:
            transaction.set(planner_session_doc_ref(db, uid, item['id']), item)
        transaction.set(proposal_ref, {**proposal, 'uid': uid})
        if proposal_ref is not current_proposal_ref and current_proposal.get('proposal_id') == proposal['proposal_id']:
            transaction.set(current_proposal_ref, {**proposal, 'uid': uid})
        if mark_dirty:
            mark_dirty(batch=transaction)

    write(db.transaction())


def archive_study_goal(db, uid, goal_id, *, expected_revision, today, now_ts, mark_dirty=None):
    """Archive a goal and cancel its future automatic commitments in one write."""
    def prepare(current, records):
        if current.get('uid') != uid:
            raise PlannerRevisionConflict()
        if current.get('status') == 'archived':
            return current, []
        if int(current.get('revision', 0)) != expected_revision:
            raise PlannerRevisionConflict()
        goal = {**current, 'status': 'archived', 'revision': expected_revision + 1, 'updated_at': now_ts}
        if len(records) > 2000:
            raise ValueError('There are too many future sessions to safely remove this goal. Contact support; nothing changed.')
        cancellations = [{**item, 'status': 'cancelled', 'cancellation_reason': 'goal_deleted',
                          'revision': int(item.get('revision', 0)) + 1, 'updated_at': now_ts}
                         for item in records if item.get('goal_id') == goal_id and item.get('origin') == 'automatic'
                         and item.get('status') == 'planned' and not item.get('active_run_id')]
        if len(cancellations) > 495:
            raise ValueError('This goal has too many future sessions to remove safely at once. Contact support; nothing changed.')
        return goal, cancellations

    if db is None:
        with _PLAN_WRITE_LOCK:
            goal, cancellations = prepare(get_study_goal(db, uid, goal_id).to_dict(),
                list_planner_sessions_by_uid(db, uid, 2001, start_date=today))
            set_study_goal(db, uid, goal_id, goal, merge=False)
            for item in cancellations:
                set_planner_session(db, uid, item['id'], item, merge=False)
        if mark_dirty:
            mark_dirty()
        return goal
    from google.cloud import firestore

    @firestore.transactional
    def write(transaction):
        goal_ref = study_goal_doc_ref(db, goal_id)
        current = goal_ref.get(transaction=transaction).to_dict() or {}
        query = apply_where(apply_where(db.collection('planner_sessions'), 'uid', '==', uid), 'date', '>=', today)
        records = []
        for doc in transaction.get(query):
            raw = doc.to_dict() or {}
            raw.setdefault('id', doc.id.split('__', 1)[-1])
            records.append(raw)
        goal, cancellations = prepare(current, records)
        transaction.set(goal_ref, goal)
        for item in cancellations:
            transaction.set(planner_session_doc_ref(db, uid, item['id']), item)
        if mark_dirty:
            mark_dirty(batch=transaction)
        return goal

    return write(db.transaction())


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


def _matches_session_filter(item, start_date='', start_time='', planned_only=False):
    if planned_only and str(item.get('status', 'planned') or 'planned').strip().lower() != 'planned':
        return False
    item_date = str(item.get('date', '') or '')
    if start_date and item_date < start_date:
        return False
    if start_time and item_date == start_date:
        item_time = str(item.get('time', '') or '')
        if len(item_time) == 5:
            item_time += ':00'
        if item_time < start_time:
            return False
    return True


def list_planner_sessions_by_uid(db, uid, limit, *, start_date=None, start_time=None, planned_only=False):
    safe_limit = max(1, int(limit or 1))
    safe_start_date = str(start_date or '').strip()
    safe_start_time = str(start_time or '').strip()
    if db is None:
        sessions = [item for item in _SESSIONS_STORE.get(uid, {}).values()
                    if _matches_session_filter(item, safe_start_date, safe_start_time, planned_only)]
        if safe_start_date:
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
    if planned_only or safe_start_time:
        # Legacy sessions may have no status field. Scan the existing indexed
        # date/time query in bounded pages, then limit matching results. A
        # status equality query would silently hide those planned sessions.
        page_size = max(50, min(200, safe_limit))
        records = []
        cursor = None
        while True:
            page_query = query.start_after(cursor) if cursor is not None else query
            docs = list(page_query.limit(page_size).stream())
            for doc in docs:
                payload = doc.to_dict() or {}
                if not payload or not _matches_session_filter(payload, safe_start_date, safe_start_time, planned_only):
                    continue
                payload.setdefault('id', str(doc.id).split('__', 1)[-1])
                records.append(payload)
                if len(records) >= safe_limit:
                    return records
            if len(docs) < page_size:
                return records
            cursor = docs[-1]
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


def study_plan_proposal_doc_ref(db, uid, proposal_id=''):
    return db.collection('study_plan_proposals').document(f'{uid}__{proposal_id}' if proposal_id else uid)


def get_study_plan_proposal(db, uid, proposal_id=''):
    key = f'{uid}__{proposal_id}' if proposal_id else uid
    if db is None:
        snapshot = _memory_snapshot(_PROPOSALS_STORE, key)
    else:
        doc = study_plan_proposal_doc_ref(db, uid, proposal_id).get()
        snapshot = PlannerSnapshot(bool(getattr(doc, 'exists', False)), doc.to_dict() or {} if getattr(doc, 'exists', False) else {})
    if proposal_id and not snapshot.exists:
        current = get_study_plan_proposal(db, uid)
        if current.to_dict().get('proposal_id') == proposal_id:
            return current
    return snapshot


def set_study_plan_proposal(db, uid, payload):
    safe_payload = {**dict(payload or {}), 'uid': uid}
    proposal_id = safe_payload.get('proposal_id', '')
    if db is None:
        _set_memory_doc(_PROPOSALS_STORE, uid, safe_payload, merge=False)
        if proposal_id:
            _set_memory_doc(_PROPOSALS_STORE, f'{uid}__{proposal_id}', safe_payload, merge=False)
        return
    batch = db.batch()
    batch.set(study_plan_proposal_doc_ref(db, uid), safe_payload)
    if proposal_id:
        batch.set(study_plan_proposal_doc_ref(db, uid, proposal_id), safe_payload)
    batch.commit()


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


def update_calendar_feed(db, feed_id, updates):
    """Change only supplied fields; never recreate a deleted connection."""
    if db is None:
        if feed_id not in _CALENDAR_FEED_STORE:
            return False
        _CALENDAR_FEED_STORE[feed_id] = {**_CALENDAR_FEED_STORE[feed_id], **dict(updates or {})}
        return True
    try:
        calendar_feed_doc_ref(db, feed_id).update(dict(updates or {}))
    except NotFound:
        return False
    return True


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
