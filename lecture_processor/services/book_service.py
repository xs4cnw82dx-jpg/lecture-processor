"""Permission-checked book APIs with revisioned saves and exclusive editor leases."""
from __future__ import annotations

import hashlib
import io
import json
import re
import secrets
import time
import zipfile
from datetime import datetime, timezone

from flask import current_app, jsonify, request, send_file
from itsdangerous import BadSignature, URLSafeTimedSerializer

from lecture_processor.domains.books import model
from lecture_processor.domains.account import lifecycle
from lecture_processor.repositories.books_repo import BookStore
from lecture_processor.services import access_service, book_storage


LEASE_SECONDS = 60


def now():
    return time.time()


def digest(value):
    return hashlib.sha256(str(value).encode()).hexdigest()


def idempotency_key(raw):
    """Accept bounded client operation IDs; these identifiers grant no access."""
    if raw is None:
        return ''
    if not isinstance(raw, str) or not re.fullmatch(r'[a-zA-Z0-9_.:-]{1,120}', raw):
        raise model.BookError('This save could not be identified. Reload your book and try again.')
    return raw


def operation_id(scope, operation, key):
    return operation + '-' + digest(json.dumps([scope, operation, key], separators=(',', ':')))


def public_asset(asset):
    return {key: value for key, value in asset.items() if key not in ('path', 'preview_path') and not key.startswith('_')}


def store(runtime):
    return BookStore(runtime.db)


def path(book_id):
    return 'books/' + model.identifier(book_id)


def payload():
    value = request.get_json(silent=True)
    if not isinstance(value, dict):
        raise model.BookError('Please try that action again.')
    return value


def signed_session():
    return URLSafeTimedSerializer(current_app.secret_key, salt='book-share-v1')


def identity(runtime, required=False):
    user = None
    if request.headers.get('Authorization'):
        user, error, status = access_service.require_authenticated_user(runtime, request)
        if error is not None:
            raise model.BookError('Please sign in again to continue.', status)
    if required and not user:
        raise model.BookError('Sign in to save and share your book.', 401)
    if user:
        allowed, message = lifecycle.ensure_account_allows_writes(user['uid'], runtime=runtime)
        if not allowed:
            raise model.BookError(message, 409)
    return user


def access(runtime, book_id, required='view', cached=False):
    db = store(runtime)
    book = db.cached(path(book_id)) if cached else db.get(path(book_id))
    if not book:
        raise model.BookError('This book is unavailable.', 404)
    user = identity(runtime)
    uid = user['uid'] if user else ''
    email = str((user or {}).get('email', '')).lower()
    role = 'owner' if uid and book['owner_uid'] == uid else (book.get('members', {}).get(email, '') if email else '')
    who = {'id': uid, 'name': model.text((user or {}).get('name') or email.split('@')[0], 60)}
    share_key = request.headers.get('X-Book-Access', '')
    if share_key:
        try:
            claims = signed_session().loads(share_key, max_age=86400 * 7)
            grant = db.get('book_shares/' + model.identifier(claims['share']))
        except (BadSignature, KeyError, ValueError):
            grant = None
        if grant and grant['book_id'] == book_id and not grant.get('revoked') and (not grant.get('expires_at') or grant['expires_at'] > now()) and (not grant.get('require_signin') or user):
            if role != 'owner' and (not role or grant['role'] == 'edit'):
                role = grant['role']
            if not uid:
                who = {'id': claims['guest'], 'name': model.text(claims['name'], 60)}
    if not role or (book.get('deleted') and role != 'owner'):
        raise model.BookError('You do not have access to this book.', 403)
    if required == 'owner' and role != 'owner':
        raise model.BookError('Only the owner can change this setting.', 403)
    if required == 'edit' and role not in ('owner', 'edit'):
        raise model.BookError('This link allows viewing. Ask the owner for editing access.', 403)
    if book.get('deleted') and request.method not in ('GET', 'PATCH'):
        raise model.BookError('Restore this book before editing it.', 409)
    return db, book, role, who


def public_book(book, role):
    result = {key: value for key, value in book.items() if key not in ('lease', 'members', 'member_emails') and not key.startswith('_')}
    lease = book.get('lease') or {}
    result['editor'] = {'name': lease.get('name', ''), 'expires_at': lease.get('expires_at', 0)} if lease.get('expires_at', 0) > now() else None
    result['role'] = role
    if role == 'owner' and book.get('_creation_key'):
        # Correlate a pending device draft after a successful create response was
        # lost. Shared users do not need the owner's device operation identifier.
        result['creation_key'] = book['_creation_key']
    return result


