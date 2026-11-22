from copy import deepcopy
from functools import wraps
from types import SimpleNamespace

from lecture_processor.services import study_progress_service as service


class Snapshot:
    def __init__(self, ref, data):
        self.reference = ref
        self.id = ref.path.rsplit('/', 1)[-1]
        self.exists = data is not None
        self.data = deepcopy(data)

    def to_dict(self):
        return deepcopy(self.data)


def merge_fields(previous, update):
    result = deepcopy(previous)
    for key, value in update.items():
        result[key] = merge_fields(result.get(key, {}), value) if isinstance(value, dict) and value else deepcopy(value)
    return result


class Ref:
    def __init__(self, db, path):
        self.db, self.path = db, path
        self._document_path = path

    def get(self, transaction=None, field_paths=None):
        if transaction is not None:
            assert not transaction.operations, 'Firestore reads must precede writes'
        data = self.db.data.get(self.path)
        if data is not None and field_paths:
            data = {key: data[key] for key in field_paths if key in data}
        return Snapshot(self, data)

    def set(self, data, merge=False):
        previous = self.db.data.get(self.path, {})
        if merge is True:
            data = merge_fields(previous, data)
        elif merge:
            data = {**deepcopy(previous), **{key: deepcopy(data[key]) for key in merge}}
        self.db.data[self.path] = deepcopy(data)
        self.db.revision += 1

    def delete(self):
        self.db.data.pop(self.path, None)
        self.db.revision += 1


class Query:
    def __init__(self, db, root):
        self.db, self.root, self.filters, self.cap = db, root, [], None

    def document(self, doc_id):
        return Ref(self.db, self.root + '/' + doc_id)

    def where(self, *, filter):
        self.filters.append((filter.field_path, filter.value))
        return self

    def limit(self, limit):
        self.cap = limit
        return self

    def stream(self, transaction=None):
        if transaction is not None:
            assert not transaction.operations
        self.db.scans += 1
        refs = [Ref(self.db, key) for key, value in self.db.data.items()
                if key.startswith(self.root + '/') and all(value.get(field) == expected for field, expected in self.filters)]
        return [ref.get(transaction=transaction) for ref in refs[:self.cap]]


class Transaction:
    def __init__(self, db):
        self.db, self.operations = db, []

    def set(self, ref, payload, merge=False):
        self.operations.append(('set', ref, deepcopy(payload), merge))

    def delete(self, ref):
        self.operations.append(('delete', ref))


class Database:
    def __init__(self):
        self.data = {}
        self.revision = 0
        self.scans = 0
        self.before_commit = None
        self.fail_commit = False
        self.retries = 0
        self.get_all_calls = []

    def collection(self, name):
        return Query(self, name)

    def document(self, path):
        return Ref(self, path)

    def get_all(self, refs, **kwargs):
        self.get_all_calls.append(len(refs))
        return [ref.get(**kwargs) for ref in reversed(refs)]

    def transaction(self):
        return Transaction(self)

    def transactional(self, function):
        @wraps(function)
        def execute(transaction):
            for _attempt in range(3):
                revision = self.revision
                transaction.operations = []
                result = function(transaction)
                hook, self.before_commit = self.before_commit, None
                if hook:
                    hook()
                if self.revision != revision:
                    self.retries += 1
                    continue
                if self.fail_commit:
                    raise RuntimeError('simulated commit failure')
                for operation in transaction.operations:
                    if operation[0] == 'set':
                        operation[1].set(operation[2], merge=operation[3])
                    else:
                        operation[1].delete()
                return result
            raise RuntimeError('too many transaction conflicts')
        return execute


def update(runtime, body):
    return service.update_study_progress(runtime, SimpleNamespace(get_json=lambda **_: body))
