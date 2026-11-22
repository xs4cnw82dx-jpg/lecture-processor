"""Editor revision responses, commit retries and authority fences with synthetic data."""

import logging
from copy import deepcopy
from datetime import datetime, timezone
from functools import wraps
from types import SimpleNamespace

import pytest
from google.cloud import firestore

from lecture_processor.domains.study.audio import (
    audio_storage_key_has_file,
    ensure_pack_audio_storage_key,
    get_audio_storage_key_from_pack,
)
from lecture_processor.services import study_library_service as library
from lecture_processor.services.study_run_service import fingerprint
from tests.support.pack_content_revision_concurrency import (
    add_picture,
    pack,
    patch,
    read_draft,
    replace,
    response,
)

CONFLICT = 'This study pack changed elsewhere. Reload it before saving your changes.'
TOKENLESS = 'Study pack content replacement received without base_content_revision'


def assert_conflict(result, current):
    assert result == (409, {
        'error': CONFLICT, 'error_code': 'content_revision_conflict',
        'content_revision': fingerprint(current),
    })


def race_at_commit(monkeypatch, state, other):
    """Model Firestore abort/retry when another writer wins after all reads."""
    class RetryTransaction(Exception):
        pass

    original = state.store.transactional
    replies = []
    active_transactions = []

    def retryable(callback):
        @wraps(callback)
        def execute(transaction, *args, **kwargs):
            for _ in range(3):
                active_transactions.append(transaction)
                try:
                    return original(callback)(transaction, *args, **kwargs)
                except RetryTransaction:
                    # Firestore retries reset the same transaction object;
                    # BookStore's unit intentionally closes over that object.
                    transaction.operations.clear()
                finally:
                    active_transactions.pop()
            raise AssertionError('Synthetic transaction did not settle')
        return execute

    def before_commit(operations):
        if any(ref.path == ('study_packs', 'pack') for _, ref, _, _ in operations):
            transactional = any(tx.operations is operations for tx in active_transactions)
            state.store.before_commit = None
            replies.append(other())
            # An unconditional document update has no read precondition: it
            # overwrites normally. Only transactional reads cause a retry.
            if transactional:
                raise RetryTransaction()

    monkeypatch.setattr(firestore, 'transactional', retryable)
    state.store.before_commit = before_commit
    return replies


@pytest.mark.parametrize('field', ['flashcards', 'test_questions', 'notes_markdown'])
def test_second_writer_between_read_and_commit_is_rechecked_on_retry(editor, monkeypatch, field):
    draft, revision = read_draft(editor)
    first = deepcopy(draft[field])
    if field == 'notes_markdown':
        first = '# First writer notes'
    else:
        first[0]['back' if field == 'flashcards' else 'explanation'] = 'First writer answer'
    replies = race_at_commit(monkeypatch, editor, lambda: replace(editor, revision, notes_markdown='# Winning notes'))

    result = replace(editor, revision, **{field: first})

    assert replies[0][0] == 200
    saved = pack(editor)
    assert saved['notes_markdown'] == '# Winning notes'
    assert saved['flashcards'] == draft['flashcards']
    assert saved['test_questions'] == draft['test_questions']
    assert_conflict(result, saved)


@pytest.mark.parametrize('fields', [
    {'notes_markdown': '# Updated notes', 'title': 'Updated title'},
    {'flashcards': [{'front': 'New question?', 'back': 'New answer'}], 'title': 'Updated title'},
    {'title': 'Updated title'},
], ids=['plain-content-and-title', 'cards-and-title', 'metadata-only'])
def test_commit_retry_keeps_concurrent_independent_scalar_fields(editor, monkeypatch, fields):
    _, revision = read_draft(editor)
    replies = race_at_commit(monkeypatch, editor, lambda: patch(editor, course='Concurrent course'))

    status, payload = replace(editor, revision, **fields)

    assert status == replies[0][0] == 200
    saved = pack(editor)
    assert all(saved[key] == value for key, value in fields.items())
    assert saved['course'] == 'Concurrent course'
    assert payload['content_revision'] == fingerprint(saved)


