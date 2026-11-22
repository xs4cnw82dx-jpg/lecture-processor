import io
from copy import deepcopy
from types import SimpleNamespace

from PIL import Image

from lecture_processor.domains.books.model import BookError
from lecture_processor.services import study_picture_service as service


class Store:
    def __init__(self):
        self.data = {'users/owner': {'study_pictures_enabled': True}, 'study_packs/pack': {'uid': 'owner'}}
        self.writing = False
        self.metadata_batches = []

    def collection(self, name):
        assert name == 'study_images'
        return SimpleNamespace(document=lambda aid: SimpleNamespace(id=aid, path='study_images/' + aid))

    def get_all(self, refs, field_paths):
        assert field_paths == ['uid', 'pack_id', 'ready', 'deleting']
        self.metadata_batches.append([ref.id for ref in refs])
        return [SimpleNamespace(
            id=ref.id, exists=ref.path in self.data,
            to_dict=lambda root=ref.path: {key: value for key, value in self.data.get(root, {}).items() if key in field_paths},
        ) for ref in reversed(refs)]

    def get(self, path):
        assert not self.writing, 'Firestore reads must precede writes'
        return deepcopy(self.data.get(path))

    def put(self, path, value):
        self.writing = True
        self.data[path] = deepcopy(value)

    def delete(self, path):
        self.writing = True
        self.data.pop(path, None)

    def list(self, root, field=None, value=None, limit=100):
        return [deepcopy(v) for k, v in self.data.items() if k.startswith(root + '/') and (not field or v.get(field) == value)][:limit]

    def atomic(self, operation):
        before = deepcopy(self.data)
        self.writing = False
        try:
            return operation(self)
        except Exception:
            self.data = before
            raise
        finally:
            self.writing = False


def make_study_pictures(monkeypatch):
    db = Store()
    files = {}
    monkeypatch.setattr(service, 'BookStore', lambda _: db)
    monkeypatch.setattr(service, 'enabled', lambda _, uid: db.get('users/' + uid).get('study_pictures_enabled', False))
    monkeypatch.setattr(service.book_storage, 'configured', lambda: True)
    monkeypatch.setattr(service.book_service, 'reserve_transfer', lambda *args: None)

    def storage(method, path, data=None, content_type=None):
        if method == 'POST':
            if path in files:
                raise BookError('Already uploaded', 503)
            files[path] = data
        if method == 'GET':
            if path not in files:
                raise BookError('Not found', 503)
            return files[path]
        if method == 'DELETE':
            files.pop(path, None)
        return b''
    monkeypatch.setattr(service.book_storage, 'request', storage)
    runtime = SimpleNamespace(db=db, sanitize_flashcards=lambda cards, n: [{'front': c['front'].strip(), 'back': c['back'].strip()} for c in cards[:n]])
    output = io.BytesIO()
    Image.new('RGB', (16, 16), 'red').save(output, 'PNG')
    return runtime, db, files, output.getvalue()
