"""Nonblocking, process-local admission shared by media workers and routes."""

from threading import BoundedSemaphore, Lock


RETRY_AFTER_SECONDS = 5
BUSY_MESSAGE = 'Media processing is busy. Please try again shortly.'
_slot = BoundedSemaphore(1)
_lock = Lock()
_active_uids = set()


class _MediaLease:
    def __init__(self, uid):
        self._uid = uid
        self._released = False

    def release(self):
        with _lock:
            if self._released:
                return
            self._released = True
            _active_uids.discard(self._uid)
            _slot.release()


def try_acquire(uid):
    """Return a lease, or 429 for this account and 503 for a busy process."""
    uid = str(uid or '')
    with _lock:
        if uid in _active_uids:
            return None, 429
        if not _slot.acquire(blocking=False):
            return None, 503
        _active_uids.add(uid)
        return _MediaLease(uid), 0


def busy_response(app_ctx, status):
    response = app_ctx.jsonify({
        'error': BUSY_MESSAGE,
        'retry_after_seconds': RETRY_AFTER_SECONDS,
    })
    response.status_code = status
    response.headers['Retry-After'] = str(RETRY_AFTER_SECONDS)
    return response
