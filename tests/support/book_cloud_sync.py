import io
import threading
from copy import deepcopy

from PIL import Image

from lecture_processor.domains.books import model
from lecture_processor.services import book_account_service, book_storage
from lecture_processor.services import book_service as service


class TransactionStore:
    """A serialized transactional store that also rejects reads after writes."""
    def __init__(self):
        self.data = {}
        self.lock = threading.RLock()
        self.active = False
        self.written = False

    def get(self, path):
        with self.lock:
            assert not (self.active and self.written), 'Firestore reads must precede writes'
            return deepcopy(self.data.get(path))

    cached = get

    def put(self, path, value):
        with self.lock:
            self.written = self.active
            self.data[path] = deepcopy(value)

    def delete(self, path):
        with self.lock:
            self.written = self.active
            self.data.pop(path, None)

    def list(self, path, field=None, value=None, operator='==', limit=200):
        with self.lock:
            assert not (self.active and self.written), 'Firestore reads must precede writes'
            rows = [deepcopy(row) for key, row in self.data.items() if key.startswith(path + '/') and '/' not in key[len(path) + 1:]]
            if field:
                rows = [row for row in rows if (value in row.get(field, []) if operator == 'array_contains' else row.get(field, 0) > value if operator == '>' else row.get(field) == value)]
            return rows[:limit]

    def atomic(self, operation):
        with self.lock:
            before = deepcopy(self.data)
            self.active, self.written = True, False
            try:
                return operation(self)
            except Exception:
                self.data = before
                raise
            finally:
                self.active, self.written = False, False


class PrivateStorage:
    def __init__(self):
        self.data = {}
        self.calls = []
        self.lock = threading.RLock()

    def request(self, method, path, data=None, _mime=None):
        with self.lock:
            self.calls.append((method, path))
            if method == 'POST':
                if path in self.data:
                    raise model.BookError('Object already exists', 503)
                self.data[path] = data
                return b''
            if method == 'DELETE':
                self.data.pop(path, None)
                return b''
            if path not in self.data:
                raise model.BookError('Not uploaded yet', 503)
            return self.data[path]


def make_cloud_setup(client, runtime, monkeypatch):
    db, storage = TransactionStore(), PrivateStorage()
    monkeypatch.setattr(service, 'store', lambda _: db)
    monkeypatch.setattr(book_account_service, 'BookStore', lambda _: db)
    monkeypatch.setattr(service.lifecycle, 'ensure_account_allows_writes', lambda *a, **kw: (True, ''))
    monkeypatch.setattr(runtime.core, 'verify_firebase_token', lambda req: {'uid': req.headers['Authorization'], 'email': req.headers['Authorization'] + '@example.com', 'email_verified': True}, raising=False)
    monkeypatch.setattr(book_storage, 'configured', lambda: True)
    monkeypatch.setattr(book_storage, 'request', storage.request)
    return client, db, storage


def headers(user='owner', session='tab-one'):
    return {'Authorization': user, 'X-Book-Session': session}


def pages():
    return [model.page({'id': 'p' + str(index), 'role': 'front' if index == 0 else 'back' if index == 3 else 'page', 'items': []}) for index in range(4)]


def create(client, key='draft:local-one', user='owner', **extra):
    return client.post('/api/books', headers=headers(user), json={'title': 'A local story', 'pages': pages(), 'idempotency_key': key, **extra})


def lease(client, bid, session='tab-one', **extra):
    return client.post('/api/books/' + bid + '/lease', headers=headers(session=session), json={'action': 'acquire', **extra}).json['lease_token']


def image_bytes(color=(100, 80, 30, 255)):
    output = io.BytesIO()
    Image.new('RGBA', (40, 30), color).save(output, 'PNG')
    return output.getvalue()


def upload(client, bid, token, key='asset:local-one:image-one', revision=1, user='owner', session='tab-one', blob=None):
    return client.post('/api/books/' + bid + '/assets', headers=headers(user, session), data={'image': (io.BytesIO(blob or image_bytes()), 'sketch.png'), 'lease_token': token, 'base_revision': str(revision), 'idempotency_key': key})


def version(client, bid, token, key='version:local-one:snapshot-one', revision=1, user='owner', **extra):
    return client.post('/api/books/' + bid + '/history', headers=headers(user), json={'idempotency_key': key, 'lease_token': token, 'base_revision': revision, 'name': 'Before polishing', **extra})
