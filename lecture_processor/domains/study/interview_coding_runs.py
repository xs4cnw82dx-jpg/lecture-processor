"""Durable admission and completion of background interview coding runs."""

import json

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.billing import job_charges, ledger, policy, receipts
from lecture_processor.domains.runtime_jobs import execution, store

SCOPE = 'interview-coding'
ACTIVE_STATUSES = {'queued', 'processing', 'refund_pending'}
REUSABLE_STATUSES = ACTIVE_STATUSES | {'draft', 'accepting'}
SUCCESS_STATUSES = {'draft', 'accepting', 'accepted', 'rejected'}
ERROR_MESSAGE = 'AI coding could not be completed. Please try again.'
ERROR_CODE = 'interview_coding_failed'
# Leave room for Firestore field overhead and a later acceptance plan.
MAX_RUN_PAYLOAD_BYTES = 750_000


class RunError(Exception):
    def __init__(self, message, status=409, code='interview_coding_unavailable'):
        super().__init__(message)
        self.status, self.code = status, code


def run_ref(runtime, run_id):
    return runtime.db.collection('interview_ai_coding_runs').document(run_id)


def _job_ref(runtime, run_id):
    return runtime.runtime_jobs_repo.doc_ref(runtime.db, runtime.RUNTIME_JOBS_COLLECTION, run_id)


def _validate_target(runtime, transaction, uid, pack_id):
    pack_ref = runtime.db.collection('study_packs').document(pack_id)
    pack_doc = pack_ref.get(transaction=transaction)
    if not pack_doc.exists:
        raise RunError('Study pack not found', 404)
    pack = pack_doc.to_dict() or {}
    if pack.get('uid') != uid:
        raise RunError('Forbidden', 403)
    if pack.get('mode') != 'interview':
        raise RunError('Interview coding is only available for interview packs', 400)
    user_ref = runtime.users_repo.doc_ref(runtime.db, uid)
    user_doc = user_ref.get(transaction=transaction)
    user = user_doc.to_dict() or {}
    if not user_doc.exists or str(user.get('account_status', '')).lower() in {'deleting', 'deleted'}:
        raise RunError('Account is unavailable. New work is blocked.')
    try:
        account_lifecycle.require_account_access(uid, runtime=runtime, transaction=transaction)
    except account_lifecycle.AccountUnavailableError as error:
        raise RunError('Account is unavailable. New work is blocked.') from error
    return pack_ref, pack, user_ref, user


def _write_job(runtime, transaction, ref, payload):
    transaction.set(ref, store._build_runtime_job_payload(ref.id, payload, runtime=runtime), merge=True)


def cache_job(runtime, run_id):
    # Cache only a fresh committed snapshot. Never repersist a cached status over
    # a newer transaction (the heartbeat itself writes only its timestamp).
    with runtime.JOBS_LOCK:
        snapshot = _job_ref(runtime, run_id).get()
        if snapshot.exists:
            runtime.jobs[run_id] = snapshot.to_dict() or {}


def _legacy_job(runtime, run, uid, pack_id):
    now = runtime.time.time()
    return {
        'status': 'processing', 'job_scope': SCOPE, 'mode': 'interview',
        'step': 0, 'total_steps': 1, 'result': '', 'step_description': 'Coding interview',
        'user_id': uid, 'study_pack_id': pack_id,
        'started_at': run.get('created_at') or now,
        # Give pre-background request handlers one recovery window to drain.
        # The configured Gunicorn rollout drains old workers within 30 seconds;
        # those old handlers cannot participate in the new completion claim.
        'last_heartbeat_at': now,
        'study_tools_credit_cost': run.get('credit_cost', 0),
    }