@pytest.mark.parametrize('fields', [
    {'notes_markdown': '# Replacement'},
    {'flashcards': [{'front': 'New question', 'back': 'New answer'}]},
    {'title': 'New title'},
], ids=['plain-content', 'cards', 'metadata'])
@pytest.mark.parametrize('change,expected', [
    ('missing_pack', 404), ('foreign_pack', 403), ('deleting', 409),
    ('deleted', 409), ('missing_user', 409), ('tombstone', 409),
])
def test_commit_retry_rechecks_account_owner_and_existence(editor, monkeypatch, fields, change, expected):
    _, revision = read_draft(editor)

    def revoke():
        if change == 'missing_pack':
            editor.runtime.db.collection('study_packs').document('pack').delete()
        elif change == 'foreign_pack':
            editor.runtime.db.collection('study_packs').document('pack').update({'uid': 'someone-else'})
        elif change == 'missing_user':
            editor.runtime.db.collection('users').document('owner').delete()
        elif change == 'tombstone':
            editor.runtime.db.collection('account_deletions').document('owner').set({'status': 'requested'})
        else:
            editor.runtime.db.collection('users').document('owner').update({'account_status': change})
        return deepcopy(editor.store.documents)

    replies = race_at_commit(monkeypatch, editor, revoke)
    status, payload = replace(editor, revision, **fields)

    assert status == expected
    assert editor.store.documents == replies[0]
    assert editor.deleted_objects == []
    if expected == 409:
        assert payload == {'error': 'Account is unavailable.', 'status': 'account_deletion_in_progress'}
    else:
        assert payload == {'error': 'Study pack not found' if expected == 404 else 'Forbidden'}


@pytest.mark.parametrize('collection', ['users', 'account_deletions'])
def test_failed_account_read_blocks_commit_without_returning_a_content_token(editor, collection):
    _, revision = read_draft(editor)
    before = deepcopy(editor.store.documents)
    editor.store.fail_reads.add((collection, 'owner'))

    assert replace(editor, revision, notes_markdown='# Replacement') == (
        409, {'error': 'Account is unavailable.', 'status': 'account_deletion_in_progress'},
    )
    assert editor.store.documents == before
    assert editor.store.commits == []


def test_cancelled_account_deletion_still_allows_content_save(editor):
    editor.store.documents[('account_deletions', 'owner')] = {'status': 'cancelled'}
    _, revision = read_draft(editor)
    assert replace(editor, revision, notes_markdown='# Saved')[0] == 200


@pytest.mark.parametrize('token', [None, True, 1, {}, [], '', 'a' * 63, 'a' * 65, 'G' * 64, 'A' * 64, ' ' + 'a' * 64, 'a' * 64 + '\n'])
def test_malformed_supplied_token_is_fixed_400_without_writes(editor, token):
    before = deepcopy(editor.store.documents)

    assert replace(editor, token, notes_markdown='# Private proposed text') == (
        400, {'error': 'base_content_revision must be a valid content revision.',
              'error_code': 'invalid_content_revision'},
    )
    assert editor.store.documents == before
    assert editor.store.commits == []
    assert editor.deleted_objects == []


def test_revision_is_returned_for_create_get_and_each_patch_kind(editor):
    editor.runtime.datetime, editor.runtime.timezone = datetime, timezone
    request = SimpleNamespace(get_json=lambda **_: {
        'title': 'Created title', 'notes_markdown': '  # Created notes  ',
        'flashcards': [{'front': ' New question ', 'back': ' New answer '}],
    })
    status, created = response(library.create_study_pack(editor.runtime, request))
    saved = editor.store.documents[('study_packs', created['study_pack_id'])]
    assert status == 200
    assert created == {'ok': True, 'study_pack_id': created['study_pack_id'], 'content_revision': fingerprint(saved)}

    draft, original = read_draft(editor)
    assert draft['content_revision'] == fingerprint(pack(editor))
    status, metadata = patch(editor, title='Renamed')
    assert (status, metadata) == (200, {'ok': True, 'content_revision': original})
    status, edited = replace(editor, original, notes_markdown='# Edited')
    assert status == 200
    assert edited == {'ok': True, 'content_revision': fingerprint(pack(editor))}
    assert edited['content_revision'] != original
    assert read_draft(editor)[0]['content_revision'] == edited['content_revision']


