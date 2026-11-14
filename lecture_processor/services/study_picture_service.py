"""Account-scoped study pictures, stored in the existing private image bucket."""
from __future__ import annotations

import hashlib
import io
import logging
import re
import threading
import time
import uuid

from flask import jsonify, send_file

from lecture_processor.domains.books.model import BookError
from lecture_processor.repositories.books_repo import BookStore
from lecture_processor.repositories import study_repo
from lecture_processor.services import book_service, book_storage, study_api_support

MAX_CARD_IMAGES = 8
IMAGE_ID = re.compile(r'^[a-f0-9]{64}$')
PENDING_PICTURES = 'picture_cleanup_pending_ids'
UPLOAD_LEASE_SECONDS = 180
UPLOAD_HEARTBEAT_SECONDS = 30
_UPLOADS = {}
_UPLOADS_LOCK = threading.Lock()


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
        assets = {
            doc.id: doc.to_dict() or {}
            for doc in study_repo.get_study_image_docs(runtime.db, all_ids)
            if doc.exists
        }
        for aid in all_ids:
            asset = assets.get(aid)
            if not asset or not asset.get('ready') or asset.get('uid') != uid or asset.get('pack_id') != pack_id:
                raise BookError('This picture does not belong to this study pack.', 403)
    for card in cleaned:
        ids = references.get((card['front'], card['back']))
        if ids:
            card['image_ids'] = ids
    return cleaned


def _card_image_ids(cards):
    return {
        aid for card in (cards if isinstance(cards, list) else []) if isinstance(card, dict)
        for aid in (card.get('image_ids') if isinstance(card.get('image_ids'), list) else [])
        if isinstance(aid, str) and IMAGE_ID.fullmatch(aid)
    }


def update_pack_and_collect_removed(runtime, uid, pack_id, updates):
    """Serialize card attachment with image cleanup and retain failed cleanup work."""
    db = BookStore(runtime.db)

    def update(tx):
        pack = tx.get('study_packs/' + pack_id)
        if not pack:
            raise BookError('Study pack not found.', 404)
        if pack.get('uid') != uid:
            raise BookError('Forbidden', 403)
        next_ids = _card_image_ids(updates.get('flashcards', pack.get('flashcards', [])))
        for aid in sorted(next_ids):
            asset = tx.get('study_images/' + aid)
            if not asset or not asset.get('ready') or asset.get('deleting') or asset.get('uid') != uid or asset.get('pack_id') != pack_id:
                raise BookError('This picture does not belong to this study pack.', 403)
        pending = (set(pack.get(PENDING_PICTURES, [])) | _card_image_ids(pack.get('flashcards'))) - next_ids
        tx.put('study_packs/' + pack_id, {**pack, **updates, PENDING_PICTURES: sorted(pending)})
        return sorted(pending)

    return db.atomic(update)


def _generation(asset):
    # Existing pictures use deterministic paths; new generations use unique
    # paths so a late old cleaner cannot remove a replacement upload.
    return (asset.get('generation'), asset.get('path'), asset.get('preview_path'))


def _live_upload_leases(asset):
    now = time.time()
    leases = asset.get('upload_leases') or {}
    return {token: expiry for token, expiry in leases.items()
            if isinstance(expiry, (int, float)) and expiry > now}


def _renew_upload_lease(db, asset, token, *, allow_deleting=False):
    def renew(tx):
        current = tx.get('study_images/' + asset['id'])
        if (not current or current.get('uid') != asset['uid']
                or _generation(current) != _generation(asset)
                or current.get('delete_started')
                or (current.get('deleting') and not allow_deleting)
                or token not in (current.get('upload_leases') or {})):
            return False
        leases = _live_upload_leases(current)
        leases[token] = time.time() + UPLOAD_LEASE_SECONDS
        current['upload_leases'] = leases
        tx.put('study_images/' + asset['id'], current)
        return True

    return db.atomic(renew)


