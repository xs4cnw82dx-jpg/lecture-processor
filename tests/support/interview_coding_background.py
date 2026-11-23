import logging
from copy import deepcopy
from functools import wraps
from threading import RLock
from types import SimpleNamespace

from lecture_processor.domains.ai.providers.contracts import GenerationResult, Usage
from lecture_processor.domains.runtime_jobs.schema import PERSISTED_RUNTIME_JOB_FIELDS
from lecture_processor.repositories import runtime_jobs_repo, study_repo, users_repo
from lecture_processor.services import access_service
from lecture_processor.services import interview_coding_service as service
from lecture_processor.services import job_state_service


class Increment:
    def __init__(self, value):
        self.value = value


class Snapshot:
    def __init__(self, ref):
        self.reference, self.id = ref, ref.id
        self.payload = deepcopy(ref.state.documents.get(ref.path))
        self.exists = self.payload is not None

    def to_dict(self):
        return deepcopy(self.payload)


class Reference:
    def __init__(self, state, collection, document_id):
        self.state, self.id, self.path = state, document_id, (collection, document_id)

    def get(self, transaction=None):
        if transaction is not None:
            assert not transaction.operations, 'Read after transaction write'
        return Snapshot(self)

    def set(self, payload, merge=False):
        transaction = Transaction(self.state)
        transaction.set(self, payload, merge)
        transaction.commit()

    def update(self, payload):
        self.set(payload, merge=True)


class Query:
    def __init__(self, state, collection, filters=(), limit=None):
        self.state, self.collection, self.filters, self.maximum = state, collection, filters, limit

    def document(self, key=None):
        if key is None:
            self.state.serial += 1
            key = f'run-{self.state.serial}'
        return Reference(self.state, self.collection, key)

    def where(self, *args, filter=None):
        condition = (filter.field_path, filter.op_string, filter.value) if filter is not None else args
        return Query(self.state, self.collection, (*self.filters, condition), self.maximum)

    def limit(self, limit):
        return Query(self.state, self.collection, self.filters, limit)

    def stream(self, transaction=None):
        if transaction is not None:
            assert not transaction.operations

        def matches(data, condition):
            field, operator, value = condition
            actual = data.get(field)
            if operator == '==':
                return actual == value
            if operator == 'in':
                return actual in value
            if operator == '>':
                return actual is not None and actual > value
            raise AssertionError(f'Unsupported query operator: {operator}')

        docs = []
        for (collection, key), data in list(self.state.documents.items()):
            if collection != self.collection:
                continue
            if all(matches(data, condition) for condition in self.filters):
                docs.append(self.document(key).get())
        return iter(docs[:self.maximum])


class Transaction:
    def __init__(self, state):
        self.state, self.operations = state, []

    def set(self, ref, payload, merge=False):
        self.operations.append((ref, deepcopy(payload), merge))

    def update(self, ref, payload):
        self.set(ref, payload, True)

    def commit(self):
        if self.state.before_commit:
            self.state.before_commit(self.operations)
        for ref, payload, merge in self.operations:
            target = self.state.documents.setdefault(ref.path, {}) if merge else {}
            for key, value in payload.items():
                target[key] = target.get(key, 0) + value.value if isinstance(value, Increment) else deepcopy(value)
            self.state.documents[ref.path] = target
        if self.state.after_commit:
            self.state.after_commit(self.operations)


def make_coding(monkeypatch):
    state = SimpleNamespace(documents={}, serial=0, now=1000.0, before_commit=None, after_commit=None,
                            queued=[], provider_calls=0, uid='owner', transcript='Hello world')
    lock = RLock()

    def transactional(callback):
        @wraps(callback)
        def execute(transaction, *args, **kwargs):
            with lock:
                result = callback(transaction, *args, **kwargs)
                transaction.commit()
                return result
        return execute

    def generate(*_args, **_kwargs):
        state.provider_calls += 1
        return GenerationResult('{"codes":[{"temp_id":"c1","name":"Guidance"}],"quotations":[]}',
                                None, Usage(), 'gemini', 'gemini-3.8-flash')

    def submit(target, *args, **kwargs):
        state.queued.append((target, args, kwargs))

    state.db = SimpleNamespace(collection=lambda name: Query(state, name), transaction=lambda: Transaction(state))
    state.runtime = SimpleNamespace(
        db=state.db, firestore=SimpleNamespace(transactional=transactional, Increment=Increment),
        repositories=SimpleNamespace(study=study_repo, runtime_jobs=runtime_jobs_repo, users=users_repo), users_repo=users_repo, runtime_jobs_repo=runtime_jobs_repo,
        batch_repo=SimpleNamespace(list_batch_jobs_by_uid_and_statuses=lambda *_args, **_kwargs: []),
        time=SimpleNamespace(time=lambda: state.now), jsonify=lambda payload: payload,
        logger=logging.getLogger('test-coding'), client=object(), jobs={}, JOBS_LOCK=RLock(),
        job_state_service=job_state_service, RUNTIME_JOBS_COLLECTION='runtime_jobs',
        RUNTIME_JOB_PERSISTED_FIELDS=PERSISTED_RUNTIME_JOB_FIELDS, JOB_TTL_SECONDS=1800,
        RUNTIME_JOB_RECOVERY_ENABLED=True, RUNTIME_JOB_RECOVERY_BATCH_LIMIT=100,
        MAX_ACTIVE_JOBS_PER_USER=2, PROMPT_INTERVIEW_CODING='Synthetic prompt', is_admin_user=lambda _token: False,
        submit_background_job=submit, save_job_log=lambda *_args: None,
    )
    state.documents[('users', 'owner')] = {'uid': 'owner', 'account_status': 'active', 'slides_credits': 10}
    state.documents[('study_packs', 'pack-1')] = {'uid': 'owner', 'mode': 'interview', 'title': 'Interview'}
    state.runtime.get_or_create_user = lambda *_args: deepcopy(state.documents[('users', 'owner')])
    monkeypatch.setattr(access_service, 'require_allowed_user', lambda *_args, **_kwargs: ({'uid': state.uid}, None, None))
    monkeypatch.setattr(access_service, 'account_write_guard', lambda *_args: None)
    monkeypatch.setattr(service, '_require_interview_pack', lambda *_args: (deepcopy(state.documents.get(('study_packs', 'pack-1'), {})), state.transcript, None, None))
    state.generate = generate
    monkeypatch.setattr(service.factory, 'open_provider_session', lambda _runtime: SimpleNamespace(
        generate=lambda *args, **kwargs: state.generate(*args, **kwargs), close=lambda: None))
    state.start = lambda: service.start_ai_coding_run(state.runtime, None, 'pack-1')
    state.docs = lambda collection: {key: value for (kind, key), value in state.documents.items() if kind == collection}
    def work():
        target, args, kwargs = state.queued.pop(0)
        return target(*args, **kwargs)

    state.work = work
    return state


def start(coding):
    response, status = coding.start()
    assert status == 202
    return response['run']['run_id']