def test_tokenless_replacements_stay_compatible_and_log_only_one_fixed_event_per_request(editor, monkeypatch, caplog):
    caplog.set_level(logging.INFO, logger=editor.runtime.logger.name)
    race_at_commit(monkeypatch, editor, lambda: patch(editor, title='Concurrent private title'))
    assert patch(editor, notes_markdown='# Private notes', flashcards=[{'front': 'Private front', 'back': 'Private back'}])[0] == 200
    assert patch(editor, test_questions=[])[0] == 200
    _, revision = read_draft(editor)
    assert replace(editor, revision, notes_markdown='# Next private notes')[0] == 200
    assert patch(editor, pinned=True)[0] == 200

    records = [record for record in caplog.records if record.name == editor.runtime.logger.name]
    assert [record.getMessage() for record in records] == [TOKENLESS, TOKENLESS]
    assert all(not record.args for record in records)
    assert all(not any(key in record.__dict__ for key in ('uid', 'pack_id', 'content', 'payload')) for record in records)


def test_stale_token_does_not_fence_metadata_or_highlights(editor):
    _, old = read_draft(editor)
    assert replace(editor, old, notes_markdown='# Other editor')[0] == 200
    current = fingerprint(pack(editor))
    highlights = {'base_key': 'pack:notes:synthetic', 'updated_at': 1000,
                  'ranges': [{'start': 0, 'end': 3, 'color': 'yellow'}]}

    assert replace(editor, old, title='New title', notes_highlights=highlights) == (
        200, {'ok': True, 'content_revision': current},
    )
    assert pack(editor)['notes_markdown'] == '# Other editor'
    assert pack(editor)['notes_highlights'] == highlights


def test_lost_ack_replay_conflicts_without_repeating_pack_or_picture_mutations(editor):
    image_id = add_picture(editor, 'c')
    editor.store.documents[('study_packs', 'pack')]['flashcards'][0]['image_ids'] = [image_id]
    draft, revision = read_draft(editor)
    cards = deepcopy(draft['flashcards'])
    cards[0].pop('image_ids')

    def lose_ack(operations):
        if any(ref.path == ('study_packs', 'pack') for _, ref, _, _ in operations):
            editor.store.after_commit = None
            raise RuntimeError('Synthetic lost acknowledgement')

    editor.store.after_commit = lose_ack
    assert replace(editor, revision, flashcards=cards)[0] == 500
    assert pack(editor)['flashcards'] == cards
    before = deepcopy(editor.store.documents)
    commits = len(editor.store.commits)

    assert_conflict(replace(editor, revision, flashcards=cards), pack(editor))

    assert editor.store.documents == before
    assert len(editor.store.commits) == commits
    assert editor.deleted_objects == []
    assert editor.files and editor.store.docs('book_usage')['storage']['bytes'] == 20


def test_applied_cards_plus_unknown_remote_notes_are_not_acknowledged_as_replay(editor):
    draft, old = read_draft(editor)
    cards = deepcopy(draft['flashcards'])
    cards[0]['back'] = 'Already applied edit'
    assert replace(editor, old, flashcards=cards)[0] == 200
    first = fingerprint(pack(editor))
    assert replace(editor, first, notes_markdown='# New notes from another editor')[0] == 200
    before = deepcopy(editor.store.documents)
    commits = len(editor.store.commits)

    assert_conflict(replace(editor, old, flashcards=cards), pack(editor))

    assert editor.store.documents == before
    assert len(editor.store.commits) == commits


def test_stale_picture_draft_checks_revision_before_removed_asset_validation(editor):
    image_id = add_picture(editor, 'd')
    editor.store.documents[('study_packs', 'pack')]['flashcards'][0]['image_ids'] = [image_id]
    draft, old = read_draft(editor)
    assert replace(editor, old, flashcards=[])[0] == 200
    assert not editor.store.docs('study_images')
    before = deepcopy(editor.store.documents)

    assert_conflict(replace(editor, old, flashcards=draft['flashcards']), pack(editor))

    assert editor.store.documents == before