def _drop_upload_lease(db, asset, token):
    def release(tx):
        current = tx.get('study_images/' + asset['id'])
        if (not current or _generation(current) != _generation(asset)
                or token not in (current.get('upload_leases') or {})):
            return
        current['upload_leases'] = {key: value for key, value in current['upload_leases'].items() if key != token}
        tx.put('study_images/' + asset['id'], current)

    db.atomic(release)


def _upload_heartbeat(db, asset, token, stopped):
    while not stopped.wait(UPLOAD_HEARTBEAT_SECONDS):
        try:
            # A pending delete waits for a POST already in flight. Keep its
            # lease alive until that POST has returned, even after ready=True.
            if not _renew_upload_lease(db, asset, token, allow_deleting=True):
                return
        except Exception:
            logging.getLogger(__name__).warning('Could not renew study picture upload lease', exc_info=True)


def _delete_asset(db, uid, asset, *, account_delete=False):
    aid = asset['id']
    root = 'study_images/' + aid
    pack_path = 'study_packs/' + asset['pack_id']

    def claim(tx):
        current = tx.get(root)
        pack = tx.get(pack_path) if not account_delete else None
        if not current or current.get('uid') != uid or _generation(current) != _generation(asset):
            return None
        if not account_delete and pack:
            if pack.get('uid') != uid or aid in _card_image_ids(pack.get('flashcards')):
                return None
            if aid not in pack.get(PENDING_PICTURES, []):
                return None
        current.update(deleting=True, ready=False)
        with _UPLOADS_LOCK:
            busy = bool(_live_upload_leases(current) or _UPLOADS.get(aid))
        if not busy:
            current['delete_started'] = True
        tx.put(root, current)
        return current, busy

    result = db.atomic(claim)
    if result is None:
        return False
    claimed, busy = result
    if busy:
        raise BookError('Picture upload is finishing. Please retry removal shortly.', 503)
    for field in ('path', 'preview_path'):
        book_storage.request('DELETE', claimed[field])

    def release(tx):
        current = tx.get(root)
        budget = tx.get('book_usage/storage') or {'bytes': 0}
        pack = tx.get(pack_path)
        if not current or not current.get('delete_started') or _generation(current) != _generation(claimed):
            return False
        budget['bytes'] = max(0, budget['bytes'] - current['size'])
        tx.put('book_usage/storage', budget)
        tx.delete(root)
        if pack and pack.get('uid') == uid and aid in pack.get(PENDING_PICTURES, []):
            pack[PENDING_PICTURES] = [value for value in pack[PENDING_PICTURES] if value != aid]
            tx.put(pack_path, pack)
        return True

    return db.atomic(release)


def delete_for_pack(runtime, uid, pack_id, image_ids=None):
    """Delete committed removals, retaining metadata/reservation until bytes go."""
    db = BookStore(runtime.db)
    if image_ids is not None:
        count = 0
        for aid in sorted(set(image_ids)):
            if not isinstance(aid, str) or not IMAGE_ID.fullmatch(aid):
                continue
            asset = db.get('study_images/' + aid)
            if asset and asset.get('pack_id') == pack_id and asset.get('uid') == uid:
                count += bool(_delete_asset(db, uid, asset))
        return count

    # Whole-pack cleanup starts only after the pack transaction committed. A
    # repeated DELETE can find this metadata even when the pack is already gone.
    if db.get('study_packs/' + pack_id):
        return 0
    count = 0
    while True:
        assets = db.list('study_images', 'pack_id', pack_id, limit=100)
        deleted = 0
        for asset in assets:
            if asset.get('uid') == uid:
                deleted += bool(_delete_asset(db, uid, asset))
        count += deleted
        if not assets or not deleted:
            return count


