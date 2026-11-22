import threading
from copy import deepcopy

from lecture_processor.domains.books import model


class Store:
    def __init__(self):
        self.data = {}
        self.lock = threading.RLock()

    def get(self, path):
        return deepcopy(self.data.get(path))

    cached = get

    def put(self, path, value):
        self.data[path] = deepcopy(value)

    def delete(self, path):
        self.data.pop(path, None)

    def list(self, path, field=None, value=None, operator='==', limit=200):
        rows = [deepcopy(v) for k, v in self.data.items() if k.startswith(path + '/') and '/' not in k[len(path) + 1:]]
        if field:
            rows = [r for r in rows if (value in r.get(field, []) if operator == 'array_contains' else r.get(field, 0) > value if operator == '>' else r.get(field) == value)]
        return rows[:limit]

    def atomic(self, operation):
        with self.lock:
            before = deepcopy(self.data)
            try:
                return operation(self)
            except Exception:
                self.data = before
                raise


def headers(user='owner', session='tab-one', **extra):
    return {'Authorization': user, 'X-Book-Session': session, **extra}


def pages(n=4):
    return [model.page({'id': 'p' + str(i), 'role': 'front' if i == 0 else 'back' if i == n - 1 else 'page', 'items': []}) for i in range(n)]
