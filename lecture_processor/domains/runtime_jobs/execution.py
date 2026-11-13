"""Track locally queued/running jobs and persist worker liveness."""

from __future__ import annotations

import inspect
import threading

from lecture_processor.domains.runtime_jobs import store
from lecture_processor.runtime.container import get_runtime

HEARTBEAT_INTERVAL_SECONDS = 30.0
_ACTIVE_STATUSES = {'queued', 'starting', 'processing'}
_ACTIVE_JOBS = {}
_ACTIVE_JOBS_LOCK = threading.Lock()


def is_job_active(job_id, runtime=None):
    """Include work waiting in this process's bounded dispatcher queue."""
    with _ACTIVE_JOBS_LOCK:
        return bool(_ACTIVE_JOBS.get(str(job_id)))


def _heartbeat_job(job_id, runtime):
    updated = False

    def heartbeat(job):
        nonlocal updated
        if str(job.get('status', '') or '').lower() in _ACTIVE_STATUSES:
            job['last_heartbeat_at'] = runtime.time.time()
            updated = True

    # Do not load or create a runtime record for other background tasks, such
    # as audio imports, which keep their state in a separate store.
    snapshot = runtime.job_state_service.mutate_job(
        job_id, heartbeat, jobs_store=runtime.jobs, lock=runtime.JOBS_LOCK,
    )
    if updated:
        store.persist_runtime_job_snapshot(
            job_id, snapshot, runtime=runtime, changed_fields={'last_heartbeat_at'},
        )
    return updated


def submit_job(dispatcher, target, *args, execution_runtime=None, **kwargs):
    resolved_runtime = execution_runtime if execution_runtime is not None else get_runtime()
    try:
        job_id = inspect.signature(target).bind_partial(*args, **kwargs).arguments.get('job_id')
    except (TypeError, ValueError):
        job_id = None
    if not job_id:
        return dispatcher.submit(target, *args, **kwargs)
    job_id = str(job_id)
    token = object()
    with _ACTIVE_JOBS_LOCK:
        _ACTIVE_JOBS.setdefault(job_id, set()).add(token)

    def release(_future=None):
        with _ACTIVE_JOBS_LOCK:
            entries = _ACTIVE_JOBS.get(job_id)
            if entries is not None:
                entries.discard(token)
                if not entries:
                    _ACTIVE_JOBS.pop(job_id, None)

    def heartbeat():
        try:
            return _heartbeat_job(job_id, resolved_runtime)
        except Exception:
            resolved_runtime.logger.warning('Runtime-job heartbeat failed for %s', job_id, exc_info=True)
            return True

    def run():
        stop = threading.Event()

        def heartbeat_loop():
            while not stop.wait(HEARTBEAT_INTERVAL_SECONDS):
                if not heartbeat():
                    return

        thread = None
        try:
            if heartbeat():
                thread = threading.Thread(target=heartbeat_loop, name='lp-job-heartbeat', daemon=True)
                thread.start()
            return target(*args, **kwargs)
        finally:
            stop.set()
            if thread is not None and thread.ident is not None:
                thread.join(timeout=1)
            release()

    try:
        future = dispatcher.submit(run)
        # Cancelled queued futures never enter run(), so also release here.
        future.add_done_callback(release)
        return future
    except BaseException:
        release()
        raise