def save_image(runtime, uid, pack_id, data, name):
    aid = hashlib.sha256(uid.encode() + b'\0' + pack_id.encode() + b'\0' + data).hexdigest()
    token = uuid.uuid4().hex
    attempt = {'asset': None, 'heartbeat': None, 'stopped': threading.Event()}
    db = BookStore(runtime.db)
    with _UPLOADS_LOCK:
        _UPLOADS.setdefault(aid, set()).add(token)
    try:
        return _save_image(runtime, uid, pack_id, data, name, token, attempt)
    finally:
        attempt['stopped'].set()
        if attempt['heartbeat'] is not None:
            attempt['heartbeat'].join(timeout=1)
        if attempt['asset'] is not None:
            try:
                _drop_upload_lease(db, attempt['asset'], token)
            except Exception:
                # Retain the reservation on an uncertain release. The lease
                # expires, and a later cleanup retry can finish normally.
                logging.getLogger(__name__).warning('Could not release study picture upload lease', exc_info=True)
        with _UPLOADS_LOCK:
            active = _UPLOADS.get(aid)
            if active is not None:
                active.discard(token)
                if not active:
                    _UPLOADS.pop(aid, None)
        current = db.get('study_images/' + aid)
        if current and (current.get('deleting') or (not current.get('ready') and not db.get('study_packs/' + pack_id))):
            _delete_asset(db, uid, current)


def _save_image(runtime, uid, pack_id, data, name, token, attempt):
    """Content-addressed writes make interrupted uploads safe to retry."""
    dimensions, preview, mime = book_storage.validate_image(data)
    aid = hashlib.sha256(uid.encode() + b'\0' + pack_id.encode() + b'\0' + data).hexdigest()
    root = 'study_images/' + aid
    generation = uuid.uuid4().hex
    base = 'study/' + uid + '/' + aid + '/' + generation
    asset = dict(id=aid, uid=uid, pack_id=pack_id, name=str(name or 'Picture')[:120],
                 size=len(data) + len(preview), original_size=len(data), preview_size=len(preview),
                 width=dimensions[0], height=dimensions[1], mime=mime, path=base + '/original',
                 preview_path=base + '/preview.webp', generation=generation, ready=False, created_at=time.time())
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
            if existing.get('uid') != uid or existing.get('pack_id') != pack_id:
                raise BookError('Picture not found.', 404)
            if existing.get('deleting'):
                raise BookError('Picture removal is still in progress. Try again shortly.', 409)
            if not existing.get('ready'):
                leases = _live_upload_leases(existing)
                leases[token] = time.time() + UPLOAD_LEASE_SECONDS
                existing['upload_leases'] = leases
                tx.put(root, existing)
            return existing
        if not book_storage.configured():
            raise BookError('Picture storage is temporarily unavailable. Try again later.', 503)
        if budget['bytes'] + asset['size'] > book_storage.GLOBAL_BYTES:
            raise BookError('Picture storage is full.', 413)
        budget['bytes'] += asset['size']
        asset['upload_leases'] = {token: time.time() + UPLOAD_LEASE_SECONDS}
        tx.put('book_usage/storage', budget)
        tx.put(root, asset)
        return asset

    asset = db.atomic(reserve)
    attempt['asset'] = asset
    if not asset.get('ready'):
        heartbeat = threading.Thread(target=_upload_heartbeat, args=(db, asset, token, attempt['stopped']), daemon=True)
        attempt['heartbeat'] = heartbeat
        heartbeat.start()

        def finish(tx):
            check_owner(tx)
            current = tx.get(root)
            if (not current or current.get('deleting') or current.get('delete_started')
                    or _generation(current) != _generation(asset)
                    or token not in (current.get('upload_leases') or {})):
                raise BookError('Add this picture again.', 409)
            current['ready'] = True
            tx.put(root, current)
            return current

        for path, part, part_mime in ((asset['path'], data, mime), (asset['preview_path'], preview, 'image/webp')):
            if not _renew_upload_lease(db, asset, token):
                raise BookError('Picture removal is in progress. Add the picture again after it finishes.', 409)
            book_service.write_asset_part(db, path, part, part_mime, True)
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
        deleted = 0
        for asset in assets:
            deleted += bool(_delete_asset(db, uid, asset, account_delete=True))
        count += deleted
        if not deleted:
            return count


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
