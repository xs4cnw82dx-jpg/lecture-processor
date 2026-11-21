"""Publish regenerated tools with their canonical completion and settlement state."""

from copy import deepcopy
from dataclasses import dataclass

from lecture_processor.domains.account import lifecycle
from lecture_processor.domains.billing import job_charges
from lecture_processor.domains.runtime_jobs import store
from lecture_processor.domains.study import content_revision, picture_refs


@dataclass(frozen=True)
class Outcome:
    state: str
    job: dict | None = None


class PublicationRejected(RuntimeError):
    """The generation inputs or publication authority changed."""


def _ref(runtime, job_id):
    return runtime.runtime_jobs_repo.doc_ref(runtime.db, runtime.RUNTIME_JOBS_COLLECTION, job_id)


def _read(ref, transaction=None):
    snapshot = ref.get(transaction=transaction) if transaction is not None else ref.get()
    return snapshot.to_dict() if snapshot.exists else None


def _matches(job, uid, pack_id):
    return bool(job and job.get('user_id') == uid and job.get('study_pack_id') == pack_id)


def _has_refund(job):
    receipt = job.get('billing_receipt') or {}
    return bool(
        job.get('credit_refunded') or job.get('credit_refund_pending')
        or job.get('extra_slides_refunded') or job.get('extra_slides_refund_pending')
        or job.get('refunded_credits') or receipt.get('refunded_credits')
        or any((receipt.get('refunded') or {}).values())
    )


def _outcome(job, uid, pack_id):
    if not _matches(job, uid, pack_id):
        return Outcome('closed')
    if job.get('status') == 'complete':
        return Outcome('complete', job)
    if job.get('recovery_claimed_at'):
        return Outcome('closed', job)
    if job.get('status') == 'error':
        return Outcome('refund' if job.get('extra_slides_refund_pending') else 'closed', job)
    return Outcome('active' if job.get('status') in {'queued', 'starting', 'processing'} else 'closed', job)


def inspect(job_id, pack_id, uid, *, runtime):
    """Read durable state without interpreting an unavailable read as absence."""
    try:
        return _outcome(_read(_ref(runtime, job_id)), uid, pack_id)
    except Exception:
        runtime.logger.warning('Regeneration outcome unavailable for %s', job_id, exc_info=True)
        return Outcome('defer')


def cache(job_id, outcome, *, runtime):
    if outcome.job is None:
        with runtime.JOBS_LOCK:
            runtime.jobs.pop(job_id, None)
        return
    runtime.job_state_service.set_job(
        job_id, deepcopy(outcome.job), jobs_store=runtime.jobs, lock=runtime.JOBS_LOCK,
    )


def _write_job(transaction, ref, job_id, current, fields, runtime):
    updated = {**current, **fields}
    payload = store._build_runtime_job_payload(
        job_id, updated, runtime=runtime, changed_fields=set(fields),
    )
    transaction.update(ref, payload)
    return {**updated, **payload}


def start(job_id, pack_id, uid, *, runtime):
    observed = inspect(job_id, pack_id, uid, runtime=runtime)
    if observed.state != 'active' or observed.job.get('status') not in {'queued', 'starting'}:
        return observed if observed.state != 'active' else Outcome('closed', observed.job)
    if observed.job.get('recovery_claimed_at') or _has_refund(observed.job):
        return Outcome('closed', observed.job)
    if observed.job.get('charge_ref') or observed.job.get('credit_scheme') == 2:
        # Keep the existing transactional admission/journal checks for current credits.
        if not job_charges.begin_runtime_job(job_id, runtime=runtime):
            result = inspect(job_id, pack_id, uid, runtime=runtime)
            return result if result.state != 'active' else Outcome('defer')
        result = inspect(job_id, pack_id, uid, runtime=runtime)
        if (result.state == 'active' and result.job.get('status') == 'processing'
                and not _has_refund(result.job)):
            return Outcome('running', result.job)
        return result if result.state != 'active' else Outcome('closed', result.job)

    ref = _ref(runtime, job_id)

    @runtime.firestore.transactional
    def begin(transaction):
        current = _read(ref, transaction)
        result = _outcome(current, uid, pack_id)
        if (result.state != 'active' or current.get('status') not in {'queued', 'starting'}
                or _has_refund(current)):
            return result if result.state != 'active' else Outcome('closed', current)
        job = _write_job(transaction, ref, job_id, current, {
            'status': 'processing', 'step': 1, 'step_description': 'Refreshing study tools...',
            'last_heartbeat_at': runtime.time.time(),
        }, runtime)
        return Outcome('running', job)

    try:
        return begin(runtime.db.transaction())
    except Exception:
        result = inspect(job_id, pack_id, uid, runtime=runtime)
        return result if result.state != 'active' else Outcome('defer')


