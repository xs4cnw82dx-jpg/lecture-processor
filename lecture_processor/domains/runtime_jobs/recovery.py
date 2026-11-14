from lecture_processor.runtime.container import get_runtime
from lecture_processor.domains.billing import job_charges
from lecture_processor.domains.billing import receipts as billing_receipts
from lecture_processor.domains.runtime_jobs import execution
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
    return 180


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
    if status not in ACTIVE_RUNTIME_JOB_STATUSES and not _pending_refund_components(job_data):
        return False
    timestamp = _active_job_timestamp(job_data)
    if timestamp <= 0:
        return False
    return (float(now_ts) - timestamp) >= float(_runtime_job_recovery_stale_seconds(runtime=runtime))


def _pending_refund_components(job):
    """Only explicit failed settlements on terminal jobs are retryable."""
    if job.get('status') not in {'error', 'complete', 'completed'}:
        return set()
    receipt = job.get('billing_receipt') or {}
    components = receipt.get('components') or {}
    charged = receipt.get('charged') or {}
    journaled = bool(job.get('charge_ref') or receipt.get('charge_ref'))
    pending = set()
    if job.get('status') == 'error' and job.get('credit_refund_pending'):
        if ('primary' in components if journaled else charged.get(job.get('credit_deducted'), 0)):
            pending.add('primary')
    if int(job.get('extra_slides_refund_pending', 0) or 0) > 0:
        if ('extras' in components if journaled else charged.get('slides_credits', 0)):
            pending.add('extras')
    return pending


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
    if not job_id or execution.is_job_active(job_id, runtime=resolved_runtime):
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
        if execution.is_job_active(job_id, runtime=resolved_runtime):
            return None
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
        pending_query = getattr(resolved_runtime.runtime_jobs_repo, 'query_pending_refunds', None)
        if callable(pending_query):
            pending_docs = pending_query(
                resolved_runtime.db, resolved_runtime.RUNTIME_JOBS_COLLECTION,
                limit=resolved_runtime.RUNTIME_JOB_RECOVERY_BATCH_LIMIT,
            )
            stale_docs = list({doc.id: doc for doc in [*stale_docs, *pending_docs]}.values())
    except Exception:
        resolved_runtime.logger.warning('Runtime-job recovery query failed', exc_info=True)
        return 0

    for doc in stale_docs:
        if _recover_runtime_job_doc(doc, now_ts=now_ts, runtime=resolved_runtime):
            recovered += 1

    if recovered:
        resolved_runtime.logger.warning('Recovered %s stale runtime jobs.', recovered)
    return recovered


