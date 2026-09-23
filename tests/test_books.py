"""Behavioral coverage for private books, editing leases and print output."""
import base64
from copy import deepcopy
import io
import threading
import zipfile
from concurrent.futures import ThreadPoolExecutor

import pytest
from PIL import Image
from lxml import etree

from lecture_processor.domains.books import model
from lecture_processor.domains.books.export import generate
from lecture_processor.services import book_service as service, book_storage


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


@pytest.fixture
def setup(client, monkeypatch, runtime):
    db = Store()
    monkeypatch.setattr(service, 'store', lambda _: db)
    monkeypatch.setattr(service.lifecycle, 'ensure_account_allows_writes', lambda *a, **kw: (True, ''))
    monkeypatch.setattr(runtime.core, 'verify_firebase_token', lambda req: {'uid': req.headers['Authorization'], 'email': req.headers['Authorization'] + '@example.com', 'email_verified': True}, raising=False)
    return client, db


def headers(user='owner', session='tab-one', **extra):
    return {'Authorization': user, 'X-Book-Session': session, **extra}


def pages(n=4):
    return [model.page({'id': 'p' + str(i), 'role': 'front' if i == 0 else 'back' if i == n - 1 else 'page', 'items': []}) for i in range(n)]


def create(client):
    result = client.post('/api/books', json={'title': 'A story', 'pages': pages()}, headers=headers())
    assert result.status_code == 201, result.json
    return result.json['book']['id']


def lease(client, bid, user='owner', session='tab-one', **body):
    return client.post('/api/books/' + bid + '/lease', headers=headers(user, session), json={'action': 'acquire', **body})


def save(client, bid, token, revision=1, user='owner', session='tab-one', **extra):
    data = {'pages': pages(), 'page_ids': ['p0', 'p1', 'p2', 'p3'], 'metadata': {'title': 'A new story'}, 'base_revision': revision, 'lease_token': token, **extra}
    return client.put('/api/books/' + bid, json=data, headers=headers(user, session))


def test_private_books_require_access_and_owners_control_sharing(setup):
    client, _ = setup
    bid = create(client)
    assert client.get('/api/books/' + bid).status_code == 403
    assert client.get('/api/books/' + bid, headers=headers('stranger')).status_code == 403
    assert client.post('/api/books/' + bid + '/sharing', headers=headers('stranger'), json={'role': 'edit'}).status_code == 403
    assert client.get('/api/books', headers=headers()).json['books'][0]['title'] == 'A story'


def test_leases_are_tab_scoped_expire_and_takeover_invalidates_immediately(setup, monkeypatch):
    client, db = setup
    clock = [1000.0]
    monkeypatch.setattr(service, 'now', lambda: clock[0])
    bid = create(client)
    token = lease(client, bid).json['lease_token']
    assert lease(client, bid, session='tab-two').status_code == 409
    assert save(client, bid, token, session='tab-two').status_code == 409
    assert save(client, bid, token).status_code == 200
    assert save(client, bid, token).status_code == 409
    fresh = lease(client, bid, session='tab-two', takeover=True).json['lease_token']
    assert save(client, bid, token, revision=2).status_code == 409
    assert save(client, bid, fresh, revision=2, session='tab-two').status_code == 200
    clock[0] += 61
    assert lease(client, bid, session='tab-two', action='renew', lease_token=fresh).status_code == 409
    assert save(client, bid, fresh, revision=3, session='tab-two').status_code == 409
    assert db.get('books/' + bid)['revision'] == 3


def test_simultaneous_lease_acquisition_has_one_winner(setup, app):
    client, _ = setup
    bid = create(client)
    def attempt(i):
        with app.test_client() as other:
            return lease(other, bid, session='tab-' + str(i)).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, (2, 3)))
    assert sorted(results) == [200, 409]


def test_guest_edit_link_revocation_blocks_assets_comments_and_writes(setup):
    client, db = setup
    bid = create(client)
    link = client.post('/api/books/' + bid + '/sharing', headers=headers(), json={'role': 'edit'}).json['url']
    raw_token = link.rsplit('/', 1)[1]
    assert raw_token not in str(db.data)
    session = client.post('/api/books/share-session', json={'token': raw_token, 'name': 'Moon Fox'}).json
    h = {'X-Book-Access': session['access_token'], 'X-Book-Session': 'guest-tab'}
    token = client.post('/api/books/' + bid + '/lease', headers=h, json={}).json['lease_token']
    assert client.get('/api/books/' + bid, headers=h).json['book']['role'] == 'edit'
    assert client.post('/api/books/' + bid + '/comments', headers=h, json={'page_id': 'p1', 'text': 'Lovely'}).status_code == 200
    assert client.patch('/api/books/' + bid, headers=h, json={'deleted': True}).status_code == 403
    client.post('/api/books/' + bid + '/sharing', headers=headers(), json={'revoke': service.digest(raw_token)})
    for suffix in ('', '/comments', '/assets/image1', '/backup'):
        assert client.get('/api/books/' + bid + suffix, headers=h).status_code == 403
    assert client.put('/api/books/' + bid, headers=h, json={'lease_token': token}).status_code == 403


