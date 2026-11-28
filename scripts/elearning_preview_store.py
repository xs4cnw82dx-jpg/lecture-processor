"""Isolated transactional course storage for HTTP and browser tests."""
from copy import deepcopy
import threading


class MemoryStore:
    def __init__(self):
        self.data = {}
        self.lock = threading.RLock()

    def get(self, path, *, fields=None):
        row = self.data.get(path)
        if row is not None and fields is not None:
            row = {key: row[key] for key in fields if key in row}
        return deepcopy(row)

    cached = get

    def put(self, path, value):
        self.data[path] = deepcopy(value)

    def update_fields(self, path, values, *, remove=()):
        row = self.data[path]
        row.update(deepcopy(values))
        for key in remove:
            row.pop(key, None)

    def delete(self, path):
        self.data.pop(path, None)

    def list(self, collection, field=None, value=None, operator='==', limit=200, fields=None):
        prefix = collection + '/'
        rows = [
            dict(deepcopy(v), _id=k[len(prefix):])
            for k, v in self.data.items()
            if k.startswith(prefix) and '/' not in k[len(prefix):]
        ]
        if field:
            if operator == 'array_contains':
                rows = [r for r in rows if value in (r.get(field) or [])]
            else:
                def field_value(row):
                    selected = row
                    for part in field.split('.'):
                        selected = selected.get(part) if isinstance(selected, dict) else None
                    return selected
                rows = [r for r in rows if field_value(r) == value]
        return rows[:limit]

    stream = list

    def dashboard_sessions(self, expedition_id, start, end, fields, *, generation=None):
        return [{k: r[k] for k in fields if k in r}
                for r in self.list('elearning_responses', 'expedition_id', expedition_id, limit=None)
                if start <= (r.get('started_at') or 0) < end and (not generation or r.get('statisticsScope') == generation)]

    def count(self, collection, filters):
        return sum(all(row.get(field) == value for field, _, value in filters)
                   for row in self.list(collection, limit=None))

    def response_page(self, scope, after, limit):
        rows = sorted(self.list('elearning_responses', *scope, limit=None), key=lambda row: row['_id'])
        return [row for row in rows if row['_id'] > after][:limit]

    def atomic(self, operation):
        with self.lock:
            before = deepcopy(self.data)
            try:
                return operation(self)
            except Exception:
                self.data = before
                raise