def adopt_legacy_active_run(runtime, uid, pack_id, run_id):
    """Make a pre-background run recoverable when its owner reloads the page."""
    @runtime.firestore.transactional
    def adopt(transaction):
        ref = run_ref(runtime, run_id)
        doc = ref.get(transaction=transaction)
        run = doc.to_dict() or {}
        if not doc.exists:
            raise RunError('AI coding run not found', 404)
        if run.get('uid') != uid or run.get('pack_id') != pack_id:
            raise RunError('Forbidden', 403)
        if run.get('status') not in ACTIVE_STATUSES or run.get('runtime_job_id'):
            return
        pack_ref, pack, _user_ref, _user = _validate_target(runtime, transaction, uid, pack_id)
        job_ref = _job_ref(runtime, run_id)
        job_doc = job_ref.get(transaction=transaction)
        if not job_doc.exists:
            _write_job(runtime, transaction, job_ref, _legacy_job(runtime, run, uid, pack_id))
        transaction.update(ref, {'runtime_job_id': run_id})
        if not pack.get('interview_coding_run_id'):
            transaction.update(pack_ref, {'interview_coding_run_id': run_id})
    adopt(runtime.db.transaction())


def claim_run(runtime, uid, pack_id, cost, *, email=''):
    pack_snapshot = runtime.db.collection('study_packs').document(pack_id).get()
    legacy_candidates = []
    if not (pack_snapshot.to_dict() or {}).get('interview_coding_run_id'):
        # The historical query's default limit is unordered; inspect all runs
        # once when adopting a pack, then use its transactional pointer.
        docs = runtime.repositories.study.list_interview_ai_coding_runs_by_uid_and_pack(
            runtime.db, uid, pack_id, limit=None,
        )
        legacy_candidates = sorted(
            (doc for doc in docs if (doc.to_dict() or {}).get('status') in REUSABLE_STATUSES),
            key=lambda doc: float((doc.to_dict() or {}).get('created_at', 0) or 0), reverse=True,
        )
    new_ref = runtime.repositories.study.create_interview_ai_coding_run_doc_ref(runtime.db)

    @runtime.firestore.transactional
    def claim(transaction):
        pack_ref, pack, user_ref, user = _validate_target(runtime, transaction, uid, pack_id)
        current_id = str(pack.get('interview_coding_run_id', '') or '')
        candidates = [run_ref(runtime, current_id)] if current_id else [doc.reference for doc in legacy_candidates]
        for candidate in candidates:
            snapshot = candidate.get(transaction=transaction)
            current = snapshot.to_dict() or {}
            if snapshot.exists and current.get('uid') == uid and current.get('pack_id') == pack_id and current.get('status') in REUSABLE_STATUSES:
                legacy_active = current.get('status') in ACTIVE_STATUSES and not current.get('runtime_job_id')
                if legacy_active:
                    job_ref = _job_ref(runtime, candidate.id)
                    job_doc = job_ref.get(transaction=transaction)
                if not current_id:
                    transaction.update(pack_ref, {'interview_coding_run_id': candidate.id})
                if legacy_active:
                    if not job_doc.exists:
                        _write_job(runtime, transaction, job_ref, _legacy_job(runtime, current, uid, pack_id))
                    transaction.update(candidate, {'runtime_job_id': candidate.id})
                return candidate.id, False
        if getattr(runtime, 'client', None) is None:
            raise RunError('AI coding is currently unavailable. Please try again.', 503)
        # The account write also serializes simultaneous coding admissions for
        # different packs. Transaction retries repeat the existing account limit.
        count = account_lifecycle.count_active_jobs_for_user(uid, runtime=runtime)
        if count >= runtime.MAX_ACTIVE_JOBS_PER_USER:
            raise RunError('Please wait for an active processing job to finish before starting another.', 429, 'active_job_limit')
        charge_ref = f'interview-coding-run:{new_ref.id}:credits'
        context = ledger.read_charge_context(transaction, uid, charge_ref, runtime=runtime)
        prepared = ledger.prepare_charge(
            context, policy.action_cost('interview_coding', units=cost), 'interview_coding',
            components={'primary': {'action': 'interview_coding', 'units': cost}},
            admission={'kind': 'interview_coding', 'run_id': new_ref.id, 'state': 'admitted'}, runtime=runtime,
        )
        receipt = ledger.apply_charge(transaction, prepared)
        charged = receipt['charged_credits']
        now = runtime.time.time()
        run = {
            'run_id': new_ref.id, 'runtime_job_id': new_ref.id, 'uid': uid, 'pack_id': pack_id, 'status': 'queued',
            'model': getattr(runtime, 'MODEL_INTERVIEW_CODING', 'gemini-3.8-flash'),
            'thinking_level': 'high', 'prompt_version': getattr(runtime, 'PROMPT_REGISTRY_VERSION', 'v1'),
            'proposed_codes': [], 'proposed_quotations': [], 'token_usage_by_stage': {},
            'credit_cost': receipt['components']['primary']['quoted_credits'], 'credit_charged': charged,
            **job_charges.receipt_fields(receipt),
            'created_at': now, 'updated_at': now,
        }
        job = {
            'status': 'queued', 'job_scope': SCOPE, 'mode': 'interview',
            'step': 0, 'total_steps': 1, 'result': '',
            'user_id': uid, 'user_email': email, 'study_pack_id': pack_id,
            'study_pack_title': str(pack.get('title', '') or ''), 'started_at': now,
            'last_heartbeat_at': now, 'step_description': 'Waiting to code interview',
            **job_charges.receipt_fields(receipt), 'study_tools_credit_cost': cost,
        }
        transaction.set(new_ref, run)
        transaction.update(pack_ref, {'interview_coding_run_id': new_ref.id})
        _write_job(runtime, transaction, _job_ref(runtime, new_ref.id), job)
        return new_ref.id, True

    try:
        return claim(runtime.db.transaction())
    except RunError:
        raise
    except Exception:
        # A successful commit may lose its acknowledgement. Its durable run
        # proves the debit committed too; dispatch that same run instead.
        committed = new_ref.get()
        payload = committed.to_dict() or {}
        if committed.exists and payload.get('uid') == uid and payload.get('pack_id') == pack_id:
            return new_ref.id, True
        raise


