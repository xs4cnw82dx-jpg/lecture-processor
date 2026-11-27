"""Concurrent editor baselines against real pack/picture commits and synthetic storage."""

from copy import deepcopy

import pytest

from lecture_processor.repositories.books_repo import BookStore
from tests.support.pack_content_revision_concurrency import (
    add_picture,
    pack,
    patch,
    read_draft,
    replace,
)


def interleave_after_snapshot(monkeypatch, state, second):
    """Commit a competing edit after request preparation but before the write transaction."""
    replies = []
    atomic = BookStore.atomic

    def interleave(db, operation):
        monkeypatch.setattr(BookStore, 'atomic', atomic)
        replies.append(second())
        return atomic(db, operation)

    monkeypatch.setattr(BookStore, 'atomic', interleave)
    return replies


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