def assert_lease(book, who, body):
    if not book or book.get('deleted'):
        raise model.BookError('This book is unavailable. Your draft stays on this device.', 409)
    lease = book.get('lease') or {}
    if lease.get('expires_at', 0) <= now() or lease.get('user_id') != who['id'] or not secrets.compare_digest(lease.get('token_hash', ''), digest(body.get('lease_token', ''))) or lease.get('session') != request.headers.get('X-Book-Session'):
        raise model.BookError('Your editing turn has ended. Your changes are kept on this device.', 409)
    if body.get('base_revision') != book['revision']:
        raise model.BookError('A newer version is available. Your changes have been kept for recovery.', 409)


def list_books(runtime):
    user = identity(runtime, True)
    db = store(runtime)
    owned = db.list('books', 'owner_uid', user['uid'])
    shared = db.list('books', 'member_emails', str(user.get('email', '')).lower(), 'array_contains')
    books = {b['id']: public_book(b, 'owner' if b['owner_uid'] == user['uid'] else b['members'].get(str(user.get('email', '')).lower(), 'view')) for b in owned + shared}
    return jsonify(books=list(books.values()), storage_available=book_storage.configured())


def create_book(runtime):
    user = identity(runtime, True)
    raw = payload()
    key = idempotency_key(raw.get('idempotency_key'))
    pages = [model.page(p) for p in model.array(raw.get('pages'), 100, 'page list')]
    order = model.validate_order([p['id'] for p in pages])
    if pages[0]['role'] != 'front' or pages[-1]['role'] != 'back':
        raise model.BookError('Add a front and back cover before saving.')
    if any(obj['assetId'] or obj['originalAssetId'] for p in pages for obj in p['items']):
        raise model.BookError('Upload this book’s images before attaching them.')
    book_id = operation_id(user['uid'], 'book', key) if key else model.new_id()
    book = dict(model.metadata(raw), id=book_id, schema_version=1, owner_uid=user['uid'], page_ids=order,
                deleted_page_ids=[], revision=1, created_at=now(), updated_at=now(), members={}, member_emails=[],
                deleted=False, asset_bytes=0, lease=None)
    if key:
        book['_creation_key'] = key
    db = store(runtime)

    def create(tx):
        existing = tx.get(path(book_id))
        if existing:
            if existing['owner_uid'] != user['uid']:
                raise model.BookError('This book is unavailable.', 403)
            if existing.get('deleted'):
                raise model.BookError('This book is in the trash. Restore it before saving again.', 409)
            return existing, True
        # The library query belongs to the same transaction as creation, so a
        # concurrent retry cannot create another book or evade the library limit.
        if len(tx.list('books', 'owner_uid', user['uid'], limit=100)) >= 100:
            raise model.BookError('Your library has reached 100 books. Download a backup before starting another library.')
        tx.put(path(book_id), book)
        for page in pages:
            tx.put(path(book_id) + '/pages/' + page['id'], dict(page, revision=1))
        return book, False
    saved, replay = db.atomic(create)
    return jsonify(book=public_book(saved, 'owner'), idempotent_replay=replay), 200 if replay else 201


def get_book(runtime, book_id):
    db, book, role, _ = access(runtime, book_id)
    since = request.args.get('since', type=int) or 0
    cover = request.args.get('cover') == '1'
    pages = [db.get(path(book_id) + '/pages/' + book['page_ids'][0])] if cover else (db.list(path(book_id) + '/pages', 'revision', since, '>', limit=200) if since else db.list(path(book_id) + '/pages', limit=200))
    assets = db.list(path(book_id) + '/assets', limit=400)
    if cover:
        used = {obj['assetId'] for obj in pages[0]['items'] if obj['assetId']}
        assets = [a for a in assets if a['id'] in used]
    return jsonify(book=public_book(book, role), pages=pages, assets=[public_asset(a) for a in assets if a.get('ready') or a.get('failed')])


def revision(runtime, book_id):
    _, book, role, _ = access(runtime, book_id, cached=True)
    return jsonify(book=public_book(book, role))