def start_processing(runtime, run_id):
    @runtime.firestore.transactional
    def start(transaction):
        ref = run_ref(runtime, run_id)
        doc = ref.get(transaction=transaction)
        run = doc.to_dict() or {}
        if not doc.exists or run.get('status') != 'queued':
            return False
        job_ref = _job_ref(runtime, run_id)
        job = job_ref.get(transaction=transaction).to_dict() or {}
        _validate_target(runtime, transaction, run['uid'], run['pack_id'])
        now = runtime.time.time()
        transaction.update(ref, {'status': 'processing', 'updated_at': now})
        _write_job(runtime, transaction, job_ref, {**job, 'status': 'processing', 'last_heartbeat_at': now,
                                                  'step_description': 'Coding interview'})
        return True
    result = start(runtime.db.transaction())
    cache_job(runtime, run_id)
    return result


def can_continue(runtime, run_id):
    """Check lifecycle changes between provider calls without restarting work."""
    @runtime.firestore.transactional
    def check(transaction):
        doc = run_ref(runtime, run_id).get(transaction=transaction)
        run = doc.to_dict() or {}
        if not doc.exists or run.get('status') != 'processing':
            return False
        _validate_target(runtime, transaction, run['uid'], run['pack_id'])
        return True
    return check(runtime.db.transaction())


def complete_run(runtime, run_id, proposals, *, transcript, existing_codes):
    if len(json.dumps(proposals, ensure_ascii=False).encode('utf-8')) > MAX_RUN_PAYLOAD_BYTES:
        raise RunError('The coding result is too large to save. Please use a shorter interview.')

    @runtime.firestore.transactional
    def complete(transaction):
        ref = run_ref(runtime, run_id)
        doc = ref.get(transaction=transaction)
        run = doc.to_dict() or {}
        job_ref = _job_ref(runtime, run_id)
        job = job_ref.get(transaction=transaction).to_dict() or {}
        if not doc.exists or run.get('status') != 'processing':
            return False
        _validate_target(runtime, transaction, run['uid'], run['pack_id'])
        now = runtime.time.time()
        # Expanded deterministic code IDs and the acceptance map can be much
        # larger than provider references. Budget the eventual complete record
        # before publishing a draft that cannot be applied.
        from lecture_processor.domains.study import interview_coding_acceptance
        draft = {**run, **proposals}
        plan = interview_coding_acceptance._prepare_plan(
            run_id, draft, run['pack_id'], transcript, existing_codes, now,
        )
        if len(json.dumps({**draft, **plan}, ensure_ascii=False).encode('utf-8')) > MAX_RUN_PAYLOAD_BYTES:
            raise RunError('The coding result is too large to save. Please use a shorter interview.')
        transaction.update(ref, {**proposals, 'status': 'draft', 'updated_at': now})
        _write_job(runtime, transaction, job_ref, {**job, 'status': 'complete', 'step': 1, 'finished_at': now,
                                                  'step_description': 'Coding draft ready'})
        return True
    result = complete(runtime.db.transaction())
    cache_job(runtime, run_id)
    return result


