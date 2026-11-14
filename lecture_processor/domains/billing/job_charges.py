"""Durable processing admissions and refunds using recorded credit components."""

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.billing import credits, ledger, policy
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.runtime.container import get_runtime


def _runtime(runtime):
    return runtime if runtime is not None else get_runtime()


def receipt_fields(receipt):
    return {
        'credit_scheme': receipt['credit_scheme'],
        'charge_ref': receipt['charge_ref'],
        'charged_credits': receipt['charged_credits'],
        'refunded_credits': receipt.get('refunded_credits', 0),
        'credit_admission_state': 'admitted',
        'billing_receipt': receipt,
    }


def runtime_receipt_fields(job_id, *, runtime=None):
    job = runtime_jobs_store.get_job_snapshot(job_id, runtime=_runtime(runtime)) or {}
    receipt = job.get('billing_receipt') or {}
    if not receipt.get('charge_ref'):
        return {}
    return {**receipt_fields(receipt), 'credit_refunded': receipt.get('refunded_credits', 0) > 0}


def primary_credit_type(receipt):
    primary = (receipt.get('components') or {}).get('primary') or {}
    return primary.get('credit_type') or {
        'lecture': 'lecture_credits_standard',
        'slides': 'slides_credits',
        'interview': 'interview_credits_short',
    }.get(primary.get('category'), '')


def credit_preflight_error(user, components, *, legacy_checks=(), overnight=False, runtime=None):
    """Quote before uploads; the admission transaction still decides the debit."""
    runtime = _runtime(runtime)
    if not policy.uses_unified_credits(user, runtime=runtime):
        for category, amount, message in legacy_checks:
            if not credits.has_category_credit(user, category, amount, runtime=runtime):
                return {'error': message}, 402
        return None, 0
    try:
        balance = (user.get('credits') if user.get('credits_version') == 2
                   else policy.conversion_updates(user)['credits'])
        if type(balance) is not int or balance < 0:
            raise ledger.LedgerUnavailable('Credit balance is unavailable.')
        quote = policy.quote_components(
            components, overnight=overnight,
            unlimited=credits.effective_unlimited_credits(user, runtime=runtime),
        )
        if quote['charged_credits'] > balance:
            return public_charge_error(ledger.InsufficientCredits(quote['charged_credits'], balance))
        return None, 0
    except Exception as error:
        runtime.logger.warning('Processing credit quote could not be verified.', exc_info=True)
        return public_charge_error(error)


def _cache_job(runtime, job_id, payload):
    runtime.job_state_service.set_job(
        job_id, dict(payload), jobs_store=runtime.jobs, lock=runtime.JOBS_LOCK,
    )


def _job_ref(runtime, job_id):
    return runtime.runtime_jobs_repo.doc_ref(runtime.db, runtime.RUNTIME_JOBS_COLLECTION, job_id)


