"""Bounded in-process job dispatching for long-running background work."""

from __future__ import annotations

import threading
from concurrent.futures import ThreadPoolExecutor


class JobQueueFullError(RuntimeError):
    """Raised when the bounded in-process queue is saturated."""


class BoundedJobDispatcher:
    def __init__(self, max_workers, max_pending, logger=None):
        self.max_workers = max(1, int(max_workers or 1))
        self.max_pending = max(0, int(max_pending or 0))
        self._capacity = self.max_workers + self.max_pending
        self._executor = ThreadPoolExecutor(max_workers=self.max_workers, thread_name_prefix='lp-job')
        self._slots = threading.BoundedSemaphore(self._capacity)
        self._lock = threading.Lock()
        self._active = 0
        self._logger = logger

    def stats(self):
        with self._lock:
            active = self._active
        queued = max(0, active - self.max_workers)
        running = min(active, self.max_workers)
        return {
            'capacity': self._capacity,
            'max_workers': self.max_workers,
            'max_pending': self.max_pending,
            'active': active,
            'running': running,
            'queued': queued,
        }

    def submit(self, fn, *args, **kwargs):
        if not self._slots.acquire(blocking=False):
            raise JobQueueFullError('Background processing queue is full.')
        with self._lock:
            self._active += 1
        future = self._executor.submit(fn, *args, **kwargs)

        def _release(_future):
            with self._lock:
                self._active = max(0, self._active - 1)
            self._slots.release()
            try:
                _future.result()
            except Exception as exc:  # pragma: no cover - logged for production visibility
                if self._logger is not None:
                    self._logger.exception('Background job failed: %s', exc)

        future.add_done_callback(_release)
        return future