def _recover_runtime_job_doc(doc, *, now_ts, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    job_id = doc.id
    if _pending_refund_components(doc.to_dict() or {}):
        return _retry_pending_refunds(doc, now_ts=now_ts, runtime=resolved_runtime)
    if (doc.to_dict() or {}).get('job_scope') == 'interview-coding':
        # Coding completion and refund arbitrate on their canonical run record.
        # Its debit must never use the generic runtime-job refund keys.
        from lecture_processor.domains.study import interview_coding_runs
        try:
            return interview_coding_runs.fail_run(resolved_runtime, job_id, orphan=True, now_ts=now_ts)
        except Exception:
            resolved_runtime.logger.warning('Interview coding recovery failed for %s', job_id, exc_info=True)
            return False
    job_data = _claim_stale_runtime_job(doc, now_ts=now_ts, runtime=resolved_runtime)
    if not isinstance(job_data, dict):
        return False
    status = str(job_data.get('status', '') or '').lower()
    if status not in ACTIVE_RUNTIME_JOB_STATUSES:
        return False
    uid = str(job_data.get('user_id', '') or '').strip()
    credit_type = str(job_data.get('credit_deducted', '') or '').strip()
    already_refunded = bool(job_data.get('credit_refunded', False))
    journal_refund = bool(job_data.get('charge_ref') or job_data.get('credit_scheme') == 2)
    if journal_refund:
        receipt = job_data.get('billing_receipt') or {}
        components = receipt.get('components') or {}
        job_data['credit_refund_pending'] = not bool(components)
        job_data['extra_slides_refund_pending'] = 0
        for name, component in components.items():
            settled = job_charges.refund_component(
                job_data, name, int(component.get('units', 0)), f'runtime-job:{job_id}:{name}',
                processed_count=1 if name == 'primary' else 0, runtime=resolved_runtime,
            )
            if name == 'extras':
                job_data['extra_slides_refund_pending'] = 0 if settled else int(component.get('units', 0))
                if settled:
                    job_data['extra_slides_refunded'] = int(component.get('units', 0))
            elif not settled:
                job_data['credit_refund_pending'] = True
        if job_data['credit_refund_pending'] or job_data['extra_slides_refund_pending']:
            job_data['credit_refund_error'] = 'runtime_recovery_refund_failed'
        else:
            job_data['credit_refund_error'] = ''
        credit_type = ''
    if uid and credit_type and (not already_refunded):
        try:
            primary_refunded = bool(job_charges.refund_component(
                job_data, 'primary', 1, f'runtime-job:{job_id}:primary',
                legacy_credit_type=credit_type, legacy_charged_units=1, processed_count=1, runtime=resolved_runtime,
            ))
        except Exception:
            primary_refunded = False
        if primary_refunded:
            billing_receipts.add_job_credit_refund(job_data, credit_type, 1, runtime=resolved_runtime)
            job_data['credit_refunded'] = True
        else:
            job_data['credit_refund_pending'] = True
            job_data['credit_refund_error'] = 'runtime_recovery_refund_failed'

    extra_spent = 0 if journal_refund else int(job_data.get('interview_features_cost', 0) or 0) + int(job_data.get('study_tools_credit_cost', 0) or 0)
    extra_refunded = int(job_data.get('extra_slides_refunded', 0) or 0)
    extra_to_refund = max(0, extra_spent - extra_refunded)
    if uid and extra_to_refund > 0:
        try:
            extras_refunded = bool(job_charges.refund_component(
                job_data, 'extras', extra_refunded + extra_to_refund, f'runtime-job:{job_id}:extras',
                legacy_credit_type='slides_credits', legacy_charged_units=extra_spent, runtime=resolved_runtime,
            ))
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
    return True


def _retry_pending_refunds(doc, *, now_ts, runtime):
    job = _claim_stale_runtime_job(doc, now_ts=now_ts, runtime=runtime)
    if not isinstance(job, dict):
        return False
    pending = _pending_refund_components(job)
    if not pending:
        return False
    receipt = job.get('billing_receipt') or {}
    components = receipt.get('components') or {}
    for name in sorted(pending):
        component = components.get(name) or {}
        if name == 'primary':
            units, credit_type, processed = int(component.get('units', 1)), job.get('credit_deducted', ''), 1
            prior = 0
            charged = int((receipt.get('charged') or {}).get(credit_type, 1))
        else:
            prior = int(job.get('extra_slides_refunded', 0) or 0)
            charged = int(component.get('units') or (receipt.get('charged') or {}).get('slides_credits', 0))
            units = min(charged, prior + int(job.get('extra_slides_refund_pending', 0) or 0))
            credit_type, processed = 'slides_credits', 0
        settled = job_charges.refund_component(
            job, name, units, f'runtime-job:{doc.id}:{name}', legacy_credit_type=credit_type,
            legacy_charged_units=charged, processed_count=processed, runtime=runtime,
        )
        if not settled:
            continue
        billing_receipts.add_job_credit_refund(job, credit_type, units - prior, runtime=runtime)
        if name == 'primary':
            job['credit_refund_pending'] = False
        else:
            job['extra_slides_refund_pending'] = 0
            job['extra_slides_refunded'] = units
        job['credit_refunded'] = billing_receipts.job_has_refunds(job, runtime=runtime)
    if not job.get('credit_refund_pending') and not job.get('extra_slides_refund_pending'):
        job['credit_refund_error'] = ''
    runtime_jobs_store.set_job(doc.id, job, runtime=runtime)
    runtime.save_job_log(doc.id, job, job.get('finished_at') or now_ts, record_metrics=False)
    return True


def recover_runtime_job_if_stale(job_id, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not getattr(resolved_runtime, 'RUNTIME_JOB_RECOVERY_ENABLED', False):
        return False
    if not job_id or execution.is_job_active(job_id, runtime=resolved_runtime):
        return False
    if getattr(resolved_runtime, 'db', None) is None:
        return False
    try:
        doc = resolved_runtime.runtime_jobs_repo.get_doc(
            resolved_runtime.db, resolved_runtime.RUNTIME_JOBS_COLLECTION, job_id,
        )
        if not getattr(doc, 'exists', False):
            return False
        return _recover_runtime_job_doc(doc, now_ts=resolved_runtime.time.time(), runtime=resolved_runtime)
    except Exception:
        resolved_runtime.logger.warning('Runtime-job status recovery failed for %s', job_id, exc_info=True)
        return False


def run_periodic_recovery(runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not getattr(resolved_runtime, 'RUNTIME_JOB_RECOVERY_ENABLED', False):
        return 0
    if not acquire_runtime_job_recovery_lease(runtime=resolved_runtime):
        return 0
    return recover_stale_runtime_jobs(runtime=resolved_runtime)


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