def admit_runtime_job(uid, job_id, mode, components, *, job_scope='', processed_count=1, runtime=None):
    """Commit the debit and a recoverable job before any background dispatch."""
    runtime = _runtime(runtime)
    if runtime.db is None or not hasattr(runtime.db, 'transaction'):
        raise ledger.LedgerUnavailable('Durable processing admission is unavailable.')
    charge_ref = f'runtime-job:{job_id}'
    job_ref = _job_ref(runtime, job_id)
    amount = policy.quote_components(components)['quoted_credits']

    @runtime.firestore.transactional
    def admit(transaction):
        existing_doc = job_ref.get(transaction=transaction)
        existing = existing_doc.to_dict() or {} if existing_doc.exists else {}
        if existing and (
            existing.get('user_id') != uid
            or existing.get('status') not in {'starting', 'queued'}
            or existing.get('recovery_claimed_at')
        ):
            raise ledger.LedgerConflict('This processing admission is no longer available.')
        context = ledger.read_charge_context(transaction, uid, charge_ref, runtime=runtime)
        prepared = ledger.prepare_charge(
            context, amount, mode, components=components, processed_count=processed_count,
            admission={'kind': 'runtime_job', 'job_id': job_id, 'state': 'admitted'}, runtime=runtime,
        )
        receipt = ledger.apply_charge(transaction, prepared)
        now = runtime.time.time()
        payload = {
            **existing, 'job_id': job_id, 'user_id': uid, 'mode': mode, 'job_scope': job_scope,
            'status': 'starting', 'step': 0, 'step_description': 'Starting...',
            'started_at': existing.get('started_at') or now, 'last_heartbeat_at': now,
            'credit_deducted': primary_credit_type(receipt), 'credit_refunded': False,
            **receipt_fields(receipt),
        }
        transaction.set(job_ref, runtime_jobs_store._build_runtime_job_payload(job_id, payload, runtime=runtime), merge=True)
        return payload

    try:
        payload = admit(runtime.db.transaction())
    except (ledger.InsufficientCredits, ledger.LedgerConflict, account_lifecycle.AccountUnavailableError):
        raise
    except Exception as error:
        # A commit acknowledgement can be lost after both writes became durable.
        # The matching admission is authoritative; never issue a second debit.
        try:
            snapshot = job_ref.get()
            payload = snapshot.to_dict() or {} if snapshot.exists else {}
            if (payload.get('user_id') != uid or payload.get('charge_ref') != charge_ref
                    or payload.get('credit_admission_state') != 'admitted'
                    or payload.get('status') not in {'starting', 'queued'}
                    or payload.get('recovery_claimed_at')):
                raise ledger.LedgerUnavailable('Could not reserve credits for processing.') from error
        except ledger.LedgerUnavailable:
            raise
        except Exception:
            raise ledger.LedgerUnavailable('Could not reserve credits for processing.') from error
    _cache_job(runtime, job_id, payload)
    return payload['billing_receipt']


def set_admitted_job(job_id, payload, *, runtime=None):
    """Keep the atomic receipt when a service fills in its processing details."""
    runtime = _runtime(runtime)
    if payload.get('status') in {'starting', 'queued'}:
        job_ref = _job_ref(runtime, job_id)

        @runtime.firestore.transactional
        def initialize(transaction):
            snapshot = job_ref.get(transaction=transaction)
            current = snapshot.to_dict() or {} if snapshot.exists else {}
            if (not current.get('charge_ref') or current.get('user_id') != payload.get('user_id')
                    or current.get('status') not in {'starting', 'queued'} or current.get('recovery_claimed_at')):
                raise ledger.LedgerConflict('This processing admission is no longer available.')
            context = ledger.read_charge_context(transaction, current['user_id'], current['charge_ref'], runtime=runtime)
            if context.journal_data.get('refund_started') or context.journal_data.get('admission_state') != 'admitted':
                raise ledger.LedgerConflict('This processing admission is no longer available.')
            updated = {**payload, **receipt_fields(current['billing_receipt']),
                       'started_at': current.get('started_at'), 'last_heartbeat_at': runtime.time.time()}
            transaction.set(job_ref, runtime_jobs_store._build_runtime_job_payload(job_id, updated, runtime=runtime), merge=True)
            return updated

        updated = initialize(runtime.db.transaction())
        _cache_job(runtime, job_id, updated)
        return updated
    current = runtime_jobs_store.get_job_snapshot(job_id, runtime=runtime) or {}
    receipt = current.get('billing_receipt') or {}
    updated = dict(payload)
    if current.get('charge_ref') and receipt.get('charge_ref'):
        supplied = updated.get('billing_receipt') or {}
        if supplied.get('charge_ref') != receipt['charge_ref']:
            updated.update(receipt_fields(receipt))
        else:
            updated.update(receipt_fields(supplied))
    return runtime_jobs_store.set_job(job_id, updated, runtime=runtime)


