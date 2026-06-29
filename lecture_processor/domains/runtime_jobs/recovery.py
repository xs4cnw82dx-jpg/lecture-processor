from lecture_processor.runtime.container import get_runtime
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store

ACTIVE_RUNTIME_JOB_STATUSES = {'queued', 'starting', 'processing'}


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _runtime_job_recovery_stale_seconds(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    configured = getattr(resolved_runtime, 'RUNTIME_JOB_RECOVERY_STALE_SECONDS', 0)
    try:
        safe_configured = int(configured or 0)
    except Exception:
        safe_configured = 0
    if safe_configured > 0:
        return max(120, safe_configured)
    return max(180, int(getattr(resolved_runtime, 'RUNTIME_JOB_RECOVERY_LEASE_SECONDS', 300) or 300) * 2)


def _active_job_timestamp(job_data):
    if not isinstance(job_data, dict):
        return 0.0
    for field in ('last_heartbeat_at', 'updated_at', 'started_at'):
        try:
            value = float(job_data.get(field, 0) or 0)
        except Exception:
            value = 0.0
        if value > 0:
            return value
    return 0.0


def _runtime_job_is_stale(job_data, *, now_ts, runtime=None):
    if not isinstance(job_data, dict):
        return False
    status = str(job_data.get('status', '') or '').lower()
    if status not in ACTIVE_RUNTIME_JOB_STATUSES:
        return False
    timestamp = _active_job_timestamp(job_data)
    if timestamp <= 0:
        return False
    return (float(now_ts) - timestamp) >= float(_runtime_job_recovery_stale_seconds(runtime=runtime))


def _runtime_job_recovery_holder_id(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return (
        str(resolved_runtime.os.getenv('RENDER_INSTANCE_ID', '') or '').strip()
        or str(resolved_runtime.os.getenv('HOSTNAME', '') or '').strip()
        or f'pid-{resolved_runtime.os.getpid()}'
    )


def _claim_stale_runtime_job(doc, *, now_ts, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    job_id = str(getattr(doc, 'id', '') or '').strip()
    if not job_id:
        return None

    db = getattr(resolved_runtime, 'db', None)
    firestore_module = getattr(resolved_runtime, 'firestore', None)
    if db is None or not hasattr(db, 'transaction') or firestore_module is None:
        job_data = doc.to_dict() or {}
        return dict(job_data) if _runtime_job_is_stale(job_data, now_ts=now_ts, runtime=resolved_runtime) else None

    job_ref = getattr(doc, 'reference', None)
    if job_ref is None:
        job_ref = resolved_runtime.runtime_jobs_repo.doc_ref(
            db,
            resolved_runtime.RUNTIME_JOBS_COLLECTION,
            job_id,
        )
    transaction = db.transaction()
    holder_id = _runtime_job_recovery_holder_id(runtime=resolved_runtime)

    @firestore_module.transactional
    def _txn(txn):
        snapshot = job_ref.get(transaction=txn)
        if not getattr(snapshot, 'exists', False):
            return None
        job_data = snapshot.to_dict() or {}
        if not _runtime_job_is_stale(job_data, now_ts=now_ts, runtime=resolved_runtime):
            return None
        try:
            claimed_at = float(job_data.get('recovery_claimed_at', 0) or 0)
        except Exception:
            claimed_at = 0.0
        if claimed_at > 0 and (float(now_ts) - claimed_at) < float(_runtime_job_recovery_stale_seconds(runtime=resolved_runtime)):
            return None
        txn.set(
            job_ref,
            {
                'recovery_claimed_at': float(now_ts),
                'recovery_claimed_by': holder_id,
                'updated_at': float(now_ts),
            },
            merge=True,
        )
        job_data['recovery_claimed_at'] = float(now_ts)
        job_data['recovery_claimed_by'] = holder_id
        return job_data

    try:
        claimed = _txn(transaction)
    except Exception:
        resolved_runtime.logger.warning('Runtime-job recovery claim failed for %s', job_id, exc_info=True)
        return None
    return dict(claimed) if isinstance(claimed, dict) else None


def recover_stale_runtime_jobs(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if resolved_runtime.db is None:
        return 0

    now_ts = resolved_runtime.time.time()
    recovered = 0
    try:
        stale_docs = resolved_runtime.runtime_jobs_repo.query_statuses(
            resolved_runtime.db,
            resolved_runtime.RUNTIME_JOBS_COLLECTION,
            ACTIVE_RUNTIME_JOB_STATUSES,
            limit=resolved_runtime.RUNTIME_JOB_RECOVERY_BATCH_LIMIT,
        )
    except Exception:
        resolved_runtime.logger.warning('Runtime-job recovery query failed', exc_info=True)
        return 0

    for doc in stale_docs:
        job_id = doc.id
        job_data = _claim_stale_runtime_job(doc, now_ts=now_ts, runtime=resolved_runtime)
        if not isinstance(job_data, dict):
            continue
        status = str(job_data.get('status', '') or '').lower()
        if status not in ACTIVE_RUNTIME_JOB_STATUSES:
            continue
        uid = str(job_data.get('user_id', '') or '').strip()
        credit_type = str(job_data.get('credit_deducted', '') or '').strip()
        already_refunded = bool(job_data.get('credit_refunded', False))
        if uid and credit_type and (not already_refunded):
            try:
                primary_refunded = bool(billing_credits.refund_credit(uid, credit_type, runtime=resolved_runtime))
            except Exception:
                primary_refunded = False
            if primary_refunded:
                billing_receipts.add_job_credit_refund(job_data, credit_type, 1, runtime=resolved_runtime)
                job_data['credit_refunded'] = True
            else:
                job_data['credit_refund_pending'] = True
                job_data['credit_refund_error'] = 'runtime_recovery_refund_failed'

        extra_spent = int(job_data.get('interview_features_cost', 0) or 0) + int(job_data.get('study_tools_credit_cost', 0) or 0)
        extra_refunded = int(job_data.get('extra_slides_refunded', 0) or 0)
        extra_to_refund = max(0, extra_spent - extra_refunded)
        if uid and extra_to_refund > 0:
            try:
                extras_refunded = bool(billing_credits.refund_slides_credits(uid, extra_to_refund, runtime=resolved_runtime))
            except Exception:
                extras_refunded = False
            if extras_refunded:
                job_data['extra_slides_refunded'] = extra_refunded + extra_to_refund
                billing_receipts.add_job_credit_refund(job_data, 'slides_credits', extra_to_refund, runtime=resolved_runtime)
                job_data['credit_refunded'] = True
            else:
                job_data['extra_slides_refund_pending'] = extra_to_refund

        billing_receipts.ensure_job_billing_receipt(
            job_data,
            {credit_type: 1} if credit_type else None,
            runtime=resolved_runtime,
        )
        job_data['status'] = 'error'
        job_data['step_description'] = 'Interrupted by server restart'
        if billing_receipts.job_has_refunds(job_data, runtime=resolved_runtime):
            job_data['error'] = 'Processing was interrupted by a server restart. Your credit has been refunded.'
        else:
            job_data['error'] = 'Processing was interrupted by a server restart. Please contact support if a credit was charged.'
        job_data['finished_at'] = now_ts
        job_data['job_id'] = job_id
        runtime_jobs_store.set_job(job_id, job_data, runtime=resolved_runtime)
        resolved_runtime.save_job_log(job_id, job_data, now_ts)
        recovered += 1

    if recovered:
        resolved_runtime.logger.warning('Recovered %s stale runtime jobs after startup.', recovered)
    return recovered


def acquire_runtime_job_recovery_lease(now_ts=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if resolved_runtime.db is None:
        return True

    lease_collection = str(resolved_runtime.RUNTIME_JOB_RECOVERY_LEASE_COLLECTION or '').strip()
    lease_id = str(resolved_runtime.RUNTIME_JOB_RECOVERY_LEASE_ID or '').strip()
    if not lease_collection or not lease_id:
        return True

    now_ts = float(now_ts if isinstance(now_ts, (int, float)) else resolved_runtime.time.time())
    lease_seconds = max(30, min(int(resolved_runtime.RUNTIME_JOB_RECOVERY_LEASE_SECONDS or 300), 3600))
    holder_id = (
        str(resolved_runtime.os.getenv('RENDER_INSTANCE_ID', '') or '').strip()
        or str(resolved_runtime.os.getenv('HOSTNAME', '') or '').strip()
        or f'pid-{resolved_runtime.os.getpid()}'
    )
    lease_ref = resolved_runtime.db.collection(lease_collection).document(lease_id)
    transaction = resolved_runtime.db.transaction()

    @resolved_runtime.firestore.transactional
    def _txn(txn):
        snapshot = lease_ref.get(transaction=txn)
        existing = snapshot.to_dict() or {}
        existing_expires_at = resolved_runtime.get_timestamp(existing.get('expires_at'))
        if snapshot.exists and existing_expires_at > now_ts:
            return False
        txn.set(
            lease_ref,
            {
                'lease_id': lease_id,
                'holder_id': holder_id,
                'acquired_at': now_ts,
                'expires_at': now_ts + lease_seconds,
            },
            merge=True,
        )
        return True

    try:
        return bool(_txn(transaction))
    except Exception:
        resolved_runtime.logger.warning(
            'Could not acquire runtime-job recovery lease; continuing without distributed lock.',
            exc_info=True,
        )
        return True


def run_startup_recovery_once(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    core_obj = getattr(resolved_runtime, 'core', resolved_runtime)
    with core_obj.RUNTIME_JOB_RECOVERY_LOCK:
        if core_obj.RUNTIME_JOB_RECOVERY_DONE:
            return
        core_obj.RUNTIME_JOB_RECOVERY_DONE = True
    if not resolved_runtime.RUNTIME_JOB_RECOVERY_ENABLED:
        resolved_runtime.logger.info('Runtime-job recovery disabled via ENABLE_RUNTIME_JOB_RECOVERY.')
        return
    if not acquire_runtime_job_recovery_lease(runtime=resolved_runtime):
        resolved_runtime.logger.info('Skipping startup runtime-job recovery; lease already held by another instance.')
        return
    recover_stale_runtime_jobs(runtime=resolved_runtime)
