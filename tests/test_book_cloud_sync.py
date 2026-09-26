"""Retry and concurrency coverage for promoting recoverable local books to the cloud."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import io
import threading

import pytest
from PIL import Image

from lecture_processor.domains.books import model
from lecture_processor.services import book_account_service, book_service as service, book_storage


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


@pytest.fixture
def cloud_setup(client, runtime, monkeypatch):
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


def test_create_replay_preserves_newer_content_and_scopes_keys_to_account(cloud_setup):
    client, db, _ = cloud_setup
    first = create(client)
    bid = first.json['book']['id']
    token = lease(client, bid)
    latest = db.get('books/' + bid)
    latest.update(title='The finished story', revision=7)
    db.put('books/' + bid, latest)
    first_page = db.get('books/' + bid + '/pages/p0')
    first_page['title'] = 'A carefully edited cover'
    db.put('books/' + bid + '/pages/p0', first_page)
    repeat = create(client, title='An older draft')
    assert first.status_code == 201 and repeat.status_code == 200
    assert repeat.json['idempotent_replay'] is True
    assert repeat.json['book']['title'] == 'The finished story'
    assert repeat.json['book']['revision'] == 7
    assert db.get('books/' + bid)['lease']['token_hash'] == service.digest(token)
    assert db.get('books/' + bid + '/pages/p0')['title'] == 'A carefully edited cover'
    second_owner = create(client, user='another-account')
    assert second_owner.status_code == 201 and second_owner.json['book']['id'] != bid
    assert len(db.list('books', 'owner_uid', 'owner')) == 1
    assert repeat.json['book']['creation_key'] == 'draft:local-one'
    assert client.get('/api/books', headers=headers()).json['books'][0]['creation_key'] == 'draft:local-one'
    assert 'creation_key' not in service.public_book(db.get('books/' + bid), 'edit')
    assert 'creation_key' not in service.public_book(db.get('books/' + bid), 'view')


def test_concurrent_creation_reuses_one_book_and_enforces_library_limit(cloud_setup, app):
    client, db, _ = cloud_setup
    def same_request(_):
        with app.test_client() as other:
            return create(other)
    with ThreadPoolExecutor(max_workers=2) as pool:
        repeats = list(pool.map(same_request, range(2)))
    assert sorted(result.status_code for result in repeats) == [200, 201]
    bid = repeats[0].json['book']['id']
    assert repeats[1].json['book']['id'] == bid
    assert len(db.list('books/' + bid + '/pages')) == 4
    for index in range(98):
        db.put('books/other-' + str(index), {'id': 'other-' + str(index), 'owner_uid': 'owner'})
    def new_request(index):
        with app.test_client() as other:
            return create(other, key='draft:new-' + str(index)).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(new_request, range(2))) == [201, 400]
    assert len(db.list('books', 'owner_uid', 'owner')) == 100
    assert create(client).status_code == 200  # A lost response remains recoverable at the limit.


@pytest.mark.parametrize('key', ['', 'a' * 121, 'folder/key', 'contains spaces', 12, {'key': 'a'}])
def test_invalid_create_operation_keys_do_not_create_books(cloud_setup, key):
    client, db, _ = cloud_setup
    assert create(client, key=key).status_code == 400
    assert not db.list('books')


def test_asset_replay_is_read_only_private_and_does_not_charge_again(cloud_setup, monkeypatch):
    client, db, storage = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    first = upload(client, bid, token)
    assert first.status_code == 201
    charged = db.get('book_usage/storage')['bytes']
    calls = list(storage.calls)
    latest = db.get('books/' + bid)
    latest['revision'] = 3
    latest['lease'] = None
    db.put('books/' + bid, latest)
    monkeypatch.setattr(book_storage, 'configured', lambda: False)
    repeat = upload(client, bid, token)
    assert repeat.status_code == 200 and repeat.json['idempotent_replay']
    assert repeat.json['asset'] == first.json['asset']
    assert storage.calls == calls
    assert db.get('book_usage/storage')['bytes'] == charged
    assert db.get('books/' + bid)['asset_bytes'] == charged
    assert not any(key.startswith('_') or key.endswith('path') for key in repeat.json['asset'])
    assert upload(client, bid, token, user='stranger').status_code == 403
    assert upload(client, bid, token, key='new-key').status_code == 409


def test_concurrent_image_uploads_share_one_reservation_and_two_private_objects(cloud_setup, app, monkeypatch):
    client, db, storage = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    barrier = threading.Barrier(2)
    def simultaneous(method, path, *args):
        if method == 'POST' and path.endswith('/original'):
            barrier.wait(timeout=5)
        return storage.request(method, path, *args)
    monkeypatch.setattr(book_storage, 'request', simultaneous)
    def attempt(_):
        with app.test_client() as other:
            return upload(other, bid, token)
    with ThreadPoolExecutor(max_workers=2) as pool:
        results = list(pool.map(attempt, range(2)))
    assert all(result.status_code in (200, 201) for result in results)
    assert results[0].json['asset']['id'] == results[1].json['asset']['id']
    assets = db.list('books/' + bid + '/assets')
    assert len(assets) == 1 and assets[0]['ready']
    assert len(storage.data) == 2
    assert db.get('book_usage/storage')['bytes'] == sum(len(blob) for blob in storage.data.values())


def test_partial_upload_and_server_restart_resume_without_duplicate_quota(cloud_setup, monkeypatch):
    client, db, storage = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    state = {'interrupted': True}
    def interrupted(method, path, *args):
        if state['interrupted'] and method == 'POST' and path.endswith('/preview.webp'):
            raise RuntimeError('Worker stopped after uploading the original')
        return storage.request(method, path, *args)
    monkeypatch.setattr(book_storage, 'request', interrupted)
    assert upload(client, bid, token).status_code == 503
    asset = db.list('books/' + bid + '/assets')[0]
    assert not asset['ready']
    assert len(storage.data) == 1
    reserved = db.get('book_usage/storage')['bytes']
    state['interrupted'] = False
    assert upload(client, bid, token, revision=2).status_code == 409
    assert db.get('book_usage/storage')['bytes'] == reserved
    result = upload(client, bid, token)
    assert result.status_code == 201 and result.json['asset']['id'] == asset['id']
    assert len(storage.data) == 2
    assert db.get('book_usage/storage')['bytes'] == reserved == sum(map(len, storage.data.values()))


def test_failed_storage_response_can_be_retried_without_deleting_original(cloud_setup, monkeypatch):
    client, db, storage = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    failed = {'once': True}
    def unavailable(method, path, *args):
        if failed['once'] and method == 'POST' and path.endswith('/preview.webp'):
            raise model.BookError('Offline', 503)
        return storage.request(method, path, *args)
    monkeypatch.setattr(book_storage, 'request', unavailable)
    assert upload(client, bid, token).status_code == 503
    pending = db.list('books/' + bid + '/assets')[0]
    assert pending['failed'] and not pending['ready']
    assert all(method != 'DELETE' for method, _ in storage.calls)
    failed['once'] = False
    assert upload(client, bid, token).status_code == 201
    assert db.get('book_usage/storage')['bytes'] == pending['size']
    assert db.list('books/' + bid + '/assets')[0]['failed'] is False


def test_lost_storage_acknowledgement_verifies_existing_bytes(cloud_setup, monkeypatch):
    client, db, storage = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    def lose_post_response(method, path, *args):
        result = storage.request(method, path, *args)
        if method == 'POST':
            raise model.BookError('Response was lost', 503)
        return result
    monkeypatch.setattr(book_storage, 'request', lose_post_response)
    result = upload(client, bid, token)
    assert result.status_code == 201
    assert len(storage.data) == 2
    assert db.get('book_usage/storage')['bytes'] == sum(map(len, storage.data.values()))
    assert [method for method, _ in storage.calls] == ['POST', 'GET', 'POST', 'GET']


def test_same_image_key_cannot_overwrite_other_bytes_or_bypass_quota(cloud_setup, monkeypatch):
    client, db, storage = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    first = upload(client, bid, token)
    charged = first.json['asset']['size']
    old_bytes = deepcopy(storage.data)
    assert upload(client, bid, token, blob=image_bytes((0, 0, 0, 0))).status_code == 409
    assert storage.data == old_bytes
    monkeypatch.setattr(book_storage, 'BOOK_BYTES', charged)
    assert upload(client, bid, token, key='asset:another-image').status_code == 413
    assert upload(client, bid, token).status_code == 200
    assert db.get('book_usage/storage')['bytes'] == charged
    assert len(db.list('books/' + bid + '/assets')) == 1


def test_takeover_during_upload_keeps_pending_asset_for_the_next_valid_turn(cloud_setup, app, monkeypatch):
    client, db, storage = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    replacement = {}
    def take_over(method, path, *args):
        if method == 'POST' and not replacement:
            with app.test_client() as other:
                replacement['token'] = lease(other, bid, session='tab-two', takeover=True)
        return storage.request(method, path, *args)
    monkeypatch.setattr(book_storage, 'request', take_over)
    assert upload(client, bid, token).status_code == 409
    pending = db.list('books/' + bid + '/assets')[0]
    assert pending['failed'] and not pending['ready']
    assert upload(client, bid, token).status_code == 409
    recovered = upload(client, bid, replacement['token'], session='tab-two')
    assert recovered.status_code == 201 and recovered.json['asset']['ready']
    assert db.get('book_usage/storage')['bytes'] == pending['size']


def test_history_replay_preserves_snapshot_without_requiring_a_new_lease(cloud_setup):
    client, db, _ = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    saved = version(client, bid, token)
    assert saved.status_code == 200 and not saved.json['idempotent_replay']
    snapshot_id = saved.json['version_id']
    book = db.get('books/' + bid)
    book.update(title='A newer book', revision=2, lease=None)
    db.put('books/' + bid, book)
    repeated = version(client, bid, token, name='Do not replace the snapshot')
    assert repeated.status_code == 200 and repeated.json['idempotent_replay']
    snapshots = db.list('books/' + bid + '/versions')
    assert len(snapshots) == 1
    assert snapshots[0]['id'] == snapshot_id and snapshots[0]['name'] == 'Before polishing'
    assert snapshots[0]['metadata']['title'] == 'A local story'
    assert version(client, bid, token, key='new-key').status_code == 409
    assert version(client, bid, token, user='stranger').status_code == 403
    assert client.post('/api/books/' + bid + '/history', headers=headers(), json={'restore': snapshot_id, 'lease_token': token, 'base_revision': 1}).status_code == 409
    other_bid = create(client, key='another-book').json['book']['id']
    other_token = lease(client, other_bid)
    assert version(client, other_bid, other_token).json['version_id'] != snapshot_id


def test_history_count_is_transactional_and_completed_replay_works_at_limit(cloud_setup, app):
    client, db, _ = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    saved = version(client, bid, token)
    for index in range(18):
        db.put('books/' + bid + '/versions/old-' + str(index), {'id': 'old-' + str(index)})
    def attempt(index):
        with app.test_client() as other:
            return version(other, bid, token, key='new-' + str(index)).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(attempt, range(2))) == [200, 400]
    assert len(db.list('books/' + bid + '/versions')) == 20
    repeated = version(client, bid, token)
    assert repeated.status_code == 200 and repeated.json['version_id'] == saved.json['version_id']
    assert repeated.json['idempotent_replay'] is True


def test_account_cleanup_removes_keyed_operations_and_reserved_storage(cloud_setup, runtime):
    client, db, storage = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    assert upload(client, bid, token).status_code == 201
    assert version(client, bid, token).status_code == 200
    assert book_account_service.delete_owned(runtime, 'owner', 'owner@example.com') == 1
    assert not storage.data
    assert db.get('book_usage/storage')['bytes'] == 0
    assert all(not key.startswith('books/') for key in db.data)
    assert set(db.data) == {'book_usage/storage'}


def test_unkeyed_operations_remain_distinct_and_invalid_mutation_keys_are_rejected(cloud_setup):
    client, db, _ = cloud_setup
    first = client.post('/api/books', headers=headers(), json={'pages': pages()})
    second = client.post('/api/books', headers=headers(), json={'pages': pages()})
    assert first.status_code == second.status_code == 201
    assert first.json['book']['id'] != second.json['book']['id']
    bid = first.json['book']['id']
    token = lease(client, bid)
    assert upload(client, bid, token, key='../bad').status_code == 400
    assert version(client, bid, token, key=[]).status_code == 400
    assert not db.list('books/' + bid + '/assets')
    assert not db.list('books/' + bid + '/versions')


def test_account_export_omits_storage_bookkeeping_and_preserves_user_content(cloud_setup, runtime):
    client, db, _ = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    asset = upload(client, bid, token).json['asset']
    changed = db.get('books/' + bid + '/pages/p1')
    changed.update(title='A page worth keeping', _id='internal-page-id')
    changed['items'] = [model.item({'id': 'sketch', 'type': 'image', 'assetId': asset['id'], 'originalAssetId': asset['id']})]
    db.put('books/' + bid + '/pages/p1', changed)
    snapshot = version(client, bid, token).json['version_id']
    snapshot_row = db.get('books/' + bid + '/versions/' + snapshot)
    snapshot_row['_internal_revision'] = 4
    db.put('books/' + bid + '/versions/' + snapshot, snapshot_row)
    book = db.get('books/' + bid)
    book['members'] = {'_reader@example.com': 'view'}
    db.put('books/' + bid, book)
    db.put('books/' + bid + '/comments/comment-one', {'id': 'comment-one', 'text': '_A comment with an underscore_', '_internal_trace': 'private'})
    create(client, user='another-owner')
    exported = book_account_service.collect(runtime, 'owner')
    assert len(exported) == 1
    result = exported[0]
    assert result['members'] == {'_reader@example.com': 'view'}
    assert result['pages'][1]['title'] == 'A page worth keeping'
    assert result['pages'][1]['items'][0]['originalAssetId'] == asset['id']
    assert result['versions'][0]['pages'][1]['items'][0]['assetId'] == asset['id']
    assert result['comments'][0]['text'] == '_A comment with an underscore_'
    assert result['assets'][0]['id'] == asset['id']
    for row in [result, *result['pages'], *result['assets'], *result['versions'], *result['versions'][0]['pages'], *result['comments']]:
        assert not any(key.startswith('_') or key in ('path', 'preview_path', 'lease') for key in row)
    assert db.get('books/' + bid)['_version_count'] == 1
    assert '_content_digest' in db.get('books/' + bid + '/assets/' + asset['id'])
