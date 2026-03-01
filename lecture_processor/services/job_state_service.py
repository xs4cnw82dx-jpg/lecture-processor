"""Thread-safe in-memory job state helpers."""


def get_job_snapshot(job_id, *, jobs_store, lock):
    with lock:
        job = jobs_store.get(job_id)
        if not isinstance(job, dict):
            return None
        return dict(job)


def mutate_job(job_id, mutator_fn, *, jobs_store, lock):
    with lock:
        job = jobs_store.get(job_id)
        if not isinstance(job, dict):
            return None
        mutator_fn(job)
        return dict(job)


def set_job(job_id, value, *, jobs_store, lock):
    with lock:
        jobs_store[job_id] = value
        return dict(value) if isinstance(value, dict) else value


def delete_job(job_id, *, jobs_store, lock):
    with lock:
        return jobs_store.pop(job_id, None)


def count_active_jobs_for_user(uid, *, jobs_store, lock, active_states=None):
    if not uid:
        return 0
    states = set(active_states or {'starting', 'processing'})
    with lock:
        count = 0
        for job in jobs_store.values():
            if job.get('user_id') == uid and job.get('status') in states:
                count += 1
        return count
