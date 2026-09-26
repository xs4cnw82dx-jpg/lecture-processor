"""Regression cases for Book Studio recovery, sharing and concurrent operations."""
from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
import io
import json
import threading
import zipfile

import pytest

from lecture_processor.domains.books import model
from tests.test_book_cloud_sync import cloud_setup, create, headers, lease, pages, upload, version


def content(token, logical, revision=1, **extra):
    return {'lease_token': token, 'base_revision': revision, 'metadata': {'title': 'A careful story'},
            'pages': logical, 'page_ids': [p['id'] for p in logical], 'deleted_page_ids': [], **extra}


def share(client, bid, role='edit'):
    link = client.post('/api/books/' + bid + '/sharing', headers=headers(), json={'role': role}).json['url']
    token = link.rsplit('/', 1)[1]
    session = client.post('/api/books/share-session', json={'token': token, 'name': 'Robin'}).json
    return token, {'X-Book-Access': session['access_token'], 'X-Book-Session': 'guest-tab'}


@pytest.mark.parametrize('defect', ['inside-cover', 'split-spread'])
def test_creation_rejects_page_structures_that_cannot_be_saved_again(cloud_setup, defect):
    client, db, _ = cloud_setup
    logical = pages()
    if defect == 'inside-cover':
        logical[1]['role'] = 'front'
    else:
        logical[1]['items'] = [model.item({'id': 'half', 'type': 'image', 'spanId': 'spread', 'spanSide': 'left'})]
    response = create(client, pages=logical)
    assert response.status_code == 400, response.json
    assert not db.list('books')


@pytest.mark.parametrize('defect', ['inside-cover', 'active-and-deleted', 'duplicate-deleted', 'unlisted'])
def test_invalid_version_structure_never_enters_history(cloud_setup, defect):
    client, db, _ = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    logical, order, deleted = pages(), [p['id'] for p in pages()], []
    if defect == 'inside-cover':
        logical[1]['role'] = 'back'
    elif defect == 'active-and-deleted':
        deleted = ['p1']
    elif defect == 'duplicate-deleted':
        logical.append(model.page({'id': 'removed'}))
        deleted = ['removed', 'removed']
    else:
        logical.append(model.page({'id': 'unlisted'}))
    result = version(client, bid, token, pages=logical, page_ids=order, deleted_page_ids=deleted)
    assert result.status_code == 400, result.json
    assert not db.list('books/' + bid + '/versions')


def test_trashed_shared_books_disappear_until_owner_restores_them(cloud_setup):
    client, _, _ = cloud_setup
    bid = create(client).json['book']['id']
    assert client.post('/api/books/' + bid + '/sharing', headers=headers(), json={'members': {'reader@example.com': 'view'}}).status_code == 200
    assert len(client.get('/api/books', headers=headers('reader')).json['books']) == 1
    assert client.patch('/api/books/' + bid, headers=headers(), json={'deleted': True}).status_code == 200
    assert client.get('/api/books', headers=headers('reader')).json['books'] == []
    assert client.get('/api/books', headers=headers()).json['books'][0]['deleted'] is True
    assert client.patch('/api/books/' + bid, headers=headers(), json={'deleted': False}).status_code == 200
    assert client.get('/api/books', headers=headers('reader')).json['books'][0]['id'] == bid


def test_revoking_edit_link_releases_only_that_links_editing_turn(cloud_setup):
    from lecture_processor.services import book_service as service
    client, db, _ = cloud_setup
    bid = create(client).json['book']['id']
    raw, guest = share(client, bid)
    issued = client.post('/api/books/' + bid + '/lease', headers=guest, json={})
    assert issued.status_code == 200
    assert db.get('books/' + bid)['lease']['share_id'] == service.digest(raw)
    result = client.post('/api/books/' + bid + '/sharing', headers=headers(), json={'revoke': service.digest(raw)})
    assert result.status_code == 200
    assert db.get('books/' + bid)['lease'] is None
    assert client.post('/api/books/' + bid + '/lease', headers=headers(), json={}).status_code == 200
    assert client.post('/api/books/' + bid + '/lease', headers=guest, json={'action': 'renew', 'lease_token': issued.json['lease_token']}).status_code == 403
    other, _ = share(client, bid)
    before = deepcopy(db.get('books/' + bid)['lease'])
    client.post('/api/books/' + bid + '/sharing', headers=headers(), json={'revoke': service.digest(other)})
    assert db.get('books/' + bid)['lease'] == before


