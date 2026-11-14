"""Independent, process-local admission for downloads and slide conversion."""

from threading import BoundedSemaphore, Lock


RETRY_AFTER_SECONDS = 5
BUSY_MESSAGE = 'Media processing is busy. Please try again shortly.'


class _AdmissionPool:
    def __init__(self):
        self.slot = BoundedSemaphore(1)
        self.lock = Lock()
        self.active_uids = set()

    def try_acquire(self, uid):
        uid = str(uid or '')
        with self.lock:
            if uid in self.active_uids:
                return None, 429
            if not self.slot.acquire(blocking=False):
                return None, 503
            self.active_uids.add(uid)
            return _MediaLease(uid, self), 0


class _MediaLease:
    def __init__(self, uid, pool=None):
        self._uid = uid
        self._pool = pool if pool is not None else _download_pool
        self._released = False

    def release(self):
        with self._pool.lock:
            if self._released:
                return
            self._released = True
            self._pool.active_uids.discard(self._uid)
            self._pool.slot.release()


_download_pool = _AdmissionPool()
_conversion_pool = _AdmissionPool()


def try_acquire(uid):
    """Admit one download; return 429 for its owner or 503 for other users."""
    return _download_pool.try_acquire(uid)


def try_acquire_conversion(uid):
    """Admit one conversion independently of downloads, with the same limits."""
    return _conversion_pool.try_acquire(uid)


def busy_response(app_ctx, status):
    response = app_ctx.jsonify({
        'error': BUSY_MESSAGE,
        'retry_after_seconds': RETRY_AFTER_SECONDS,
    })
    response.status_code = status
    response.headers['Retry-After'] = str(RETRY_AFTER_SECONDS)
    return response
