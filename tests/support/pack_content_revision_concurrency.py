from copy import deepcopy
from types import SimpleNamespace

from flask import Flask, jsonify
from google.cloud import firestore

from lecture_processor.domains.ai import study_generation
from lecture_processor.repositories import study_repo
from lecture_processor.services import access_service
from lecture_processor.services import study_library_service as library
from lecture_processor.services import study_picture_service as pictures
from lecture_processor.services.study_run_service import fingerprint
from tests.credit_test_support import make_credit_runtime


def make_editor(monkeypatch):
    runtime, store = make_credit_runtime(users={'owner': {'study_pictures_enabled': True}})
    runtime.db.document = lambda path: runtime.db.collection(path.rsplit('/', 1)[0]).document(path.rsplit('/', 1)[1])
    runtime.jsonify = jsonify
    runtime.FEATURE_AUDIO_SECTION_SYNC = False
    runtime.repositories = SimpleNamespace(study=study_repo)
    runtime.sanitize_flashcards = study_generation.sanitize_flashcards
    runtime.sanitize_questions = study_generation.sanitize_questions
    store.documents[('study_packs', 'pack')] = {
        'uid': 'owner', 'title': 'Original title', 'course': 'Original course',
        'notes_markdown': '# Original notes',
        'flashcards': runtime.sanitize_flashcards([
            {'front': 'Question one?', 'back': 'Answer one'},
            {'front': 'Question two?', 'back': 'Answer two'},
        ], 500),
        'test_questions': runtime.sanitize_questions([
            {'question': 'Which item is first?', 'options': ['One', 'Two', 'Three', 'Four'],
             'answer': 'One', 'explanation': 'Original first explanation'},
            {'question': 'Which item is second?', 'options': ['One', 'Two', 'Three', 'Four'],
             'answer': 'Two', 'explanation': 'Original second explanation'},
        ], 500),
    }
    monkeypatch.setattr(firestore, 'transactional', store.transactional)
    monkeypatch.setattr(access_service, 'require_allowed_user', lambda *_, **_kwargs: ({'uid': 'owner'}, None, 0))
    monkeypatch.setattr(access_service, 'account_write_guard', lambda *_: None)
    monkeypatch.setattr(library.study_audio, 'ensure_pack_audio_storage_key', lambda *_args, **_kwargs: '')
    monkeypatch.setattr(library.study_audio, 'get_audio_storage_key_from_pack', lambda *_args, **_kwargs: '')
    monkeypatch.setattr(library.study_audio, 'audio_storage_key_has_file', lambda *_args, **_kwargs: False)
    state = SimpleNamespace(runtime=runtime, store=store, files={}, deleted_objects=[])

    def private_storage(method, path, *_args, **_kwargs):
        assert method == 'DELETE', 'This test permits only synthetic picture cleanup'
        state.deleted_objects.append(path)
        state.files.pop(path, None)

    monkeypatch.setattr(pictures.book_storage, 'request', private_storage)
    with Flask(__name__).app_context():
        yield state


def pack(state):
    return deepcopy(state.store.documents[('study_packs', 'pack')])


def response(result):
    reply, status = result if isinstance(result, tuple) else (result, result.status_code)
    return status, reply.get_json()


def read_draft(state):
    status, draft = response(library.get_study_pack(state.runtime, None, 'pack'))
    assert status == 200
    # Derive the existing content fingerprint so the behavioral baseline can
    # run before the read API exposes its equivalent editor revision token.
    return draft, draft.get('content_revision', fingerprint(draft))


def replace(state, revision, **fields):
    request = SimpleNamespace(get_json=lambda **_: deepcopy({'base_content_revision': revision, **fields}))
    return response(library.update_study_pack(state.runtime, request, 'pack'))


def patch(state, **fields):
    request = SimpleNamespace(get_json=lambda **_: deepcopy(fields))
    return response(library.update_study_pack(state.runtime, request, 'pack'))


def add_picture(state, character):
    image_id = character * 64
    asset = {
        'id': image_id, 'uid': 'owner', 'pack_id': 'pack', 'ready': True,
        'generation': 'synthetic-' + character,
        'path': f'private/{image_id}.png', 'preview_path': f'private/{image_id}-preview.png', 'size': 20,
    }
    state.store.documents[('study_images', image_id)] = asset
    budget = state.store.documents.setdefault(('book_usage', 'storage'), {'bytes': 0})
    budget['bytes'] += asset['size']
    state.files[asset['path']] = b'image bytes'
    state.files[asset['preview_path']] = b'preview bytes'
    return image_id
