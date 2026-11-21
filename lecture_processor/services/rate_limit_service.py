"""Rate limiting helpers with Firestore-first fallback strategy."""

import hashlib
from datetime import datetime, timezone

from lecture_processor.repositories import rate_limit_repo


def window_counter_id(key, window_seconds, window_start):
    raw = f"{key}|{window_seconds}|{int(window_start)}".encode('utf-8')
    return hashlib.sha256(raw).hexdigest()


def check_rate_limit_firestore(
    key,
    limit,
    window_seconds,
    now_ts,
    *,
    firestore_enabled,
    db,
    firestore_module,
    counter_collection,
):
    if not firestore_enabled or db is None:
        return None
    try:
        window_start = int(now_ts // window_seconds) * int(window_seconds)
        retry_after = max(1, int((window_start + window_seconds) - now_ts))
        counter_id = window_counter_id(key, window_seconds, window_start)
        counter_ref = rate_limit_repo.counter_doc_ref(db, counter_collection, counter_id)
        transaction = db.transaction()

        @firestore_module.transactional
        def _txn(txn):
            snapshot = counter_ref.get(transaction=txn)
            count = 0
            if snapshot.exists:
                count = int((snapshot.to_dict() or {}).get('count', 0) or 0)
            if count >= limit:
                return False, retry_after
            expires_at = window_start + (window_seconds * 3)
            txn.set(counter_ref, {
                'key': key,
                'count': count + 1,
                'window_start': window_start,
                'window_seconds': int(window_seconds),
                'updated_at': now_ts,
                'expires_at': expires_at,
                'expires_at_ts': datetime.fromtimestamp(expires_at, tz=timezone.utc),
            }, merge=True)
            return True, 0

        return _txn(transaction)
    except Exception:
        return None


MAX_IN_MEMORY_KEYS = 10000
_LONGEST_WINDOW_SECONDS = 86400


def _bound_in_memory_events(in_memory_events, now_ts):
    """Keep the process-local limiter bounded: callers can choose keys (for example a session id).

    Called with the limiter lock held. Expired keys go first; if needed, the least recently
    used keys are dropped, which can only make a limit slightly more permissive.
    """
    if len(in_memory_events) <= MAX_IN_MEMORY_KEYS:
        return
    cutoff = now_ts - _LONGEST_WINDOW_SECONDS
    for stale_key in [key for key, stamps in in_memory_events.items() if not stamps or stamps[-1] < cutoff]:
        del in_memory_events[stale_key]
    if len(in_memory_events) <= MAX_IN_MEMORY_KEYS:
        return
    newest_first = sorted(in_memory_events, key=lambda key: in_memory_events[key][-1], reverse=True)
    for evicted in newest_first[int(MAX_IN_MEMORY_KEYS * 0.9):]:
        del in_memory_events[evicted]


def check_rate_limit(
    key,
    limit,
    window_seconds,
    *,
    firestore_enabled,
    db,
    firestore_module,
    counter_collection,
    in_memory_events,
    in_memory_lock,
    time_module,
):
    now_ts = time_module.time()
    firestore_result = check_rate_limit_firestore(
        key,
        limit,
        window_seconds,
        now_ts,
        firestore_enabled=firestore_enabled,
        db=db,
        firestore_module=firestore_module,
        counter_collection=counter_collection,
    )
    if firestore_result is not None:
        return firestore_result

    with in_memory_lock:
        _bound_in_memory_events(in_memory_events, now_ts)
        timestamps = in_memory_events.get(key, [])
        cutoff = now_ts - window_seconds
        kept = [ts for ts in timestamps if ts >= cutoff]
        if len(kept) >= limit:
            oldest = kept[0]
            retry_after = max(1, int((oldest + window_seconds) - now_ts))
            in_memory_events[key] = kept
            return False, retry_after
        kept.append(now_ts)
        in_memory_events[key] = kept

    return True, 0
