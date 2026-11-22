"""Store learning media within the shared budget and erase expeditions retryably."""
from __future__ import annotations

import time

from lecture_processor.domains.elearning.model import ElearningError
from lecture_processor.services import book_storage
from lecture_processor.services.book_service import reserve_transfer


def erase_asset(db, meta, *, upload_finished=False):
    key = 'elearning_assets/' + meta['id']
    if not upload_finished and not meta.get('ready', True) and meta.get('upload_until', 0) > time.time():
        raise ElearningError('An upload is still finishing. Please retry removal in a moment.', 409)
    # Preserve both path and reservation if the external store cannot delete the file.
    book_storage.request('DELETE', meta['path'])

    def release(tx):
        current = tx.get(key)
        if not current:
            return
        if current.get('reserved'):
            root = 'elearning_expeditions/' + current['expedition_id']
            course = tx.get(root)
            usage = tx.get('book_usage/storage') or {'bytes': 0}
            usage['bytes'] = max(0, usage['bytes'] - current['size'])
            tx.put('book_usage/storage', usage)
            if course:
                course['asset_bytes'] = max(0, course.get('asset_bytes', 0) - current['size'])
                tx.put(root, course)
        tx.delete(key)
    db.atomic(release)


def store_asset(db, meta, data):
    root = 'elearning_expeditions/' + meta['expedition_id']
    key = 'elearning_assets/' + meta['id']
    if not book_storage.configured():
        raise ElearningError('Media storage is temporarily unavailable.', 503)
    meta = {**meta, 'size': len(data), 'ready': False, 'reserved': True, 'upload_until': time.time() + 120}

    def reserve(tx):
        course = tx.get(root)
        if not course or course.get('deleted'):
            raise ElearningError('This expedition is unavailable.', 404)
        usage = tx.get('book_usage/storage') or {'bytes': 0}
        course_bytes = course.get('asset_bytes', 0) + len(data)
        if course_bytes > book_storage.BOOK_BYTES or usage['bytes'] + len(data) > book_storage.GLOBAL_BYTES:
            raise ElearningError('Media storage is full. Remove unused files before adding more.', 413)
        course['asset_bytes'] = course_bytes
        usage['bytes'] += len(data)
        tx.put(root, course)
        tx.put('book_usage/storage', usage)
        tx.put(key, meta)

    def finish(tx):
        current = tx.get(key)
        course = tx.get(root)
        if not current or not course or course.get('deleted'):
            raise ElearningError('This upload was removed.', 409)
        tx.put(key, {**current, 'ready': True})

    db.atomic(reserve)
    try:
        book_storage.request('POST', meta['path'], data=data, content_type=meta['content_type'])
        db.atomic(finish)
    except Exception:
        erase_asset(db, meta, upload_finished=True)
        raise


def read_asset(db, meta):
    if not meta.get('ready', True):
        raise ElearningError('This file is unavailable.', 404)
    reserve_transfer(db, meta['size'])
    data = book_storage.request('GET', meta['path'], max_response_bytes=meta['size'])
    if len(data) != meta['size']:
        raise ElearningError('The media file could not be read completely. Please try again.', 503)
    return data


def delete_expedition(db, eid, uid):
    root = 'elearning_expeditions/' + eid

    def close(tx):
        course = tx.get(root)
        if not course or course.get('owner_uid') != uid:
            raise ElearningError('This expedition is unavailable.', 404)
        tx.put(root, {**course, 'deleted': True, 'copying': False, 'lease': {}})
    db.atomic(close)
    # Each successfully deleted page disappears from the next query. The parent
    # retains ownership through interruptions, so the same request can resume.
    for collection in ('elearning_share_index', 'elearning_grant_tokens', 'elearning_grants',
                       'elearning_assets', 'elearning_responses'):
        while rows := db.list(collection, 'expedition_id', eid, limit=100):
            for row in rows:
                if collection == 'elearning_assets':
                    erase_asset(db, row)
                else:
                    db.delete(collection + '/' + row['_id'])
    db.delete(root)