def begin_runtime_job(job_id, *, runtime=None):
    """A queued callback must not restart an admission already recovered/refunded."""
    runtime = _runtime(runtime)
    snapshot = runtime_jobs_store.get_job_snapshot(job_id, runtime=runtime)
    if not snapshot:
        return False
    if not snapshot.get('charge_ref') and snapshot.get('credit_scheme') != 2:
        return True
    job_ref = _job_ref(runtime, job_id)

    @runtime.firestore.transactional
    def begin(transaction):
        document = job_ref.get(transaction=transaction)
        current = document.to_dict() or {} if document.exists else {}
        if (current.get('status') not in {'starting', 'queued'} or current.get('recovery_claimed_at')
                or current.get('credit_admission_state') != 'admitted'):
            return None
        context = ledger.read_charge_context(transaction, current['user_id'], current['charge_ref'], runtime=runtime)
        if context.journal_data.get('refund_started'):
            return None
        current.update(status='processing', credit_admission_state='running', last_heartbeat_at=runtime.time.time())
        transaction.set(job_ref, runtime_jobs_store._build_runtime_job_payload(job_id, current, runtime=runtime), merge=True)
        return current

    try:
        current = begin(runtime.db.transaction())
        if current is not None:
            _cache_job(runtime, job_id, current)
        return current is not None
    except Exception:
        runtime.logger.warning('Processing credit admission could not start for %s', job_id, exc_info=True)
        return False


def admit_batch_row(uid, batch_id, row_id, mode, components, *, overnight=False, runtime=None):
    """Admit one staged row using a constant number of transaction writes."""
    runtime = _runtime(runtime)
    if runtime.db is None or not hasattr(runtime.db, 'transaction'):
        raise ledger.LedgerUnavailable('Durable batch admission is unavailable.')
    parent_ref = runtime.batch_repo.batch_job_doc_ref(runtime.db, batch_id)
    row_ref = runtime.batch_repo.batch_row_doc_ref(runtime.db, batch_id, row_id)
    charge_ref = f'batch-row:{batch_id}:{row_id}'
    amount = policy.quote_components(components, overnight=overnight)['quoted_credits']

    @runtime.firestore.transactional
    def admit(transaction):
        parent_doc = parent_ref.get(transaction=transaction)
        row_doc = row_ref.get(transaction=transaction)
        parent = parent_doc.to_dict() or {} if parent_doc.exists else {}
        row = row_doc.to_dict() or {} if row_doc.exists else {}
        if parent.get('uid') != uid or row.get('uid') != uid:
            raise ledger.LedgerConflict('The batch admission is unavailable.')
        if parent.get('status') != 'preparing' or parent.get('credit_admission_state') != 'pending':
            raise ledger.LedgerConflict('The batch admission is no longer available.')
        context = ledger.read_charge_context(transaction, uid, charge_ref, runtime=runtime)
        prepared = ledger.prepare_charge(
            context, amount, mode, components=components, overnight=overnight, processed_count=1,
            admission={'kind': 'batch_row', 'batch_id': batch_id, 'row_id': row_id, 'state': 'admitted'}, runtime=runtime,
        )
        receipt = ledger.apply_charge(transaction, prepared)
        now = runtime.time.time()
        transaction.update(row_ref, {
            **receipt_fields(receipt), 'credit_deducted': primary_credit_type(receipt),
            'credits_charged': receipt['charged_credits'], 'updated_at': now,
        })
        admitted = int(parent.get('admitted_rows', 0) or 0)
        charged = int(parent.get('credits_charged', 0) or 0)
        if row.get('credit_admission_state') != 'admitted':
            admitted += 1
            charged += receipt['charged_credits']
        transaction.update(parent_ref, {
            'admitted_rows': admitted, 'credits_charged': charged,
            'updated_at': now, 'last_heartbeat_at': now,
        })
        return receipt

    try:
        return admit(runtime.db.transaction())
    except (ledger.InsufficientCredits, ledger.LedgerConflict, account_lifecycle.AccountUnavailableError):
        raise
    except Exception as error:
        try:
            snapshot = row_ref.get()
            row = snapshot.to_dict() or {} if snapshot.exists else {}
            parent_snapshot = parent_ref.get()
            parent = parent_snapshot.to_dict() or {} if parent_snapshot.exists else {}
            if (row.get('uid') == uid and row.get('charge_ref') == charge_ref and row.get('credit_admission_state') == 'admitted'
                    and parent.get('status') == 'preparing' and parent.get('credit_admission_state') == 'pending'):
                return row['billing_receipt']
        except Exception:
            pass
        raise ledger.LedgerUnavailable('Could not reserve credits for this batch row.') from error


