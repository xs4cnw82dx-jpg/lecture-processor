"""Import a reviewed local flashcard/picture manifest into one owner's study library.

Dry run by default. Local credentials, content and images must never be committed.
Use --apply after reviewing the counts printed by the dry run.
"""
from __future__ import annotations

import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
import hashlib
import json
from pathlib import Path
import sys
import time
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))


def stable_id(uid, kind, label):
    return 'picture-import-' + hashlib.sha256((uid + ':' + kind + ':' + label).encode()).hexdigest()[:24]


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--manifest', required=True)
    parser.add_argument('--credentials', required=True)
    parser.add_argument('--env-file', required=True)
    parser.add_argument('--email', required=True)
    parser.add_argument('--apply', action='store_true')
    args = parser.parse_args()
    from dotenv import load_dotenv
    load_dotenv(args.env_file)
    import firebase_admin
    from firebase_admin import auth, credentials, firestore
    from lecture_processor.services import study_picture_service

    manifest = json.loads(Path(args.manifest).read_text())
    assert manifest['folder'] and manifest['packs']
    for pack in manifest['packs']:
        assert 0 < len(pack['cards']) <= 500
        for card in pack['cards']:
            assert card['front'] and card['back']
            assert len(card['pictures']) <= study_picture_service.MAX_CARD_IMAGES
            for image in card['pictures']:
                assert Path(image['file']).is_file(), image['file']
        print(pack['block'], len(pack['cards']), 'cards', len({i['file'] for c in pack['cards'] for i in c['pictures']}), 'pictures', flush=True)
    if not args.apply:
        print('Dry run complete. No account or storage changes.')
        return
    firebase_admin.initialize_app(credentials.Certificate(args.credentials))
    uid = auth.get_user_by_email(args.email).uid
    db = firestore.client()
    runtime = SimpleNamespace(db=db)
    user_ref = db.collection('users').document(uid)
    user = user_ref.get().to_dict() or {}
    if user.get('account_status', 'active') != 'active':
        raise RuntimeError('Account is not active. Import stopped.')
    user_ref.update({'study_pictures_enabled': True})
    root_id = stable_id(uid, 'folder', manifest['folder'])
    root_ref = db.collection('study_folders').document(root_id)
    timestamp = time.time()
    if not root_ref.get().exists:
        root_ref.create(dict(uid=uid, name=manifest['folder'], parent_folder_id='', created_at=timestamp, updated_at=timestamp, sort_order=0))
    for pack in manifest['packs']:
        block = pack['block']
        folder_id = stable_id(uid, 'folder', manifest['folder'] + '/' + block)
        folder_ref = db.collection('study_folders').document(folder_id)
        if not folder_ref.get().exists:
            folder_ref.create(dict(uid=uid, name=block, parent_folder_id=root_id, block=block, subject='Anatomy', course='Fysiotherapie', semester='1', created_at=timestamp, updated_at=timestamp, sort_order=float(block)))
        pack_id = stable_id(uid, 'pack', manifest['folder'] + '/' + block)
        pack_ref = db.collection('study_packs').document(pack_id)
        source_hash = hashlib.sha256(json.dumps(pack, sort_keys=True, ensure_ascii=False).encode()).hexdigest()
        existing = pack_ref.get()
        cards = [{'front': c['front'], 'back': c['back']} for c in pack['cards']]
        if existing.exists:
            old = existing.to_dict()
            if old.get('uid') != uid or old.get('picture_import_hash') != source_hash:
                raise RuntimeError('Existing pack differs from the import. It has been preserved.')
            if [{'front': c['front'], 'back': c['back']} for c in old['flashcards']] != cards:
                raise RuntimeError('The imported cards were edited. They have been preserved.')
        else:
            pack_ref.create(dict(study_pack_id=pack_id, uid=uid, mode='manual', title=pack['title'], folder_id=folder_id, folder_name=block,
                                 course='Fysiotherapie', subject='Anatomy', semester='1', block=block, output_language='English',
                                 notes_markdown='Imported from your Studykit export: ' + Path(pack['source']).name,
                                 flashcards=cards, flashcards_count=len(cards), test_questions=[], test_questions_count=0,
                                 study_features='flashcards', flashcard_selection='manual', question_selection='manual',
                                 created_at=timestamp, updated_at=timestamp, picture_import_hash=source_hash))
        images = {}
        unique = {image['file']: image for card in pack['cards'] for image in card['pictures']}
        def upload(image):
            data = Path(image['file']).read_bytes()
            saved = study_picture_service.save_image(runtime, uid, pack_id, data, image['name'])
            return image['file'], saved['id']
        with ThreadPoolExecutor(max_workers=4) as pool:
            pending = [pool.submit(upload, image) for image in unique.values()]
            for future in as_completed(pending):
                filename, image_id = future.result()
                images[filename] = image_id
                print(block, 'picture', len(images), 'saved', flush=True)
        for card, source in zip(cards, pack['cards']):
            card['image_ids'] = [images[i['file']] for i in source['pictures']]
        transaction = db.transaction()
        @firestore.transactional
        def attach(tx):
            current = pack_ref.get(transaction=tx).to_dict() or {}
            if current.get('picture_import_hash') != source_hash or [{'front': c['front'], 'back': c['back']} for c in current.get('flashcards', [])] != [{'front': c['front'], 'back': c['back']} for c in cards]:
                raise RuntimeError('Cards changed during upload. Their edits have been preserved.')
            tx.update(pack_ref, {'flashcards': cards, 'updated_at': time.time()})
        attach(transaction)
        print('Completed', block, pack_id, flush=True)
    print('Import complete. Folder:', root_id, flush=True)


if __name__ == '__main__':
    main()
