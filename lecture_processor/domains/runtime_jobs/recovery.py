from lecture_processor.runtime.container import get_runtime
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


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
            {'starting', 'processing'},
            limit=resolved_runtime.RUNTIME_JOB_RECOVERY_BATCH_LIMIT,
        )
    except Exception:
        resolved_runtime.logger.warning('Runtime-job recovery query failed', exc_info=True)
        return 0

    for doc in stale_docs:
        job_id = doc.id
        job_data = doc.to_dict() or {}
        if not isinstance(job_data, dict):
            continue
        status = str(job_data.get('status', '') or '').lower()
        if status not in {'starting', 'processing'}:
            continue
        uid = str(job_data.get('user_id', '') or '').strip()
        credit_type = str(job_data.get('credit_deducted', '') or '').strip()
        already_refunded = bool(job_data.get('credit_refunded', False))
        if uid and credit_type and (not already_refunded):
            billing_credits.refund_credit(uid, credit_type, runtime=resolved_runtime)
            billing_receipts.add_job_credit_refund(job_data, credit_type, 1, runtime=resolved_runtime)
            job_data['credit_refunded'] = True

        extra_spent = int(job_data.get('interview_features_cost', 0) or 0)
        extra_refunded = int(job_data.get('extra_slides_refunded', 0) or 0)
        extra_to_refund = max(0, extra_spent - extra_refunded)
        if uid and extra_to_refund > 0:
            billing_credits.refund_slides_credits(uid, extra_to_refund, runtime=resolved_runtime)
            job_data['extra_slides_refunded'] = extra_refunded + extra_to_refund
            billing_receipts.add_job_credit_refund(job_data, 'slides_credits', extra_to_refund, runtime=resolved_runtime)

        billing_receipts.ensure_job_billing_receipt(
            job_data,
            {credit_type: 1} if credit_type else None,
            runtime=resolved_runtime,
        )
        job_data['status'] = 'error'
        job_data['step_description'] = 'Interrupted by server restart'
        job_data['error'] = 'Processing was interrupted by a server restart. Your credit has been refunded.'
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