def test_viewers_comment_without_lease_but_cannot_edit_or_export(setup):
    client, _ = setup
    bid = create(client)
    client.post('/api/books/' + bid + '/sharing', headers=headers(), json={'members': {'reader@example.com': 'view'}})
    assert lease(client, bid, user='reader').status_code == 403
    assert client.post('/api/books/' + bid + '/comments', headers=headers('reader'), json={'page_id': 'p2', 'text': 'Nice!'}).status_code == 200
    assert client.post('/api/books/export', headers=headers('reader'), json={'book_id': bid, 'revision': 2}).status_code == 403
    assert client.get('/api/books', headers=headers('reader')).json['books'][0]['role'] == 'view'


def test_changed_pages_history_and_deleted_pages_remain_recoverable(setup):
    client, _ = setup
    bid = create(client)
    token = lease(client, bid).json['lease_token']
    changed = pages()[1]
    changed['title'] = 'The forest'
    assert save(client, bid, token, pages=[changed]).status_code == 200
    delta = client.get('/api/books/' + bid + '?since=1', headers=headers()).json
    assert [p['id'] for p in delta['pages']] == ['p1']
    history = client.post('/api/books/' + bid + '/history', headers=headers(), json={'lease_token': token, 'base_revision': 2, 'name': 'Before the moon'})
    assert history.status_code == 200
    versions = client.get('/api/books/' + bid + '/history', headers=headers()).json['versions']
    restored = client.post('/api/books/' + bid + '/history', headers=headers(), json={'lease_token': token, 'base_revision': 2, 'restore': versions[0]['id']}).json
    assert next(p for p in restored['pages'] if p['id'] == 'p1')['title'] == 'The forest'


def image_bytes():
    out = io.BytesIO()
    Image.new('RGBA', (40, 30), (10, 20, 30, 0)).save(out, 'PNG')
    return out.getvalue()


def test_upload_validation_quota_and_interrupted_reservation_cleanup(setup, monkeypatch):
    client, db = setup
    monkeypatch.setattr(book_storage, 'configured', lambda: True)
    bid = create(client)
    token = lease(client, bid).json['lease_token']
    def upload(blob):
        return client.post('/api/books/' + bid + '/assets', headers=headers(), data={'image': (io.BytesIO(blob), 'sketch.png'), 'base_revision': '1', 'lease_token': token})
    assert upload(b'not an image').status_code == 400
    def fail(method, *a):
        if method == 'POST': raise model.BookError('Network failed', 503)
        return b''
    monkeypatch.setattr(book_storage, 'request', fail)
    assert upload(image_bytes()).status_code == 503
    assert db.get('book_usage/storage')['bytes'] == 0
    monkeypatch.setattr(book_storage, 'request', lambda *a: b'')
    monkeypatch.setattr(book_storage, 'GLOBAL_BYTES', 1)
    assert upload(image_bytes()).status_code == 413
    monkeypatch.setattr(book_storage, 'GLOBAL_BYTES', 750 * 1024 * 1024)
    response = upload(image_bytes())
    assert response.status_code == 201
    assert response.json['asset']['width'] == 40
    assert db.get('book_usage/storage')['bytes'] > 0
    assert client.get('/api/books/' + bid + '/assets/' + response.json['asset']['id']).status_code == 403


@pytest.mark.parametrize('n', [4, 8, 12])
def test_fold_imposition_outer_and_inner_sheets(n):
    pairs = model.sheets(pages(n), 'fold')
    assert pairs[0] == (n - 1, 0)
    assert pairs[1] == (1, n - 2)
    assert sorted(p for pair in pairs for p in pair) == list(range(n))
    assert len(pairs) == n // 2


def test_odd_pages_pad_before_back_cover_and_cut_covers_are_alone():
    pairs = model.sheets(pages(5), 'fold')
    assert pairs[0] == (4, 0)
    assert sum(p is None for pair in pairs for p in pair) == 3
    assert model.sheets(pages(5), 'cut') == [(None, 0), (1, 2), (3, None), (4, None)]


@pytest.mark.parametrize('bad', [{'pages': {}}, {'pages': [{'id': 'a', 'items': 'bad'}]}, {'pages': pages(), 'tags': {} }])
def test_malformed_documents_are_useful_errors(setup, bad):
    client, _ = setup
    assert client.post('/api/books', headers=headers(), json=bad).status_code == 400


