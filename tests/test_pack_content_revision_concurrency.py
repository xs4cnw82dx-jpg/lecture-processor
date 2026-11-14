"""Concurrent editor baselines against real pack/picture commits and synthetic storage."""

from copy import deepcopy
from types import SimpleNamespace

from flask import Flask, jsonify
from google.cloud import firestore
import pytest

from lecture_processor.domains.ai import study_generation
from lecture_processor.repositories import study_repo
from lecture_processor.services import study_library_service as library
from lecture_processor.services import study_picture_service as pictures
from lecture_processor.services.study_run_service import fingerprint
from tests.credit_test_support import make_credit_runtime


@pytest.fixture
def editor(monkeypatch):
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
    monkeypatch.setattr(library.study_api_support, 'require_user', lambda *_: ({'uid': 'owner'}, None, 0))
    monkeypatch.setattr(library.study_api_support, 'account_write_guard', lambda *_: None)
    monkeypatch.setattr(library.study_audio, 'ensure_pack_audio_storage_key', lambda *_args, **_kwargs: '')
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


def interleave_after_snapshot(monkeypatch, state, second):
    """Commit the other request after the first handler read but before its transaction."""
    replies = []

    def run_other_request(*_args, **_kwargs):
        monkeypatch.setattr(library.study_audio, 'ensure_pack_audio_storage_key', lambda *_a, **_k: '')
        replies.append(second())
        return ''

    monkeypatch.setattr(library.study_audio, 'ensure_pack_audio_storage_key', run_other_request)
    return replies


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


@pytest.mark.parametrize(('field', 'edited_field'), [('flashcards', 'back'), ('test_questions', 'explanation')])
def test_overlapping_whole_array_edits_reject_the_stale_draft(editor, monkeypatch, field, edited_field):
    draft, revision = read_draft(editor)
    first, second = deepcopy(draft[field]), deepcopy(draft[field])
    first[0][edited_field] = 'First editor change'
    second[1][edited_field] = 'Second editor change'
    other = interleave_after_snapshot(monkeypatch, editor, lambda: replace(editor, revision, **{field: second}))

    status, _payload = replace(editor, revision, **{field: first})

    assert other[0][0] == 200
    assert {'status': status, 'saved': pack(editor)[field]} == {'status': 409, 'saved': second}


def test_image_only_concurrent_edit_invalidates_a_replacement_draft(editor, monkeypatch):
    image_id = add_picture(editor, 'a')
    draft, revision = read_draft(editor)
    first, second = deepcopy(draft['flashcards']), deepcopy(draft['flashcards'])
    first[0]['back'] = 'First editor answer'
    second[1]['image_ids'] = [image_id]
    other = interleave_after_snapshot(monkeypatch, editor, lambda: replace(editor, revision, flashcards=second))

    status, _payload = replace(editor, revision, flashcards=first)

    assert other[0][0] == 200
    assert {'status': status, 'saved': pack(editor)['flashcards']} == {'status': 409, 'saved': second}


def test_stale_replacement_has_no_picture_cleanup_side_effects(editor):
    image_id = add_picture(editor, 'b')
    editor.store.documents[('study_packs', 'pack')]['flashcards'][0]['image_ids'] = [image_id]
    draft, revision = read_draft(editor)
    stale = deepcopy(draft['flashcards'])
    stale[0].pop('image_ids')
    assert replace(editor, revision, notes_markdown='# Another editor updated the notes')[0] == 200
    before_pack = pack(editor)
    before_assets = editor.store.docs('study_images')
    before_files = dict(editor.files)
    before_budget = editor.store.docs('book_usage')
    commits_before = len(editor.store.commits)

    status, _payload = replace(editor, revision, flashcards=stale)

    picture_writes = [ref.path for operations in editor.store.commits[commits_before:]
                      for _operation, ref, _payload, _merge in operations
                      if ref.path[0] in {'study_images', 'book_usage'}]
    assert {
        'status': status, 'pack': pack(editor), 'assets': editor.store.docs('study_images'),
        'files': editor.files, 'budget': editor.store.docs('book_usage'),
        'storage_deletes': editor.deleted_objects, 'picture_writes': picture_writes,
    } == {
        'status': 409, 'pack': before_pack, 'assets': before_assets,
        'files': before_files, 'budget': before_budget, 'storage_deletes': [], 'picture_writes': [],
    }


def test_overlapping_independent_scalar_edits_still_merge(editor, monkeypatch):
    other = interleave_after_snapshot(monkeypatch, editor, lambda: patch(editor, course='Other editor course'))

    assert patch(editor, title='First editor title')[0] == 200

    assert other[0][0] == 200
    saved = pack(editor)
    assert (saved['title'], saved['course']) == ('First editor title', 'Other editor course')


@pytest.mark.parametrize('independent', [
    {'course': 'Independent course'},
    {'notes_highlights': {'base_key': 'pack:notes:synthetic', 'updated_at': 1000,
                          'ranges': [{'start': 0, 'end': 3, 'color': 'yellow'}]}},
], ids=['metadata', 'highlights'])
def test_content_edit_does_not_conflict_with_independent_fields(editor, monkeypatch, independent):
    draft, revision = read_draft(editor)
    cards = deepcopy(draft['flashcards'])
    cards[0]['back'] = 'New saved answer'
    other = interleave_after_snapshot(monkeypatch, editor, lambda: patch(editor, **independent))

    assert replace(editor, revision, flashcards=cards)[0] == 200

    assert other[0][0] == 200
    saved = pack(editor)
    assert saved['flashcards'] == cards
    for key, value in independent.items():
        assert saved[key] == value
