"""Account-scoped study pictures, stored in the existing private image bucket."""
from __future__ import annotations

import hashlib
import io
import re
import time

from flask import jsonify, send_file

from lecture_processor.domains.books.model import BookError
from lecture_processor.repositories.books_repo import BookStore
from lecture_processor.services import book_service, book_storage, study_api_support

MAX_CARD_IMAGES = 8
IMAGE_ID = re.compile(r'^[a-f0-9]{64}$')


def enabled(runtime, uid):
    if runtime.db is None:
        return False
    user = runtime.db.collection('users').document(uid).get()
    return bool(user.exists and (user.to_dict() or {}).get('study_pictures_enabled') is True)


def require_access(runtime, request, pack_id, *, write=False):
    user, error, status = study_api_support.require_user(runtime, request)
    if error is not None:
        return None, (error, status)
    uid = user['uid']
    if not enabled(runtime, uid):
        return None, (jsonify(error='Pictures are not enabled for this account.'), 403)
    if write:
        guard = study_api_support.account_write_guard(runtime, uid)
        if guard is not None:
            return None, guard
    _, error, status = study_api_support.get_owned_study_pack(runtime, uid, pack_id)
    if error is not None:
        return None, (error, status)
    return uid, None


def sanitize_cards(runtime, uid, pack_id, items):
    """Preserve image references through edits, rejecting foreign or missing assets."""
    cleaned = runtime.sanitize_flashcards(items, 500)
    if not isinstance(items, list):
        return cleaned
    references = {}
    for item in items:
        if not isinstance(item, dict) or 'image_ids' not in item:
            continue
        ids = item['image_ids']
        if not isinstance(ids, list) or len(ids) > MAX_CARD_IMAGES:
            raise BookError('Choose at most eight pictures per flashcard.')
        if any(not isinstance(aid, str) or not IMAGE_ID.fullmatch(aid) for aid in ids):
            raise BookError('This flashcard contains an invalid picture.')
        row = runtime.sanitize_flashcards([item], 1)
        if row:
            references.setdefault((row[0]['front'], row[0]['back']), list(dict.fromkeys(ids)))
    all_ids = {aid for ids in references.values() for aid in ids}
    if all_ids:
        if not enabled(runtime, uid):
            raise BookError('Pictures are not enabled for this account.', 403)
        db = BookStore(runtime.db)
        for aid in all_ids:
            asset = db.get('study_images/' + aid)
            if not asset or not asset.get('ready') or asset.get('uid') != uid or asset.get('pack_id') != pack_id:
                raise BookError('This picture does not belong to this study pack.', 403)
    for card in cleaned:
        ids = references.get((card['front'], card['back']))
        if ids:
            card['image_ids'] = ids
    return cleaned


def save_image(runtime, uid, pack_id, data, name):
    """Content-addressed writes make interrupted uploads safe to retry."""
    dimensions, preview, mime = book_storage.validate_image(data)
    aid = hashlib.sha256(uid.encode() + b'\0' + pack_id.encode() + b'\0' + data).hexdigest()
    root = 'study_images/' + aid
    base = 'study/' + uid + '/' + aid
    asset = dict(id=aid, uid=uid, pack_id=pack_id, name=str(name or 'Picture')[:120],
                 size=len(data) + len(preview), original_size=len(data), preview_size=len(preview),
                 width=dimensions[0], height=dimensions[1], mime=mime, path=base + '/original',
                 preview_path=base + '/preview.webp', ready=False, created_at=time.time())
    db = BookStore(runtime.db)

    def check_owner(tx):
        pack = tx.get('study_packs/' + pack_id)
        user = tx.get('users/' + uid) or {}
        if not pack or pack.get('uid') != uid:
            raise BookError('Study pack not found.', 404)
        if user.get('study_pictures_enabled') is not True:
            raise BookError('Pictures are not enabled for this account.', 403)
        if user.get('account_status') in ('deleting', 'delete_requested', 'deleted'):
            raise BookError('Account deletion is in progress.', 409)

    def reserve(tx):
        check_owner(tx)
        existing = tx.get(root)
        budget = tx.get('book_usage/storage') or {'bytes': 0}
        if existing:
            return existing
        if not book_storage.configured():
            raise BookError('Picture storage is temporarily unavailable. Try again later.', 503)
        if budget['bytes'] + asset['size'] > book_storage.GLOBAL_BYTES:
            raise BookError('Picture storage is full.', 413)
        budget['bytes'] += asset['size']
        tx.put('book_usage/storage', budget)
        tx.put(root, asset)
        return asset

    asset = db.atomic(reserve)
    if not asset.get('ready'):
        book_service.write_asset_part(db, asset['path'], data, mime, True)
        book_service.write_asset_part(db, asset['preview_path'], preview, 'image/webp', True)

        def finish(tx):
            check_owner(tx)
            current = tx.get(root)
            if not current:
                raise BookError('Add this picture again.', 409)
            current['ready'] = True
            tx.put(root, current)
            return current
        asset = db.atomic(finish)
    return {k: asset[k] for k in ('id', 'name', 'width', 'height')}