def fail_run(runtime, run_id, *, orphan=False, now_ts=None):
    now = runtime.time.time() if now_ts is None else now_ts

    @runtime.firestore.transactional
    def claim_failure(transaction):
        ref = run_ref(runtime, run_id)
        doc = ref.get(transaction=transaction)
        run = doc.to_dict() or {}
        job_ref = _job_ref(runtime, run_id)
        job_doc = job_ref.get(transaction=transaction)
        job = job_doc.to_dict() or {}
        if not doc.exists:
            return None
        if run.get('status') in SUCCESS_STATUSES:
            if job_doc.exists and job.get('status') in {'queued', 'starting', 'processing'}:
                _write_job(runtime, transaction, job_ref, {**job, 'status': 'complete', 'finished_at': now,
                                                          'step_description': 'Coding draft ready'})
            return None
        if run.get('status') not in ACTIVE_STATUSES:
            return None
        if orphan:
            from lecture_processor.domains.runtime_jobs import recovery
            if execution.is_job_active(run_id, runtime=runtime) or not recovery._runtime_job_is_stale(job, now_ts=now, runtime=runtime):
                return None
            claimed_at = float(job.get('recovery_claimed_at', 0) or 0)
            if claimed_at and now - claimed_at < recovery._runtime_job_recovery_stale_seconds(runtime=runtime):
                return None
        transaction.update(ref, {'status': 'refund_pending', 'error': ERROR_MESSAGE, 'error_code': ERROR_CODE, 'updated_at': now})
        _write_job(runtime, transaction, job_ref, {
            **job, 'status': 'processing', 'error': ERROR_MESSAGE,
            'step_description': 'Finalizing coding run', 'recovery_claimed_at': now,
        })
        return run

    run = claim_failure(runtime.db.transaction())
    if run is None:
        cache_job(runtime, run_id)
        return False
    charged = max(0, int(run.get('credit_charged', run.get('credit_cost', 0)) or 0))
    if run.get('charge_ref') or run.get('credit_scheme') == 2:
        units = int(((run.get('billing_receipt') or {}).get('components') or {}).get('primary', {}).get('units', 0))
        refunded = job_charges.refund_component(run, 'primary', units, f'interview-coding-run:{run_id}:credits', runtime=runtime)
    else:
        refunded = charged == 0 or job_charges.refund_component(
            run, 'primary', charged, f'interview-coding-run:{run_id}:credits',
            legacy_credit_type='slides_credits', legacy_charged_units=charged, runtime=runtime,
        )
    if not refunded:
        cache_job(runtime, run_id)
        return False

    @runtime.firestore.transactional
    def settle(transaction):
        ref = run_ref(runtime, run_id)
        doc = ref.get(transaction=transaction)
        job_ref = _job_ref(runtime, run_id)
        job = job_ref.get(transaction=transaction).to_dict() or {}
        if not doc.exists or (doc.to_dict() or {}).get('status') != 'refund_pending':
            return False
        if run.get('charge_ref'):
            receipt = run['billing_receipt']
        else:
            receipt = receipts.initialize_billing_receipt({'slides_credits': charged}, runtime=runtime)
            receipt['refunded'] = {'slides_credits': charged} if charged else {}
        finished = runtime.time.time()
        credit_fields = job_charges.receipt_fields(receipt) if run.get('charge_ref') else {'billing_receipt': receipt}
        transaction.update(ref, {'status': 'failed', 'credit_refunded': charged > 0,
                                 **credit_fields, 'updated_at': finished})
        _write_job(runtime, transaction, job_ref, {**job, 'status': 'error', 'finished_at': finished,
                                                  'credit_refunded': charged > 0, **credit_fields,
                                                  'step_description': ERROR_MESSAGE})
        return True
    result = settle(runtime.db.transaction())
    cache_job(runtime, run_id)
    return result