def lease(runtime, book_id):
    db, _, role, who = access(runtime, book_id, 'edit')
    body = payload()
    action = body.get('action', 'acquire')
    session = model.identifier(request.headers.get('X-Book-Session'))
    token = secrets.token_urlsafe(32)

    def update(tx):
        current = tx.get(path(book_id))
        active = current.get('lease') or {}
        same = active.get('session') == session and active.get('user_id') == who['id'] and secrets.compare_digest(active.get('token_hash', ''), digest(body.get('lease_token', '')))
        if action in ('renew', 'release') and (not same or (action == 'renew' and active.get('expires_at', 0) <= now())):
            raise model.BookError('Your editing turn has ended. Your draft is safe on this device.', 409)
        if action == 'acquire' and active.get('expires_at', 0) > now() and not same:
            if not (body.get('takeover') and role == 'owner'):
                raise model.BookError((active.get('name') or 'Someone else') + ' is editing this book. You can take a turn when they finish.', 409)
        if action not in ('acquire', 'renew', 'release'):
            raise model.BookError('Unknown editing action.')
        next_token = body.get('lease_token') if action == 'renew' else token
        current['lease'] = None if action == 'release' else {'user_id': who['id'], 'name': who['name'] or 'Guest', 'session': session, 'token_hash': digest(next_token), 'expires_at': now() + LEASE_SECONDS}
        tx.put(path(book_id), current)
        return next_token
    issued = db.atomic(update)
    return jsonify(lease_token=issued if action != 'release' else '', expires_at=now() + LEASE_SECONDS)


def save_book(runtime, book_id):
    db, _, _, who = access(runtime, book_id, 'edit')
    body = payload()
    changed = [model.page(p) for p in model.array(body.get('pages'), 200, 'changed-page list')]
    if len({p['id'] for p in changed}) != len(changed):
        raise model.BookError('Each changed page must be sent once.')
    order = model.validate_order(body.get('page_ids'))
    deleted = [model.identifier(pid) for pid in model.array(body.get('deleted_page_ids'), 100, 'deleted-page list')]
    meta = model.metadata(body.get('metadata'))
    if set(order) & set(deleted):
        raise model.BookError('A page cannot be both active and deleted.')
    assets = {a['id'] for a in db.list(path(book_id) + '/assets', limit=400) if a.get('ready')}
    for p in changed:
        if p['id'] not in order + deleted:
            raise model.BookError('A changed page is missing from the book.')
        if any(aid and aid not in assets for o in p['items'] for aid in (o['assetId'], o['originalAssetId'])):
            raise model.BookError('Wait for image uploads to finish before saving.')

    def update(tx):
        book = tx.get(path(book_id))
        assert_lease(book, who, body)
        known = set(book['page_ids'] + book.get('deleted_page_ids', []) + [p['id'] for p in changed])
        if not set(order + deleted) <= known:
            raise model.BookError('One of the pages is missing. Reload your saved book.')
        # Reads precede all transaction writes; covers and linked spreads remain structural.
        by_id = {p['id']: p for p in changed}
        ordered = [by_id.get(pid) or tx.get(path(book_id) + '/pages/' + pid) for pid in order]
        if ordered[0]['role'] != 'front' or ordered[-1]['role'] != 'back' or any(p['role'] != 'page' for p in ordered[1:-1]):
            raise model.BookError('Keep the front cover first and the back cover last.')
        model.validate_spans(ordered)
        book.update(meta, page_ids=order, deleted_page_ids=deleted, revision=book['revision'] + 1, updated_at=now())
        tx.put(path(book_id), book)
        for p in changed:
            tx.put(path(book_id) + '/pages/' + p['id'], dict(p, revision=book['revision']))
        return book['revision']
    return jsonify(revision=db.atomic(update))


def update_library(runtime, book_id):
    db, _, _, _ = access(runtime, book_id, 'owner')
    body = payload()

    def update(tx):
        book = tx.get(path(book_id))
        for key in ('title', 'folder', 'tags', 'favorite'):
            if key in body:
                book[key] = model.metadata({**book, **body})[key]
        if 'deleted' in body:
            book['deleted'] = bool(body['deleted'])
            book['lease'] = None
        book['revision'] += 1
        book['updated_at'] = now()
        tx.put(path(book_id), book)
    db.atomic(update)
    return jsonify(ok=True)