def test_export_exact_a4_dimensions_and_native_editable_text():
    logical = pages()
    logical[0]['items'] = [model.item({'id': 'title', 'type': 'text', 'text': 'The Fox and the Moon', 'style': {'font': 'Andika', 'weight': 700}})]
    previews = ['data:image/png;base64,' + base64.b64encode(image_bytes()).decode()] * 4
    for appearance in ('faithful', 'editable'):
        blob, _, extension = generate({'pages': logical, 'previews': previews, 'format': appearance, 'arrangement': 'cut'})
        assert extension == 'docx'
        with zipfile.ZipFile(io.BytesIO(blob)) as archive:
            root = etree.fromstring(archive.read('word/document.xml'))
            ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'wp': 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing'}
            size = root.find('.//w:pgSz', ns)
            assert size.get('{%s}w' % ns['w']) == '16838'
            assert size.get('{%s}h' % ns['w']) == '11906'
            assert len(root.findall('.//wp:anchor', ns)) == 4
            assert bool(root.findall('.//w:txbxContent', ns)) == (appearance == 'editable')
            if appearance == 'editable': assert 'The Fox and the Moon' in ''.join(root.itertext())
    pdf, mime, extension = generate({'pages': logical, 'previews': previews, 'format': 'pdf', 'arrangement': 'fold'})
    assert mime == 'application/pdf' and extension == 'pdf' and pdf.startswith(b'%PDF')


def test_linked_illustrations_cannot_be_separated():
    logical = pages()
    for index, side in [(1, 'left'), (2, 'right')]:
        logical[index]['items'] = [model.item({'id': 'image-' + side, 'type': 'image', 'spanId': 'linked', 'spanSide': side})]
    model.validate_spans(logical)
    with pytest.raises(model.BookError):
        model.validate_spans([logical[0], logical[2], logical[1], logical[3]])


def test_firestore_nested_array_round_trip():
    from lecture_processor.repositories.books_repo import encode, decode
    original = {'items': [{'points': [[1, 2, .5], [2, 3, 1]], 'cells': [['a', 'b'], ['c', 'd']]}]}
    encoded = encode(original)
    def validate(value):
        if isinstance(value, list):
            assert all(not isinstance(v, list) for v in value)
            for child in value: validate(child)
        if isinstance(value, dict):
            for child in value.values(): validate(child)
    validate(encoded)
    assert decode(encoded) == original


def test_account_deletion_removes_owned_assets_shares_and_membership_only(monkeypatch):
    from lecture_processor.services import book_account_service as account
    from types import SimpleNamespace
    db = Store()
    monkeypatch.setattr(account, 'BookStore', lambda _: db)
    monkeypatch.setattr(book_storage, 'request', lambda *args: b'')
    db.put('books/owned', {'id': 'owned', 'owner_uid': 'u', 'asset_bytes': 10})
    db.put('books/owned/assets/a', {'id': 'a', 'path': 'original', 'preview_path': 'preview', 'size': 10})
    db.put('books/owned/pages/p', {'id': 'p'})
    db.put('books/owned/comments/c', {'id': 'c'})
    db.put('book_shares/s', {'id': 's', 'book_id': 'owned'})
    db.put('book_usage/storage', {'bytes': 10})
    db.put('books/other', {'id': 'other', 'owner_uid': 'v', 'members': {'u@example.com': 'edit'}, 'member_emails': ['u@example.com'], 'revision': 1})
    db.put('book_comments/c2', {'id': 'c2', 'book_id': 'other', 'uid': 'u'})
    db.put('books/other/comments/c2', {'id': 'c2', 'author_id': 'u'})
    assert account.delete_owned(SimpleNamespace(db=db), 'u', 'u@example.com') == 1
    assert not db.get('books/owned') and not db.get('book_shares/s')
    assert db.get('books/other')['owner_uid'] == 'v'
    assert db.get('books/other')['members'] == {}
    assert db.get('book_usage/storage')['bytes'] == 0
    assert not db.get('books/other/comments/c2')


def test_imported_named_versions_round_trip_without_losing_page_order(setup):
    client, _ = setup
    bid = create(client)
    token = lease(client, bid).json['lease_token']
    snapshot = pages()
    snapshot[1]['title'] = 'An earlier idea'
    result = client.post('/api/books/' + bid + '/history', headers=headers(), json={'pages': snapshot, 'page_ids': [p['id'] for p in snapshot], 'metadata': {'title': 'Earlier book'}, 'name': 'Local draft', 'lease_token': token, 'base_revision': 1})
    assert result.status_code == 200
    versions = client.get('/api/books/' + bid + '/history?include_pages=1', headers=headers()).json['versions']
    assert versions[0]['pages'][1]['title'] == 'An earlier idea'
    assert client.get('/api/books/' + bid + '?cover=1', headers=headers()).json['pages'][0]['role'] == 'front'
    assert len(client.get('/api/books/' + bid + '?cover=1', headers=headers()).json['pages']) == 1