def test_matching_revision_can_save_normalized_current_payload(editor):
    draft, revision = read_draft(editor)
    cards = deepcopy(draft['flashcards'])
    cards[0]['front'] = '  ' + cards[0]['front'] + '  '
    assert replace(editor, revision, flashcards=cards) == (200, {'ok': True, 'content_revision': revision})
    assert pack(editor)['flashcards'] == draft['flashcards']


def test_image_reference_order_and_card_order_are_content_changes(editor):
    first, second = add_picture(editor, 'e'), add_picture(editor, 'f')
    draft, revision = read_draft(editor)
    cards = deepcopy(draft['flashcards'])
    cards[0]['image_ids'] = [first, second]
    _, attached = replace(editor, revision, flashcards=cards)
    cards[0]['image_ids'].reverse()
    _, reordered_images = replace(editor, attached['content_revision'], flashcards=cards)
    cards.reverse()
    _, reordered_cards = replace(editor, reordered_images['content_revision'], flashcards=cards)

    assert len({revision, attached['content_revision'], reordered_images['content_revision'], reordered_cards['content_revision']}) == 4


def test_study_run_fingerprint_keeps_its_existing_canonical_bytes():
    current = {'notes_markdown': '# Café\nα',
               'flashcards': [{'front': 'A', 'back': 'B', 'image_ids': ['a' * 64]}],
               'test_questions': []}
    assert fingerprint(current) == '409229ce38866987efc2ca2fe4ddd80d76722f730e4554da905baa2916cac3b2'
    assert fingerprint({**current, 'title': 'New title', 'updated_at': 42,
                        'notes_highlights': {'ranges': []}, 'audio_storage_key': 'synthetic.mp3'}) == fingerprint(current)


@pytest.mark.parametrize('change', ['stale', 'deleted'])
def test_rejected_patch_does_not_hydrate_legacy_audio_or_recreate_a_pack(editor, monkeypatch, tmp_path, change):
    _, old = read_draft(editor)
    editor.runtime.STUDY_AUDIO_ROOT = str(tmp_path)
    audio = tmp_path / 'synthetic.mp3'
    audio.write_bytes(b'synthetic audio')
    editor.store.documents[('study_packs', 'pack')]['audio_storage_path'] = str(audio)
    editor.store.documents[('study_packs', 'pack')]['notes_markdown'] = '# Other editor notes'
    before = deepcopy(editor.store.documents)
    monkeypatch.setattr(library.study_audio, 'ensure_pack_audio_storage_key', ensure_pack_audio_storage_key)
    monkeypatch.setattr(library.study_audio, 'audio_storage_key_has_file', audio_storage_key_has_file)

    def read_key(current, runtime):
        if change == 'deleted':
            editor.store.documents.pop(('study_packs', 'pack'), None)
        return get_audio_storage_key_from_pack(current, runtime=runtime)

    monkeypatch.setattr(library.study_audio, 'get_audio_storage_key_from_pack', read_key)
    result = replace(editor, old, notes_markdown='# Stale draft')

    if change == 'stale':
        assert_conflict(result, pack(editor))
    else:
        before.pop(('study_packs', 'pack'))
        assert result == (404, {'error': 'Study pack not found'})
    assert editor.store.documents == before
    assert editor.store.commits == []
    assert audio.read_bytes() == b'synthetic audio'


def test_picture_permission_is_rechecked_when_commit_retries(editor, monkeypatch):
    image_id = add_picture(editor, 'a')
    draft, revision = read_draft(editor)
    cards = deepcopy(draft['flashcards'])
    cards[0]['image_ids'] = [image_id]

    def revoke():
        editor.runtime.db.collection('users').document('owner').update({'study_pictures_enabled': False})
        return deepcopy(editor.store.documents)

    replies = race_at_commit(monkeypatch, editor, revoke)
    assert replace(editor, revision, flashcards=cards) == (
        403, {'error': 'Pictures are not enabled for this account.'},
    )
    assert editor.store.documents == replies[0]
    assert editor.deleted_objects == []