def sharing(runtime, book_id):
    db, book, _, _ = access(runtime, book_id, 'owner')
    if request.method == 'GET':
        return jsonify(members=book.get('members', {}), links=[{k: v for k, v in s.items() if k != '_id'} for s in db.list('book_shares', 'book_id', book_id)])
    body = payload()
    if 'members' in body:
        if not isinstance(body['members'], dict) or len(body['members']) > 100:
            raise model.BookError('Invite up to 100 people per book.')
        members = {}
        for email, role in body['members'].items():
            email = email.strip().lower()
            if '@' not in email or len(email) > 254 or role not in ('view', 'edit'):
                raise model.BookError('Enter an email address and choose View or Edit.')
            members[email] = role

        def change(tx):
            latest = tx.get(path(book_id))
            latest.update(members=members, member_emails=list(members), lease=None, revision=latest['revision'] + 1)
            tx.put(path(book_id), latest)
        db.atomic(change)
        return jsonify(ok=True)
    if body.get('revoke'):
        ref = 'book_shares/' + model.identifier(body['revoke'])
        grant = db.get(ref)
        if not grant or grant['book_id'] != book_id:
            raise model.BookError('This sharing link is unavailable.', 404)
        grant['revoked'] = True
        db.put(ref, grant)
        return jsonify(ok=True)
    if body.get('role') not in ('view', 'edit'):
        raise model.BookError('Choose View or Edit for this link.')
    token = secrets.token_urlsafe(32)
    share_id = digest(token)
    expires = now() + model.number(body.get('days', 7), 1, 365, 7) * 86400 if body.get('days') else 0
    db.put('book_shares/' + share_id, {'id': share_id, 'book_id': book_id, 'owner_uid': book['owner_uid'], 'role': body['role'], 'require_signin': bool(body.get('require_signin')), 'expires_at': expires, 'revoked': False, 'created_at': now()})
    return jsonify(url=request.host_url.rstrip('/') + '/books/shared/' + token)


def exchange(runtime):
    body = payload()
    token = model.text(body.get('token'), 100)
    grant = store(runtime).get('book_shares/' + digest(token))
    user = identity(runtime)
    if not grant or grant.get('revoked') or (grant.get('expires_at') and grant['expires_at'] <= now()):
        raise model.BookError('This sharing link has expired or been turned off.', 403)
    if grant.get('require_signin') and not user:
        raise model.BookError('Sign in to open this shared book.', 401)
    name = model.text(body.get('name'), 60).strip() or 'Guest'
    claims = {'share': grant['id'], 'guest': 'guest-' + secrets.token_hex(12), 'name': name}
    return jsonify(book_id=grant['book_id'], access_token=signed_session().dumps(claims))


def comments(runtime, book_id):
    db, book, _, who = access(runtime, book_id)
    root = path(book_id) + '/comments'
    if request.method == 'GET':
        return jsonify(comments=sorted(db.list(root, limit=300), key=lambda c: c['created_at']))
    body = payload()
    if body.get('resolve'):
        comment = db.get(root + '/' + model.identifier(body['resolve']))
        if not comment or (comment['author_id'] != who['id'] and book['owner_uid'] != who['id']):
            raise model.BookError('Only the author or book owner can resolve this comment.', 403)
        comment['resolved'] = bool(body.get('resolved', True))
        db.put(root + '/' + comment['id'], comment)
    else:
        message = model.text(body.get('text'), 2000).strip()
        if not message:
            raise model.BookError('Write a comment first.')
        if len(db.list(root, limit=300)) >= 300:
            raise model.BookError('This book has reached its comment limit.')
        if body.get('page_id') not in book['page_ids']:
            raise model.BookError('Choose a page in this book for your comment.')
        cid = model.new_id()
        def add_comment(tx):
            tx.put(root + '/' + cid, {'id': cid, 'text': message, 'page_id': model.identifier(body.get('page_id')), 'item_id': model.text(body.get('item_id'), 100), 'author_id': who['id'], 'author': who['name'] or 'Guest', 'created_at': now(), 'resolved': False})
            tx.put('book_comments/' + cid, {'id': cid, 'uid': who['id'], 'book_id': book_id})
        db.atomic(add_comment)
    return jsonify(ok=True)


