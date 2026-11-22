from copy import deepcopy
from functools import wraps
from threading import RLock
from types import SimpleNamespace

from lecture_processor.domains.runtime_jobs import execution, recovery
from tests.credit_test_support import make_credit_runtime


class JobSnapshot:
    def __init__(self, reference, payload):
        self.reference = reference
        self.id = reference.id
        self.exists = payload is not None
        self.payload = deepcopy(payload)

    def to_dict(self):
        return deepcopy(self.payload)


class JobReference:
    def __init__(self, state, job_id):
        self.state = state
        self.id = job_id

    def get(self, transaction=None):
        if transaction is not None:
            self.state['transaction_reads'] += 1
            callback = self.state.pop('before_transaction_read', None)
            if callback:
                callback()
        return JobSnapshot(self, self.state['durable'].get(self.id))


def make_recovery_state(monkeypatch):
    state = {
        'now': 1000.0,
        'durable': {},
        'memory': {},
        'active': set(),
        'refunds': [],
        'logs': [],
        'queries': 0,
        'reads': 0,
        'transaction_reads': 0,
        'lease_calls': 0,
        'lease_available': True,
        'viewer': 'owner',
        'admin': False,
        'events': [],
    }
    transaction_lock = RLock()
    credit_runtime, credit_store = make_credit_runtime(
        users={'owner': {'uid': 'owner', 'lecture_credits_standard': 0, 'slides_credits': 0,
                         'total_processed': 1}}, unified_enabled=False,
    )
    compatibility_refund = recovery.job_charges.ledger.refund_legacy_credits
    state['credit_runtime'], state['credit_store'] = credit_runtime, credit_store
    state['compatibility_refund'] = compatibility_refund

    class Transaction:
        def set(self, ref, payload, merge=False):
            if not merge:
                state['durable'][ref.id] = {}
            state['durable'].setdefault(ref.id, {}).update(deepcopy(payload))

    def transactional(callback):
        @wraps(callback)
        def run(transaction):
            with transaction_lock:
                return callback(transaction)
        return run

    def get_doc(_db, _collection, job_id):
        state['reads'] += 1
        return JobReference(state, job_id).get()

    def query_statuses(_db, _collection, statuses, limit):
        state['queries'] += 1
        return [JobReference(state, job_id).get() for job_id, job in state['durable'].items()
                if job.get('status') in statuses][:limit]

    def set_job(job_id, payload, runtime=None):
        state['memory'][job_id] = deepcopy(payload)
        state['durable'].setdefault(job_id, {}).update(deepcopy(payload))

    def get_snapshot(job_id, runtime=None):
        return deepcopy(state['memory'].get(job_id) or state['durable'].get(job_id))

    def acquire_lease(*_args, **_kwargs):
        state['lease_calls'] += 1
        return state['lease_available']

    def refund(uid, credit_type, target_units, refund_ref, **kwargs):
        kwargs['runtime'] = credit_runtime
        result = compatibility_refund(uid, credit_type, target_units, refund_ref, **kwargs)
        state['refunds'].append((uid, (credit_type, target_units), refund_ref))
        return result

    def verify(_request, **kwargs):
        if kwargs.get('check_revoked'):
            state['events'].append('admin-check')
        return {'uid': state['viewer']} if state['viewer'] else None

    runtime = SimpleNamespace(
        db=SimpleNamespace(transaction=Transaction),
        firestore=SimpleNamespace(transactional=transactional),
        runtime_jobs_repo=SimpleNamespace(get_doc=get_doc, query_statuses=query_statuses),
        RUNTIME_JOBS_COLLECTION='runtime_jobs',
        RUNTIME_JOB_RECOVERY_ENABLED=True,
        RUNTIME_JOB_RECOVERY_STALE_SECONDS=0,
        RUNTIME_JOB_RECOVERY_LEASE_SECONDS=300,
        RUNTIME_JOB_RECOVERY_BATCH_LIMIT=10,
        RUNTIME_JOB_RECOVERY_LOCK=RLock(),
        RUNTIME_JOB_RECOVERY_DONE=False,
        time=SimpleNamespace(time=lambda: state['now']),
        os=SimpleNamespace(getenv=lambda *_: 'synthetic-instance', getpid=lambda: 1),
        logger=SimpleNamespace(info=lambda *_args, **_kwargs: None, warning=lambda *_args, **_kwargs: None),
        save_job_log=lambda *args: state['logs'].append(deepcopy(args)),
        verify_firebase_token=verify,
        is_admin_user=lambda _token: state['admin'],
        jsonify=lambda payload: payload,
        cleanup_old_jobs=lambda: None,
    )
    state['runtime'] = runtime
    monkeypatch.setattr(execution, 'is_job_active', lambda job_id, runtime=None: job_id in state['active'])
    monkeypatch.setattr(recovery, 'acquire_runtime_job_recovery_lease', acquire_lease)
    monkeypatch.setattr(recovery.runtime_jobs_store, 'set_job', set_job)
    monkeypatch.setattr(recovery.runtime_jobs_store, 'get_job_snapshot', get_snapshot)
    monkeypatch.setattr(recovery.job_charges.ledger, 'refund_legacy_credits', refund)
    return state


def add_job(state, job_id='job', **overrides):
    job = {
        'user_id': 'owner', 'status': 'processing', 'step': 1, 'step_description': 'Working',
        'started_at': 100.0, 'updated_at': 100.0, 'last_heartbeat_at': 100.0,
        'credit_deducted': 'lecture_credits_standard', 'credit_refunded': False,
        'study_tools_credit_cost': 1, 'extra_slides_refunded': 0,
        'billing_receipt': {'charged': {'lecture_credits_standard': 1, 'slides_credits': 1}, 'refunded': {}},
        **overrides,
    }
    state['durable'][job_id] = deepcopy(job)
    state['memory'][job_id] = deepcopy(job)
    return job
