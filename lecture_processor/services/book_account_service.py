"""Book ownership cleanup and portable account-export integration."""
import json

from lecture_processor.repositories.books_repo import BookStore
from lecture_processor.services import book_storage


def collect(runtime, uid):
    db = BookStore(runtime.db)
    result = []
    for book in db.list('books', 'owner_uid', uid, limit=101):
        root = 'books/' + book['id']
        pages = db.list(root + '/pages', limit=200)
        assets = db.list(root + '/assets', limit=400)
        versions = db.list(root + '/versions', limit=20)
        for version in versions:
            rows = db.list(root + '/versions/' + version['id'] + '/pages', limit=200)
            version['pages'] = [next(p for p in rows if p['id'] == pid) for pid in version['page_ids']]
            version['deletedPages'] = [p for p in rows if p['id'] in version.get('deleted_page_ids', [])]
        result.append({
            **{k: v for k, v in book.items() if k not in ('lease', '_id')},
            'pages': [next(p for p in pages if p['id'] == pid) for pid in book['page_ids']],
            'deletedPages': [p for p in pages if p['id'] in book.get('deleted_page_ids', [])],
            'assets': [{k: v for k, v in a.items() if k not in ('path', 'preview_path', '_id')} for a in assets],
            'comments': db.list(root + '/comments', limit=300), 'versions': versions,
            'local': True, 'pending': False, 'role': 'owner',
        })
    return result


def add_bundle_assets(runtime, archive, books):
    if not books:
        return
    from lecture_processor.services.book_service import reserve_transfer
    db = BookStore(runtime.db)
    total = sum(a.get('original_size', 0) for b in books for a in b['assets'] if a.get('ready'))
    reserve_transfer(db, total)
    for book in books:
        prefix = 'books/' + book['id'] + '/'
        archive.writestr(prefix + 'book.json', json.dumps(book, ensure_ascii=False))
        for asset in db.list('books/' + book['id'] + '/assets', limit=400):
            if asset.get('ready'):
                archive.writestr(prefix + 'assets/' + asset['id'], book_storage.request('GET', asset['path']))


def delete_owned(runtime, uid, email):
    from lecture_processor.services.book_service import release_asset_reservation
    db = BookStore(runtime.db)
    count = 0
    for book in db.list('books', 'owner_uid', uid, limit=101):
        root = 'books/' + book['id']
        book.update(deleted=True, lease=None)
        db.put(root, book)
        for grant in db.list('book_shares', 'book_id', book['id']):
            db.delete('book_shares/' + grant['id'])
        for asset in db.list(root + '/assets', limit=400):
            for key in ('path', 'preview_path'):
                book_storage.request('DELETE', asset[key])
            release_asset_reservation(db, book['id'], asset['id'], asset['size'])
        for version in db.list(root + '/versions', limit=20):
            vroot = root + '/versions/' + version['id']
            for p in db.list(vroot + '/pages', limit=200):
                db.delete(vroot + '/pages/' + p['id'])
            db.delete(vroot)
        for collection in ('pages', 'comments'):
            for row in db.list(root + '/' + collection, limit=400):
                db.delete(root + '/' + collection + '/' + row['id'])
                if collection == 'comments':
                    db.delete('book_comments/' + row['id'])
        db.delete(root)
        count += 1
    # Remove membership, not the collaborator's books.
    for book in db.list('books', 'member_emails', email.lower(), 'array_contains') if email else []:
        def remove_member(tx):
            root = 'books/' + book['id']
            current = tx.get(root)
            current['members'].pop(email.lower(), None)
            current['member_emails'] = list(current['members'])
            if (current.get('lease') or {}).get('user_id') == uid:
                current['lease'] = None
            current['revision'] += 1
            tx.put(root, current)
        db.atomic(remove_member)
    for comment in db.list('book_comments', 'uid', uid, limit=30000):
        db.delete('books/' + comment['book_id'] + '/comments/' + comment['id'])
        db.delete('book_comments/' + comment['id'])
    return count