def persist_batch_admission(batch_id, payload, rows, *, runtime=None):
    """Stage at most 499 rows without overwriting a closed submission claim."""
    runtime = _runtime(runtime)
    parent_ref = runtime.batch_repo.batch_job_doc_ref(runtime.db, batch_id)
    if len(rows) > 499:
        raise ledger.LedgerConflict('Too many rows for one batch admission.')

    @runtime.firestore.transactional
    def persist(transaction):
        snapshot = parent_ref.get(transaction=transaction)
        existing = snapshot.to_dict() or {} if snapshot.exists else {}
        if existing and (existing.get('uid') != payload.get('uid') or existing.get('status') != 'preparing'
                         or existing.get('credit_admission_state') in {'closed', 'admitted'}
                         or int(existing.get('admitted_rows', 0) or 0) > 0):
            raise ledger.LedgerConflict('The batch submission is no longer available.')
        transaction.set(parent_ref, payload)
        for row_id, row in rows:
            transaction.set(runtime.batch_repo.batch_row_doc_ref(runtime.db, batch_id, row_id), row)

    persist(runtime.db.transaction())


def finish_batch_admission(uid, batch_id, *, runtime=None):
    runtime = _runtime(runtime)
    parent_ref = runtime.batch_repo.batch_job_doc_ref(runtime.db, batch_id)

    @runtime.firestore.transactional
    def finish(transaction):
        snapshot = parent_ref.get(transaction=transaction)
        parent = snapshot.to_dict() or {} if snapshot.exists else {}
        if (parent.get('uid') != uid or parent.get('status') != 'preparing'
                or parent.get('credit_admission_state') != 'pending'
                or int(parent.get('admitted_rows', 0) or 0) != int(parent.get('total_rows', 0) or 0)):
            raise ledger.LedgerConflict('The batch admission could not finish.')
        now = runtime.time.time()
        transaction.update(parent_ref, {
            'status': 'queued', 'credit_admission_state': 'admitted',
            'updated_at': now, 'last_heartbeat_at': now,
        })
        return True

    return finish(runtime.db.transaction())


def close_batch_admission(batch_id, *, stale_before=None, runtime=None):
    """Fence pending row debits before recovery lists rows for compensation."""
    runtime = _runtime(runtime)
    parent_ref = runtime.batch_repo.batch_job_doc_ref(runtime.db, batch_id)

    @runtime.firestore.transactional
    def close(transaction):
        snapshot = parent_ref.get(transaction=transaction)
        parent = snapshot.to_dict() or {} if snapshot.exists else {}
        if stale_before is not None:
            heartbeat = float(parent.get('last_heartbeat_at') or parent.get('updated_at') or parent.get('created_at') or 0)
            if (parent.get('status') != 'preparing' or parent.get('credit_admission_state') != 'pending'
                    or heartbeat > stale_before):
                return None
        if parent.get('credit_admission_state') == 'pending':
            transaction.update(parent_ref, {'credit_admission_state': 'closed'})
            parent['credit_admission_state'] = 'closed'
        return parent

    return close(runtime.db.transaction())


def _refund_component(job_data, component_id, target_units, refund_ref, *,
                      legacy_credit_type='', legacy_charged_units=0, processed_count=0, runtime=None):
    """Refund a cumulative component target without recalculating its price."""
    runtime = _runtime(runtime)
    uid = str(job_data.get('user_id') or job_data.get('uid') or '')
    receipt = job_data.get('billing_receipt') or {}
    charge_ref = job_data.get('charge_ref') or receipt.get('charge_ref')
    if charge_ref:
        component = (receipt.get('components') or {}).get(component_id)
        if not isinstance(component, dict):
            raise ledger.LedgerUnavailable('The original credit receipt is unavailable.')
        units = min(max(0, int(target_units)), int(component['units']))
        target = min(int(component['charged_credits']), units * int(component['unit_cost']))
        updated = ledger.refund_credits(
            uid, target, 'processing_refund', refund_ref, charge_ref=charge_ref,
            component_targets={component_id: target}, processed_count=processed_count, runtime=runtime,
        )
        job_data.update(receipt_fields(updated))
        job_data['credit_refunded'] = updated.get('refunded_credits', 0) > 0
        return True
    if job_data.get('credit_scheme') == 2:
        raise ledger.LedgerUnavailable('The original credit receipt is unavailable.')
    return ledger.refund_legacy_credits(
        uid, legacy_credit_type, target_units, refund_ref, charged_units=legacy_charged_units,
        processed_count=processed_count, runtime=runtime,
    )