def history(runtime, book_id):
    db, book, _, who = access(runtime, book_id, 'edit')
    root = path(book_id) + '/versions'
    if request.method == 'GET':
        versions = db.list(root, limit=20)
        if request.args.get('include_pages') == '1':
            for version in versions:
                rows = db.list(root + '/' + version['id'] + '/pages', limit=200)
                version['pages'] = [next(p for p in rows if p['id'] == pid) for pid in version['page_ids']]
                version['deletedPages'] = [p for p in rows if p['id'] in version.get('deleted_page_ids', [])]
        return jsonify(versions=versions)
    body = payload()
    key = idempotency_key(body.get('idempotency_key'))
    if body.get('restore'):
        assert_lease(book, who, body)
        version = db.get(root + '/' + model.identifier(body['restore']))
        if not version:
            raise model.BookError('This version is unavailable.', 404)
        pages = db.list(root + '/' + version['id'] + '/pages', limit=200)
        return jsonify(metadata=version['metadata'], page_ids=version['page_ids'], deleted_page_ids=version.get('deleted_page_ids', []), pages=pages)
    vid = operation_id(book_id, 'version', key) if key else model.new_id()
    existing = db.get(root + '/' + vid)
    if existing:
        return jsonify(ok=True, version_id=vid, idempotent_replay=True)
    pages = db.list(path(book_id) + '/pages', limit=200)
    version_order = book['page_ids']
    version_deleted = book.get('deleted_page_ids', [])
    version_meta = model.metadata(book)
    if 'pages' in body:
        pages = [model.page(p) for p in model.array(body['pages'], 200, 'version page list')]
        version_order = model.validate_order(body.get('page_ids'))
        version_deleted = [model.identifier(p) for p in model.array(body.get('deleted_page_ids'), 100)]
        by_id = {p['id']: p for p in pages}
        if len(by_id) != len(pages) or not set(version_order + version_deleted) <= set(by_id):
            raise model.BookError('This saved version has missing pages.')
        ordered = [by_id[pid] for pid in version_order]
        if ordered[0]['role'] != 'front' or ordered[-1]['role'] != 'back':
            raise model.BookError('This version needs its front and back covers.')
        model.validate_spans(ordered)
        assets = {a['id'] for a in db.list(path(book_id) + '/assets', limit=400) if a.get('ready')}
        if any(aid and aid not in assets for p in pages for o in p['items'] for aid in (o['assetId'], o['originalAssetId'])):
            raise model.BookError('Upload the illustrations used by this version first.')
        version_meta = model.metadata(body.get('metadata'))

    def snapshot(tx):
        current = tx.get(path(book_id))
        existing = tx.get(root + '/' + vid)
        if existing:
            return True
        assert_lease(current, who, body)
        count = len(tx.list(root, limit=20))
        if count >= 20:
            raise model.BookError('This book already has 20 saved versions. Download a backup before starting another book.')
        # Serialize separate version keys too; the count must remain bounded even
        # when two requests for the same active editor arrive together.
        current['_version_count'] = count + 1
        tx.put(path(book_id), current)
        tx.put(root + '/' + vid, {'id': vid, 'name': model.text(body.get('name'), 100) or 'Saved version', 'created_at': now(), 'metadata': version_meta, 'page_ids': version_order, 'deleted_page_ids': version_deleted})
        for p in pages:
            tx.put(root + '/' + vid + '/pages/' + p['id'], p)
        return False
    return jsonify(ok=True, version_id=vid, idempotent_replay=db.atomic(snapshot))


def write_asset_part(db, asset_path, data, mime, resumable):
    """A timed-out storage POST may already have succeeded; verify before retrying."""
    try:
        book_storage.request('POST', asset_path, data, mime)
    except model.BookError as error:
        if resumable:
            reserve_transfer(db, len(data))
            try:
                existing = book_storage.request('GET', asset_path)
                if hashlib.sha256(existing).digest() == hashlib.sha256(data).digest():
                    return
            except model.BookError:
                pass
        raise error