def test_revocation_between_access_and_lease_commit_cannot_recreate_guest_lease(cloud_setup, monkeypatch):
    from lecture_processor.services import book_service as service
    client, db, _ = cloud_setup
    bid = create(client).json['book']['id']
    raw, guest = share(client, bid)
    atomic = db.atomic
    def revoke_before_commit(operation):
        grant = db.get('book_shares/' + service.digest(raw))
        grant['revoked'] = True
        db.put('book_shares/' + grant['id'], grant)
        return atomic(operation)
    monkeypatch.setattr(db, 'atomic', revoke_before_commit)
    result = client.post('/api/books/' + bid + '/lease', headers=guest, json={})
    assert result.status_code == 403
    assert db.get('books/' + bid)['lease'] is None


def test_last_comment_slot_is_atomic_and_does_not_invalidate_content_lease(cloud_setup, app, monkeypatch):
    client, db, _ = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    root = 'books/' + bid + '/comments'
    for i in range(299):
        db.put(root + '/c' + str(i), {'id': 'c' + str(i), 'created_at': i})
    listing, race = db.list, threading.Barrier(2)
    def concurrent_listing(path, *args, **kwargs):
        rows = listing(path, *args, **kwargs)
        if path == root and not db.active:
            race.wait(timeout=3)
        return rows
    monkeypatch.setattr(db, 'list', concurrent_listing)
    def post(i):
        with app.test_client() as other:
            return other.post('/api/books/' + bid + '/comments', headers=headers(), json={'page_id': 'p1', 'text': 'Comment ' + str(i)}).status_code
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sorted(pool.map(post, (1, 2))) == [200, 400]
    assert len(listing(root, limit=301)) == 300
    assert db.get('books/' + bid)['revision'] == 1
    assert client.put('/api/books/' + bid, headers=headers(), json=content(token, pages())).status_code == 200


def test_new_version_prevents_concurrent_image_deletion(cloud_setup, monkeypatch, app):
    client, db, storage = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    asset = upload(client, bid, token).json['asset']
    atomic = db.atomic
    def save_version_before_removal(operation):
        if operation.__name__ == 'mark_removing':
            logical = pages()
            logical[1]['items'] = [model.item({'id': 'image', 'type': 'image', 'assetId': asset['id']})]
            result = version(app.test_client(), bid, token, pages=logical, page_ids=[p['id'] for p in logical])
            assert result.status_code == 200, result.json
        return atomic(operation)
    monkeypatch.setattr(db, 'atomic', save_version_before_removal)
    response = client.delete('/api/books/' + bid + '/assets/' + asset['id'], headers=headers(), json={'lease_token': token, 'base_revision': 1})
    assert response.status_code == 400, response.json
    assert 'saved version' in response.json['error']
    assert db.get('books/' + bid + '/assets/' + asset['id'])['ready']
    assert not any(method == 'DELETE' for method, _ in storage.calls)


def test_old_orphan_documents_do_not_hide_current_pages_or_enter_backups(cloud_setup):
    client, db, _ = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    root = 'books/' + bid
    current = [(root + '/pages/' + p['id'], db.get(root + '/pages/' + p['id'])) for p in pages()]
    for key, _ in current:
        db.delete(key)
    for i in range(200):
        db.put(root + '/pages/abandoned-' + str(i), dict(model.page({'id': 'abandoned-' + str(i)}), revision=2))
    for key, page in current:
        db.put(key, dict(page, revision=2))
    result = client.get('/api/books/' + bid, headers=headers())
    assert result.status_code == 200
    assert [p['id'] for p in result.json['pages']] == ['p0', 'p1', 'p2', 'p3']
    delta = client.get('/api/books/' + bid + '?since=1', headers=headers()).json
    assert [p['id'] for p in delta['pages']] == ['p0', 'p1', 'p2', 'p3']
    assert version(client, bid, token).status_code == 200
    backup = client.get('/api/books/' + bid + '/backup', headers=headers())
    assert backup.status_code == 200
    with zipfile.ZipFile(io.BytesIO(backup.data)) as archive:
        book = json.loads(archive.read('book.json'))
    assert len(book['pages']) == 4 and len(book['versions'][0]['pages']) == 4


def test_replacing_pages_removes_abandoned_current_documents_but_keeps_saved_versions(cloud_setup):
    client, db, _ = cloud_setup
    bid = create(client).json['book']['id']
    token = lease(client, bid)
    assert version(client, bid, token).status_code == 200
    logical = pages()
    logical[1]['id'], logical[2]['id'] = 'new-p1', 'new-p2'
    result = client.put('/api/books/' + bid, headers=headers(), json=content(token, logical))
    assert result.status_code == 200, result.json
    assert not db.get('books/' + bid + '/pages/p1')
    assert not db.get('books/' + bid + '/pages/p2')
    saved = client.get('/api/books/' + bid + '/history?include_pages=1', headers=headers()).json['versions'][0]
    assert [p['id'] for p in saved['pages']] == ['p0', 'p1', 'p2', 'p3']