def refund_component(job_data, component_id, target_units, refund_ref, *,
                     legacy_credit_type='', legacy_charged_units=0, processed_count=0, runtime=None):
    runtime = _runtime(runtime)
    try:
        return _refund_component(
            job_data, component_id, target_units, refund_ref, legacy_credit_type=legacy_credit_type,
            legacy_charged_units=legacy_charged_units, processed_count=processed_count, runtime=runtime,
        )
    except Exception:
        runtime.logger.warning('Could not settle processing credit refund %s', refund_ref, exc_info=True)
        return False


def refund_runtime_component(job_id, component_id, target_units, *, runtime=None):
    runtime = _runtime(runtime)
    job = runtime_jobs_store.get_job_snapshot(job_id, runtime=runtime) or {}
    success = refund_component(
        job, component_id, target_units, f'runtime-job:{job_id}:{component_id}',
        processed_count=1 if component_id == 'primary' else 0, runtime=runtime,
    )
    if success:
        runtime_jobs_store.set_job(job_id, job, runtime=runtime)
    return success


def _legacy_insufficient_credit_error(error, context):
    category = {'lecture': 'lecture', 'slides': 'text extraction', 'interview': 'interview'}[error.category]
    if context == 'batch':
        message = ('Not enough text extraction credits for interview extras in this batch row.'
                   if error.action == 'interview_extra'
                   else f'Not enough {category} credits to start this batch.')
        return {'error': message}, 400
    if error.action == 'interview_coding':
        return {
            'error': f'Not enough text extraction credits for AI coding. This transcript needs {error.needed} credit(s).',
            'error_code': 'insufficient_credits',
        }, 402
    if error.action == 'interview_extra':
        return {'error': 'Could not reserve text extraction credits for interview extras. Please try again.'}, 402
    if error.action == 'regenerate_study_tools':
        return {'error': 'Could not reserve a text extraction credit.'}, 402
    return {'error': f'No {category} credits remaining.'}, 402


def public_charge_error(error, *, context=''):
    if isinstance(error, account_lifecycle.AccountUnavailableError):
        return {'error': 'This account is unavailable.', 'error_code': 'account_unavailable'}, 409
    if isinstance(error, ledger.InsufficientCredits):
        if error.credit_scheme == 1:
            return _legacy_insufficient_credit_error(error, context)
        credit_word = 'credit' if error.needed == 1 else 'credits'
        return {
            'error': f'Not enough credits. This needs {error.needed} {credit_word}; {error.available} are available.',
            'error_code': 'insufficient_credits', 'needed': error.needed, 'available': error.available,
        }, 402
    if isinstance(error, ledger.LedgerConflict):
        return {'error': 'This processing request could not be repeated.', 'error_code': 'credit_request_conflict'}, 409
    return {'error': 'Could not reserve credits. Please try again.', 'error_code': 'credit_service_unavailable'}, 503


def reserve_runtime_job(uid, job_id, mode, components, *, job_scope='', processed_count=1, runtime=None):
    runtime = _runtime(runtime)
    try:
        return admit_runtime_job(
            uid, job_id, mode, components, job_scope=job_scope, processed_count=processed_count, runtime=runtime,
        ), None, 0
    except Exception as error:
        runtime.logger.warning('Processing credit admission failed for %s', job_id, exc_info=True)
        payload, status = public_charge_error(error)
        return None, payload, status
