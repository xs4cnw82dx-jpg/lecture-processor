"""Synthetic Firestore with queued atomic writes for financial behavior tests."""

from copy import deepcopy
from functools import wraps
import logging
from threading import RLock
from types import SimpleNamespace

from lecture_processor.repositories import users_repo


class Increment:
    def __init__(self, value):
        self.value = value


class Snapshot:
    def __init__(self, ref, payload):
        self.reference, self.id = ref, ref.id
        self.payload = deepcopy(payload)
        self.exists = payload is not None

    def to_dict(self):
        return deepcopy(self.payload)

    def get(self, field):
        return self.payload[field]


class Reference:
    def __init__(self, store, collection, key):
        self.store, self.id = store, str(key)
        self.path = (collection, self.id)

    def collection(self, name):
        return Query(self.store, f'{self.path[0]}/{self.id}/{name}')

    def get(self, transaction=None, field_paths=None):
        if transaction is not None:
            assert not transaction.operations, 'Read after transaction write'
        with self.store.lock:
            self.store.reads.append(self.path)
            if self.path in self.store.fail_reads:
                raise RuntimeError('Synthetic read failure')
            payload = self.store.documents.get(self.path)
            if payload is not None and field_paths is not None:
                payload = {key: payload[key] for key in field_paths if key in payload}
            return Snapshot(self, payload)

    def set(self, payload, merge=False):
        transaction = Transaction(self.store)
        transaction.set(self, payload, merge=merge)
        transaction.commit()

    def update(self, payload):
        transaction = Transaction(self.store)
        transaction.update(self, payload)
        transaction.commit()

    def delete(self):
        transaction = Transaction(self.store)
        transaction.delete(self)
        transaction.commit()


class Query:
    def __init__(self, store, collection, filters=(), maximum=None, ordering=(), fields=None):
        self.store, self.collection = store, collection
        self.filters, self.maximum, self.ordering, self.fields = filters, maximum, ordering, fields

    def document(self, key=None):
        if key is None:
            with self.store.lock:
                self.store.serial += 1
                key = f'synthetic-{self.store.serial}'
        return Reference(self.store, self.collection, key)

    def where(self, *args, filter=None):
        condition = (filter.field_path, filter.op_string, filter.value) if filter is not None else args
        return Query(self.store, self.collection, (*self.filters, condition), self.maximum, self.ordering, self.fields)

    def limit(self, maximum):
        return Query(self.store, self.collection, self.filters, maximum, self.ordering, self.fields)

    def order_by(self, field, direction='ASCENDING'):
        return Query(self.store, self.collection, self.filters, self.maximum, (*self.ordering, (field, direction)), self.fields)

    def select(self, fields):
        return Query(self.store, self.collection, self.filters, self.maximum, self.ordering, fields)

    def stream(self, transaction=None):
        if transaction is not None:
            assert not transaction.operations, 'Read after transaction write'
        def matches(data, condition):
            field, operator, value = condition
            actual = data.get(field)
            if operator == '==':
                return actual == value
            if operator == 'in':
                return actual in value
            if operator == 'array_contains':
                return value in (actual or [])
            if operator == '<=':
                return actual is not None and actual <= value
            if operator == '>=':
                return actual is not None and actual >= value
            if operator == '<':
                return actual is not None and actual < value
            if operator == '>':
                return actual is not None and actual > value
            raise AssertionError(f'Unsupported query operator: {operator}')

        with self.store.lock:
            records = [(key, data) for (collection, key), data in self.store.documents.items()
                       if collection == self.collection and all(matches(data, item) for item in self.filters)]
            for field, direction in reversed(self.ordering):
                records.sort(key=lambda item: item[1].get(field, 0), reverse=str(direction).upper() == 'DESCENDING')
            snapshots = [self.document(key).get(transaction=transaction, field_paths=self.fields)
                         for key, _data in records[:self.maximum]]
            return iter(snapshots)

    def get(self, transaction=None):
        return list(self.stream(transaction=transaction))


class Transaction:
    def __init__(self, store):
        self.store, self.operations = store, []

    def get(self, ref):
        if isinstance(ref, Query):
            return ref.stream(transaction=self)
        return iter([ref.get(transaction=self)])

    def set(self, ref, payload, merge=False):
        self.operations.append(('set', ref, deepcopy(payload), merge))

    def update(self, ref, payload):
        self.operations.append(('update', ref, deepcopy(payload), True))

    def delete(self, ref):
        self.operations.append(('delete', ref, None, False))

    def commit(self):
        with self.store.lock:
            if self.store.before_commit:
                self.store.before_commit(self.operations)
            documents = deepcopy(self.store.documents)
            for operation, ref, payload, merge in self.operations:
                if ref.path in self.store.fail_writes:
                    raise RuntimeError('Synthetic write failure')
                if operation == 'delete':
                    documents.pop(ref.path, None)
                    continue
                if operation == 'update' and ref.path not in documents:
                    raise RuntimeError('No document to update')
                target = documents.get(ref.path, {}) if merge else {}
                for key, value in payload.items():
                    if isinstance(value, Increment):
                        target[key] = target.get(key, 0) + value.value
                    else:
                        target[key] = deepcopy(value)
                documents[ref.path] = target
            self.store.documents = documents
            self.store.commit_count += 1
            self.store.commits.append(list(self.operations))
            if self.store.after_commit:
                self.store.after_commit(self.operations)


class CreditStore:
    def __init__(self, documents=None):
        self.documents = deepcopy(documents or {})
        self.lock, self.now, self.serial = RLock(), 1000.0, 0
        self.before_commit = self.after_commit = None
        self.fail_reads, self.fail_writes = set(), set()
        self.commit_count, self.commits, self.reads = 0, [], []
        self.db = SimpleNamespace(
            collection=lambda name: Query(self, name),
            transaction=lambda: Transaction(self), batch=lambda: Transaction(self),
        )

    def docs(self, collection):
        return {key: deepcopy(value) for (kind, key), value in self.documents.items() if kind == collection}

    def transactional(self, callback):
        @wraps(callback)
        def execute(transaction, *args, **kwargs):
            with self.lock:
                result = callback(transaction, *args, **kwargs)
                transaction.commit()
                return result
        return execute


def make_credit_runtime(*, users=None, documents=None, unified_enabled=True):
    store = CreditStore(documents)
    for uid, user in (users or {}).items():
        store.documents[('users', uid)] = deepcopy(user)
    runtime = SimpleNamespace(
        db=store.db, firestore=SimpleNamespace(transactional=store.transactional, Increment=Increment),
        users_repo=users_repo, time=SimpleNamespace(time=lambda: store.now),
        logger=logging.getLogger('synthetic-credit-tests'),
        UNIFIED_CREDITS_ENABLED=unified_enabled, ADMIN_UIDS=set(), ADMIN_EMAILS=set(),
        is_admin_user=lambda _token: False, FREE_LECTURE_CREDITS=1, FREE_SLIDES_CREDITS=2,
        FREE_INTERVIEW_CREDITS=0, DEFAULT_OUTPUT_LANGUAGE_KEY='en',
    )
    return runtime, store