def upload_asset(runtime, book_id):
    db, _, _, who = access(runtime, book_id, 'edit')
    key = idempotency_key(request.form.get('idempotency_key'))
    file = request.files.get('image')
    if not file:
        raise model.BookError('Choose an image first.')
    data = file.read(book_storage.MAX_BYTES + 1)
    dimensions, preview, mime = book_storage.validate_image(data)
    size = len(data) + len(preview)
    aid = operation_id(book_id, 'asset', key) if key else model.new_id()
    root = path(book_id) + '/assets/' + aid
    content_digest = hashlib.sha256(data).hexdigest()
    try:
        base_revision = int(request.form.get('base_revision', -1))
    except (TypeError, ValueError):
        raise model.BookError('Reload your book before uploading this image.') from None
    body = {'lease_token': request.form.get('lease_token'), 'base_revision': base_revision}
    asset = {'id': aid, 'book_id': book_id, 'name': model.text(file.filename, 120), 'size': size, 'original_size': len(data), 'preview_size': len(preview), 'width': dimensions[0], 'height': dimensions[1], 'mime': mime, 'path': book_id + '/' + aid + '/original', 'preview_path': book_id + '/' + aid + '/preview.webp', 'ready': False, '_content_digest': content_digest}

    def reserve(tx):
        book = tx.get(path(book_id))
        existing = tx.get(root)
        budget = tx.get('book_usage/storage') or {'bytes': 0}
        if existing:
            if existing.get('_content_digest') != content_digest:
                raise model.BookError('This image changed during upload. Add it again as a new image.', 409)
            if existing.get('ready'):
                return existing, True
            assert_lease(book, who, body)
            return existing, False
        assert_lease(book, who, body)
        if not book_storage.configured():
            raise model.BookError('Cloud image storage is temporarily unavailable. Your image stays on this device.', 503)
        if len(tx.list(path(book_id) + '/assets', limit=400)) >= 400:
            raise model.BookError('This book has 400 illustrations. Remove unused images before adding more.')
        if book.get('asset_bytes', 0) + size > book_storage.BOOK_BYTES or budget['bytes'] + size > book_storage.GLOBAL_BYTES:
            raise model.BookError('Image storage is full. Download a backup and remove unused images before adding more.', 413)
        book['asset_bytes'] = book.get('asset_bytes', 0) + size
        budget['bytes'] += size
        current_app.logger.info('Book image storage reserved: bytes=%s', budget['bytes'])
        tx.put(path(book_id), book)
        tx.put('book_usage/storage', budget)
        tx.put(root, asset)
        return asset, False
    asset, replay = db.atomic(reserve)
    if replay:
        return jsonify(asset=public_asset(asset), idempotent_replay=True), 200

    def failed(tx):
        current = tx.get(root)
        if current and not current.get('ready'):
            current['failed'] = True
            tx.put(root, current)
        return current

    try:
        write_asset_part(db, asset['path'], data, mime, bool(key))
        write_asset_part(db, asset['preview_path'], preview, 'image/webp', bool(key))
        # A revoked link or a changed editing turn cannot finish a pending write.
        access(runtime, book_id, 'edit')

        def finish(tx):
            book = tx.get(path(book_id))
            current = tx.get(root)
            if not current:
                raise model.BookError('This image upload was removed. Add the image again.', 409)
            if current.get('ready'):
                return current
            assert_lease(book, who, body)
            current.update(ready=True, failed=False)
            tx.put(root, current)
            return current
        asset = db.atomic(finish)
    except model.BookError:
        if key:
            # Stable paths and a single reservation allow recovery after partial
            # uploads or a server restart. Never delete another retry's bytes.
            completed = db.atomic(failed)
            if completed and completed.get('ready'):
                return jsonify(asset=public_asset(completed), idempotent_replay=True), 200
        else:
            # Legacy requests keep their cleanup behavior. Reservations remain
            # only when deleting partial storage could not be confirmed.
            try:
                for field in ('path', 'preview_path'):
                    book_storage.request('DELETE', asset[field])
                release_asset_reservation(db, book_id, aid, size)
            except model.BookError:
                db.atomic(failed)
        raise
    return jsonify(asset=public_asset(asset), idempotent_replay=False), 201


def release_asset_reservation(db, book_id, aid, size):
    def remove(tx):
        book = tx.get(path(book_id))
        budget = tx.get('book_usage/storage') or {'bytes': 0}
        asset = tx.get(path(book_id) + '/assets/' + aid)
        if not asset:
            return
        if book:
            book['asset_bytes'] = max(0, book.get('asset_bytes', 0) - asset['size'])
            tx.put(path(book_id), book)
        budget['bytes'] = max(0, budget['bytes'] - asset['size'])
        tx.put('book_usage/storage', budget)
        tx.delete(path(book_id) + '/assets/' + aid)
    db.atomic(remove)


