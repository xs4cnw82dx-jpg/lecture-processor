from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _runtime_job_storage_enabled(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return resolved_runtime.db is not None


def _runtime_job_sanitize_value(value, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    max_len = int(getattr(resolved_runtime, 'RUNTIME_JOB_MAX_STRING_LENGTH', 20000) or 20000)
    if isinstance(value, str):
        if len(value) > max_len:
            return value[:max_len]
        return value
    if isinstance(value, list):
        return [_runtime_job_sanitize_value(v, runtime=resolved_runtime) for v in value]
    if isinstance(value, dict):
        return {str(k): _runtime_job_sanitize_value(v, runtime=resolved_runtime) for k, v in value.items()}
    return value


def _build_runtime_job_payload(job_id, job_data, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    payload = {'job_id': job_id, 'updated_at': resolved_runtime.time.time()}
    if not isinstance(job_data, dict):
        payload['status'] = 'unknown'
        return payload
    for field in resolved_runtime.RUNTIME_JOB_PERSISTED_FIELDS:
        if field in job_data:
            payload[field] = _runtime_job_sanitize_value(job_data.get(field), runtime=resolved_runtime)
    return payload


def persist_runtime_job_snapshot(job_id, job_data, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not _runtime_job_storage_enabled(runtime=resolved_runtime) or not job_id:
        return
    try:
        resolved_runtime.runtime_jobs_repo.set_doc(
            resolved_runtime.db,
            resolved_runtime.RUNTIME_JOBS_COLLECTION,
            job_id,
            _build_runtime_job_payload(job_id, job_data, runtime=resolved_runtime),
            merge=True,
        )
    except Exception:
        resolved_runtime.logger.warning('Failed to persist runtime job snapshot for %s', job_id, exc_info=True)


def load_runtime_job_snapshot(job_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not _runtime_job_storage_enabled(runtime=resolved_runtime) or not job_id:
        return None
    try:
        doc = resolved_runtime.runtime_jobs_repo.get_doc(
            resolved_runtime.db,
            resolved_runtime.RUNTIME_JOBS_COLLECTION,
            job_id,
        )
        if not doc.exists:
            return None
        data = doc.to_dict() or {}
        if not isinstance(data, dict):
            return None
        data.setdefault('job_id', job_id)
        return data
    except Exception:
        resolved_runtime.logger.warning('Failed to load runtime job snapshot for %s', job_id, exc_info=True)
        return None


def delete_runtime_job_snapshot(job_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not _runtime_job_storage_enabled(runtime=resolved_runtime) or not job_id:
        return
    try:
        resolved_runtime.runtime_jobs_repo.delete_doc(
            resolved_runtime.db,
            resolved_runtime.RUNTIME_JOBS_COLLECTION,
            job_id,
        )
    except Exception:
        resolved_runtime.logger.warning('Failed to delete runtime job snapshot for %s', job_id, exc_info=True)


def update_job_fields(job_id, runtime=None, **fields):
    resolved_runtime = _resolve_runtime(runtime)
    if not fields:
        return get_job_snapshot(job_id, runtime=resolved_runtime)

    def _mutator(job):
        job.update(fields)

    return mutate_job(job_id, _mutator, runtime=resolved_runtime)


def get_job_snapshot(job_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    snapshot = resolved_runtime.job_state_service.get_job_snapshot(
        job_id,
        jobs_store=resolved_runtime.jobs,
        lock=resolved_runtime.JOBS_LOCK,
    )
    if snapshot is not None:
        return snapshot
    runtime_snapshot = load_runtime_job_snapshot(job_id, runtime=resolved_runtime)
    if runtime_snapshot is not None:
        resolved_runtime.job_state_service.set_job(
            job_id,
            dict(runtime_snapshot),
            jobs_store=resolved_runtime.jobs,
            lock=resolved_runtime.JOBS_LOCK,
        )
        return runtime_snapshot
    return None


def mutate_job(job_id, mutator_fn, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    snapshot = resolved_runtime.job_state_service.mutate_job(
        job_id,
        mutator_fn,
        jobs_store=resolved_runtime.jobs,
        lock=resolved_runtime.JOBS_LOCK,
    )
    if snapshot is not None:
        persist_runtime_job_snapshot(job_id, snapshot, runtime=resolved_runtime)
    return snapshot


def set_job(job_id, value, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    snapshot = resolved_runtime.job_state_service.set_job(
        job_id,
        value,
        jobs_store=resolved_runtime.jobs,
        lock=resolved_runtime.JOBS_LOCK,
    )
    if isinstance(snapshot, dict):
        persist_runtime_job_snapshot(job_id, snapshot, runtime=resolved_runtime)
    return snapshot


def delete_job(job_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    deleted = resolved_runtime.job_state_service.delete_job(
        job_id,
        jobs_store=resolved_runtime.jobs,
        lock=resolved_runtime.JOBS_LOCK,
    )
    delete_runtime_job_snapshot(job_id, runtime=resolved_runtime)
    return deleted
