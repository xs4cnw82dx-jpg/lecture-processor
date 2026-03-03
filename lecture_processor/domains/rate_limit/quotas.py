import os
import shutil
from datetime import datetime, timezone

from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def has_sufficient_upload_disk_space(required_bytes=0, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    try:
        usage = shutil.disk_usage(
            resolved_runtime.UPLOAD_FOLDER if os.path.exists(resolved_runtime.UPLOAD_FOLDER) else '/'
        )
        free_bytes = int(usage.free)
    except Exception:
        return (True, 0, resolved_runtime.UPLOAD_MIN_FREE_DISK_BYTES)
    try:
        required = int(required_bytes or 0)
    except Exception:
        required = 0
    needed = max(resolved_runtime.UPLOAD_MIN_FREE_DISK_BYTES, required + resolved_runtime.UPLOAD_MIN_FREE_DISK_BYTES)
    return (free_bytes >= needed, free_bytes, needed)


def reserve_daily_upload_bytes(uid, requested_bytes, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if resolved_runtime.db is None:
        return (True, 0)
    if not uid:
        return (False, 0)
    try:
        requested = int(requested_bytes or 0)
    except Exception:
        requested = 0
    requested = max(0, requested)
    if requested <= 0:
        return (True, 0)

    now_ts = resolved_runtime.time.time()
    day_key = datetime.fromtimestamp(now_ts, tz=timezone.utc).strftime('%Y-%m-%d')
    doc_id = f'{uid}:{day_key}'
    retry_after = max(
        1,
        int(
            datetime.fromtimestamp(now_ts, tz=timezone.utc)
            .replace(hour=23, minute=59, second=59, microsecond=0)
            .timestamp()
            - now_ts
        ),
    )
    counter_ref = resolved_runtime.db.collection(resolved_runtime.UPLOAD_DAILY_COUNTER_COLLECTION).document(doc_id)
    transaction = resolved_runtime.db.transaction()

    @resolved_runtime.firestore.transactional
    def _txn(txn):
        snapshot = counter_ref.get(transaction=txn)
        used = 0
        if snapshot.exists:
            used = int((snapshot.to_dict() or {}).get('bytes_used', 0) or 0)
        if used + requested > resolved_runtime.UPLOAD_DAILY_BYTE_CAP:
            return (False, retry_after)
        txn.set(
            counter_ref,
            {
                'uid': uid,
                'day': day_key,
                'bytes_used': used + requested,
                'updated_at': now_ts,
                'expires_at': now_ts + 3 * 24 * 60 * 60,
            },
            merge=True,
        )
        return (True, 0)

    try:
        return _txn(transaction)
    except Exception:
        resolved_runtime.logger.warning('Upload daily byte reservation failed for uid=%s', uid, exc_info=True)
        return (True, 0)