def reserve_transfer(db, size):
    month = datetime.now(timezone.utc).strftime('%Y-%m')

    def reserve(tx):
        budget = tx.get('book_usage/transfer-' + month) or {'bytes': 0}
        if budget['bytes'] + size > book_storage.MONTHLY_BYTES:
            raise model.BookError('This month’s image transfer allowance has been reached. Existing local images remain available.', 429)
        budget['bytes'] += size
        tx.put('book_usage/transfer-' + month, budget)
    db.atomic(reserve)


def get_asset(runtime, book_id, asset_id):
    db, _, _, _ = access(runtime, book_id)
    asset = db.get(path(book_id) + '/assets/' + model.identifier(asset_id))
    if not asset or not asset.get('ready'):
        raise model.BookError('This image is unavailable.', 404)
    original = request.args.get('original') == '1'
    size = asset['original_size'] if original else asset['preview_size']
    reserve_transfer(db, size)
    data = book_storage.request('GET', asset['path'] if original else asset['preview_path'])
    response = send_file(io.BytesIO(data), mimetype=asset['mime'] if original else 'image/webp', download_name=asset['name'], as_attachment=original)
    response.headers['Cache-Control'] = 'private, no-store'
    return response


def delete_asset(runtime, book_id, asset_id):
    db, book, _, who = access(runtime, book_id, 'edit')
    body = payload()
    assert_lease(book, who, body)
    aid = model.identifier(asset_id)
    asset = db.get(path(book_id) + '/assets/' + aid)
    if not asset:
        raise model.BookError('This image is unavailable.', 404)
    collections = [path(book_id) + '/pages'] + [path(book_id) + '/versions/' + v['id'] + '/pages' for v in db.list(path(book_id) + '/versions', limit=20)]
    for collection in collections:
        if any(aid in (o.get('assetId'), o.get('originalAssetId')) for p in db.list(collection, limit=200) for o in p['items']):
            raise model.BookError('This image is used by a page or saved version. Keep it so those pages can still open.')
    def mark_removing(tx):
        latest = tx.get(path(book_id))
        stored = tx.get(path(book_id) + '/assets/' + aid)
        assert_lease(latest, who, body)
        # Invalidate in-flight saves before deleting bytes; save validates readiness again.
        stored.update(ready=False, failed=True)
        latest['revision'] += 1
        tx.put(path(book_id), latest)
        tx.put(path(book_id) + '/assets/' + aid, stored)
        return latest['revision']
    new_revision = db.atomic(mark_removing)
    for field in ('path', 'preview_path'):
        book_storage.request('DELETE', asset[field])
    release_asset_reservation(db, book_id, aid, asset['size'])
    return jsonify(ok=True, revision=new_revision)


def backup(runtime, book_id):
    db, book, _, _ = access(runtime, book_id, 'edit')
    pages = db.list(path(book_id) + '/pages', limit=200)
    assets = db.list(path(book_id) + '/assets', limit=400)
    reserve_transfer(db, sum(a.get('original_size', 0) for a in assets if a.get('ready')))
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        versions = db.list(path(book_id) + '/versions', limit=20)
        for version in versions:
            rows = db.list(path(book_id) + '/versions/' + version['id'] + '/pages', limit=200)
            version['pages'] = [next(p for p in rows if p['id'] == pid) for pid in version['page_ids']]
            version['deletedPages'] = [p for p in rows if p['id'] in version.get('deleted_page_ids', [])]
        snapshot = dict(model.metadata(book), schema_version=1, pages=[next(p for p in pages if p['id'] == pid) for pid in book['page_ids']], deletedPages=[p for p in pages if p['id'] in book.get('deleted_page_ids', [])], versions=versions, assets=[public_asset(a) for a in assets if a.get('ready')])
        if db.get(path(book_id))['revision'] != book['revision']:
            raise model.BookError('The book changed while the backup was preparing. Please try again.', 409)
        archive.writestr('book.json', json.dumps(snapshot))
        for asset in assets:
            if asset.get('ready'):
                archive.writestr('assets/' + asset['id'], book_storage.request('GET', asset['path']))
    output.seek(0)
    return send_file(output, as_attachment=True, download_name='book-backup.zip', mimetype='application/zip')
