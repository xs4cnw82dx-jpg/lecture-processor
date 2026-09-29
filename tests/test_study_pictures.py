"""Private study pictures: permissions, resumable writes and durable card references."""
import io
from copy import deepcopy
from types import SimpleNamespace

import pytest
from flask import Flask
from PIL import Image

from lecture_processor.domains.books.model import BookError
from lecture_processor.services import study_picture_service as service


class Store:
    def __init__(self):
        self.data = {'users/owner': {'study_pictures_enabled': True}, 'study_packs/pack': {'uid': 'owner'}}
        self.writing = False

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


@pytest.fixture
def setup(monkeypatch):
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


def test_upload_retry_reserves_once_and_preserves_original(setup):
    runtime, db, files, data = setup
    image = service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    reserved = db.data['book_usage/storage']['bytes']
    assert len(files) == 2
    assert service.save_image(runtime, 'owner', 'pack', data, 'muscle.png') == image
    assert db.data['book_usage/storage']['bytes'] == reserved
    assert files[db.data['study_images/' + image['id']]['path']] == data


def test_partial_upload_resumes_with_no_extra_reservation(setup, monkeypatch):
    runtime, db, files, data = setup
    original = service.book_storage.request
    attempts = []
    def fail_preview(method, path, *args):
        if method == 'POST' and path.endswith('preview.webp') and not attempts:
            attempts.append(True)
            raise BookError('Storage unavailable', 503)
        return original(method, path, *args)
    monkeypatch.setattr(service.book_storage, 'request', fail_preview)
    with pytest.raises(BookError):
        service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    reserved = db.data['book_usage/storage']['bytes']
    image = service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    assert db.data['study_images/' + image['id']]['ready']
    assert db.data['book_usage/storage']['bytes'] == reserved
    assert len(files) == 2


@pytest.mark.parametrize('mutation', ['disabled', 'foreign', 'deleting', 'full'])
def test_upload_guards_prevent_storage_writes(setup, monkeypatch, mutation):
    runtime, db, files, data = setup
    if mutation == 'disabled': db.data['users/owner']['study_pictures_enabled'] = False
    if mutation == 'foreign': db.data['study_packs/pack']['uid'] = 'someone-else'
    if mutation == 'deleting': db.data['users/owner']['account_status'] = 'deleting'
    if mutation == 'full': monkeypatch.setattr(service.book_storage, 'GLOBAL_BYTES', 1)
    with pytest.raises(BookError):
        service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    assert not files
    assert 'book_usage/storage' not in db.data


def test_card_edits_preserve_references_and_reject_foreign_pictures(setup):
    runtime, db, _, data = setup
    image = service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    cards = [{'front': ' Edited front ', 'back': 'Edited back', 'image_ids': [image['id'], image['id']]}]
    cleaned = service.sanitize_cards(runtime, 'owner', 'pack', cards)
    assert cleaned == [{'front': 'Edited front', 'back': 'Edited back', 'image_ids': [image['id']]}]
    with pytest.raises(BookError): service.sanitize_cards(runtime, 'owner', 'another-pack', cards)
    db.data['study_images/' + image['id']]['ready'] = False
    with pytest.raises(BookError): service.sanitize_cards(runtime, 'owner', 'pack', cards)
    assert service.sanitize_cards(runtime, 'owner', 'pack', [{'front': 'a', 'back': 'b'}]) == [{'front': 'a', 'back': 'b'}]


def test_private_read_and_account_cleanup(setup, monkeypatch):
    runtime, db, files, data = setup
    image = service.save_image(runtime, 'owner', 'pack', data, 'muscle.png')
    monkeypatch.setattr(service, 'require_access', lambda *args, **kwargs: ('owner', None))
    with Flask(__name__).test_request_context('/?original=1') as context:
        response = service.get_image(runtime, context.request, 'pack', image['id'])
        response.direct_passthrough = False
        assert response.get_data() == data
        assert response.headers['Cache-Control'] == 'private, no-store'
        assert response.headers['X-Content-Type-Options'] == 'nosniff'
        with pytest.raises(BookError): service.get_image(runtime, context.request, 'other', image['id'])
    assert service.delete_owned(runtime, 'owner') == 1
    assert not files
    assert db.data['book_usage/storage']['bytes'] == 0


def test_nonpilot_and_unsigned_requests_are_rejected_before_pack_lookup(setup, monkeypatch):
    runtime, _, _, _ = setup
    monkeypatch.setattr(service.study_api_support, 'require_user', lambda *args: (None, {'error': 'Unauthorized'}, 401))
    assert service.require_access(runtime, None, 'pack')[1][1] == 401
    monkeypatch.setattr(service.study_api_support, 'require_user', lambda *args: ({'uid': 'owner'}, None, 0))
    monkeypatch.setattr(service, 'enabled', lambda *args: False)
    with Flask(__name__).app_context():
        assert service.require_access(runtime, None, 'pack')[1][1] == 403