def upload(runtime, request, pack_id):
    uid, error = require_access(runtime, request, pack_id, write=True)
    if error is not None:
        return error
    file = request.files.get('image')
    if not file:
        raise BookError('Choose a picture first.')
    return jsonify(image=save_image(runtime, uid, pack_id, file.read(book_storage.MAX_BYTES + 1), file.filename)), 201


def get_image(runtime, request, pack_id, aid):
    uid, error = require_access(runtime, request, pack_id)
    if error is not None:
        return error
    if not IMAGE_ID.fullmatch(aid):
        raise BookError('Picture not found.', 404)
    db = BookStore(runtime.db)
    asset = db.get('study_images/' + aid)
    if not asset or asset.get('uid') != uid or asset.get('pack_id') != pack_id or not asset.get('ready'):
        raise BookError('Picture not found.', 404)
    original = request.args.get('original') == '1'
    book_service.reserve_transfer(db, asset['original_size'] if original else asset['preview_size'])
    data = book_storage.request('GET', asset['path'] if original else asset['preview_path'])
    response = send_file(io.BytesIO(data), mimetype=asset['mime'] if original else 'image/webp',
                         download_name=asset['name'], as_attachment=original)
    response.headers['Cache-Control'] = 'private, no-store'
    response.headers['X-Content-Type-Options'] = 'nosniff'
    return response


def delete_owned(runtime, uid):
    """Account deletion also removes private bytes, including interrupted uploads."""
    db = BookStore(runtime.db)
    count = 0
    while True:
        assets = db.list('study_images', 'uid', uid, limit=100)
        if not assets:
            return count
        for asset in assets:
            for field in ('path', 'preview_path'):
                book_storage.request('DELETE', asset[field])
            def release(tx):
                current = tx.get('study_images/' + asset['id'])
                budget = tx.get('book_usage/storage') or {'bytes': 0}
                if current:
                    budget['bytes'] = max(0, budget['bytes'] - current['size'])
                    tx.put('book_usage/storage', budget)
                    tx.delete('study_images/' + asset['id'])
            db.atomic(release)
            count += 1


def collect(runtime, uid):
    assets = BookStore(runtime.db).list('study_images', 'uid', uid, limit=30000)
    return [{k: v for k, v in asset.items() if k not in ('path', 'preview_path', '_id')} for asset in assets]


def add_bundle_assets(runtime, archive, uid):
    db = BookStore(runtime.db)
    assets = [asset for asset in db.list('study_images', 'uid', uid, limit=30000) if asset.get('ready')]
    if not assets:
        return
    book_service.reserve_transfer(db, sum(asset['original_size'] for asset in assets))
    for asset in assets:
        archive.writestr('study_pictures/' + asset['id'], book_storage.request('GET', asset['path']))