def publish(job_id, pack_id, uid, expected_fingerprint, fallback_text, pack_updates, completion_fields, *, runtime):
    job_ref = _ref(runtime, job_id)
    pack_ref = runtime.study_repo.study_pack_doc_ref(runtime.db, pack_id)

    @runtime.firestore.transactional
    def commit(transaction):
        current = _read(job_ref, transaction)
        result = _outcome(current, uid, pack_id)
        if result.state == 'complete':
            return result
        if (result.state != 'active' or current.get('status') != 'processing' or _has_refund(current)):
            raise PublicationRejected('Regeneration job is no longer available')
        lifecycle.require_account_access(uid, runtime=runtime, transaction=transaction)
        user = _read(runtime.users_repo.doc_ref(runtime.db, uid), transaction)
        if not user or str(user.get('account_status', '')).lower() in {'deleting', 'deleted'}:
            raise PublicationRejected('Regeneration account is no longer available')
        current_pack = _read(pack_ref, transaction)
        if (not current_pack or current_pack.get('uid') != uid
                or content_revision.fingerprint(current_pack) != expected_fingerprint):
            raise PublicationRejected('Regeneration content changed')
        if fallback_text is not None:
            source_ref = runtime.study_repo.study_pack_source_doc_ref(runtime.db, pack_id)
            source = _read(source_ref, transaction)
            if (not source or source.get('uid') != uid
                    or str(source.get('transcript') or '').strip() != fallback_text):
                raise PublicationRejected('Regeneration source changed')
        if current.get('charge_ref'):
            context = job_charges.ledger.read_charge_context(
                transaction, uid, current['charge_ref'], runtime=runtime,
            )
            journal = context.journal_data
            if (journal.get('uid') != uid or journal.get('charge_ref') != current['charge_ref']
                    or journal.get('admission_state') != 'admitted'
                    or current.get('credit_admission_state') != 'running'
                    or journal.get('refund_started') or journal.get('refunded_credits')):
                raise PublicationRejected('Regeneration charge is no longer available')
        updates = dict(pack_updates)
        if 'flashcards' in updates:
            next_ids = picture_refs.card_image_ids(updates['flashcards'])
            pending = (set(current_pack.get(picture_refs.PENDING_PICTURES, []))
                       | picture_refs.card_image_ids(current_pack.get('flashcards'))) - next_ids
            updates[picture_refs.PENDING_PICTURES] = sorted(pending)
        transaction.update(pack_ref, updates)
        job = _write_job(transaction, job_ref, job_id, current, {
            **completion_fields, 'status': 'complete', 'study_pack_id': pack_id,
        }, runtime)
        return Outcome('complete', job)

    return commit(runtime.db.transaction())


def cleanup_pictures(pack_id, uid, *, runtime):
    """Retry durable picture removals only after canonical job completion."""
    try:
        current_pack = _read(runtime.study_repo.study_pack_doc_ref(runtime.db, pack_id))
        if not current_pack or current_pack.get('uid') != uid:
            return
        pending = current_pack.get(picture_refs.PENDING_PICTURES)
        if pending:
            runtime.delete_study_pack_pictures(uid, pack_id, image_ids=pending)
    except Exception:
        runtime.logger.warning('Picture cleanup remains pending after regenerating study pack %s', pack_id, exc_info=True)


def resolve_failure(job_id, pack_id, uid, failure_fields, *, runtime):
    ref = _ref(runtime, job_id)

    @runtime.firestore.transactional
    def claim(transaction):
        current = _read(ref, transaction)
        result = _outcome(current, uid, pack_id)
        if result.state != 'active' or current.get('status') != 'processing':
            return result if result.state != 'active' else Outcome('closed', current)
        # This write fences any publication transaction whose acknowledgement is uncertain.
        # No financial settlement occurs until this claim is durably acknowledged/read back.
        pending = 0 if current.get('credit_refunded') or current.get('extra_slides_refunded') else 1
        job = _write_job(transaction, ref, job_id, current, {
            **failure_fields, 'status': 'error', 'extra_slides_refund_pending': pending,
        }, runtime)
        return Outcome('refund' if pending else 'closed', job)

    try:
        return claim(runtime.db.transaction())
    except Exception:
        result = inspect(job_id, pack_id, uid, runtime=runtime)
        return result if result.state != 'active' else Outcome('defer')


def settle(job_id, pack_id, uid, outcome, *, runtime):
    if outcome.state != 'refund':
        return outcome
    refund_job = deepcopy(outcome.job)
    try:
        success = job_charges.refund_component(
            refund_job, 'extras', 1, f'runtime-job:{job_id}:extras',
            legacy_credit_type='slides_credits', legacy_charged_units=1, runtime=runtime,
        )
    except Exception:
        runtime.logger.warning('Regeneration refund unavailable for %s', job_id, exc_info=True)
        success = False
    ref = _ref(runtime, job_id)

    @runtime.firestore.transactional
    def record(transaction):
        current = _read(ref, transaction)
        result = _outcome(current, uid, pack_id)
        if result.state != 'refund':
            return result
        fields = {'credit_refund_error': '' if success else 'study_tools_refund_failed'}
        if success:
            receipt = deepcopy(refund_job.get('billing_receipt') or {})
            if not refund_job.get('charge_ref'):
                # The provider action charged exactly one legacy unit. Record the
                # cumulative total rather than adding again after an uncertain ACK.
                receipt.setdefault('charged', {})['slides_credits'] = 1
                receipt.setdefault('refunded', {})['slides_credits'] = 1
                receipt['updated_at'] = runtime.time.time()
            fields.update(
                billing_receipt=receipt, credit_refunded=True,
                extra_slides_refunded=1, extra_slides_refund_pending=0,
            )
            if refund_job.get('charge_ref'):
                fields['refunded_credits'] = refund_job['refunded_credits']
        job = _write_job(transaction, ref, job_id, current, fields, runtime)
        return Outcome('closed' if success else 'refund', job)

    try:
        return record(runtime.db.transaction())
    except Exception:
        result = inspect(job_id, pack_id, uid, runtime=runtime)
        return result if result.state != 'active' else Outcome('defer')
