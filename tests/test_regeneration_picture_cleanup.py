"""Synthetic regeneration picture lifecycle checks against the released builder base."""

from copy import deepcopy
from types import SimpleNamespace

import pytest

from lecture_processor.domains.ai import pipelines
from lecture_processor.domains.books.model import BookError
from lecture_processor.domains.study.content_revision import fingerprint
from lecture_processor.repositories import books_repo
from lecture_processor.services import study_picture_service as pictures
from tests.credit_test_support import Reference
from tests.test_pack_background_concurrency import (
    background as background, canonical_job, pack, run_regeneration, seed_regeneration,
    writes_generated_pack,
)

KEPT = 'a' * 64
REMOVED = 'b' * 64
OLDER = 'c' * 64


def pictures_for(state, monkeypatch):
    state.store.documents[('users', 'owner')]['study_pictures_enabled'] = True
    state.runtime.db.document = lambda path: Reference(state.store, *path.split('/', 1))
    state.runtime.delete_study_pack_pictures = lambda uid, pack_id, *, image_ids: pictures.delete_for_pack(
        state.runtime, uid, pack_id, image_ids=image_ids,
    )
    monkeypatch.setattr(books_repo.firestore, 'transactional', state.store.transactional)
    monkeypatch.setattr(pictures, 'time', SimpleNamespace(time=lambda: 1000.0))
    files, deletes = {}, []
    for aid in (KEPT, REMOVED, OLDER):
        root = 'study/owner/' + aid + '/original-generation'
        asset = dict(id=aid, uid='owner', pack_id='pack', size=120, original_size=100,
                     preview_size=20, ready=True, generation='original-generation',
                     path=root + '/original', preview_path=root + '/preview.webp')
        state.store.documents[('study_images', aid)] = asset
        files[asset['path']] = b'synthetic original'
        files[asset['preview_path']] = b'synthetic preview'
    state.store.documents[('book_usage', 'storage')] = {'bytes': 360 + 900}
    original = state.store.documents[('study_packs', 'pack')]
    original['flashcards'] = [
        {'front': 'What is original?', 'back': 'Original answer', 'image_ids': [KEPT]},
        {'front': 'A removed question', 'back': 'Old answer', 'image_ids': [REMOVED, REMOVED]},
    ]
    original['picture_cleanup_pending_ids'] = [OLDER]

    def request(method, path, *_args, **_kwargs):
        assert method == 'DELETE', 'Only synthetic cleanup is expected'
        assert canonical_job(state)['status'] == 'complete', 'Cleanup must follow completion'
        deletes.append(path)
        files.pop(path, None)
        return b''

    monkeypatch.setattr(pictures.book_storage, 'request', request)
    return SimpleNamespace(files=files, deletes=deletes, request=request)


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_regeneration_removal_commits_pending_ids_then_cleans_bytes_and_budget(background, monkeypatch, scheme):
    state = background(scheme)
    images = pictures_for(state, monkeypatch)
    seed_regeneration(state)
    committed = []

    def after_commit(operations):
        if any(ref.path == ('study_packs', 'pack') and 'flashcards' in (fields or {})
               for _kind, ref, fields, _merge in operations):
            committed.append((deepcopy(pack(state)), deepcopy(canonical_job(state))))

    state.store.after_commit = after_commit
    run_regeneration(state, monkeypatch)

    assert committed[0][0]['picture_cleanup_pending_ids'] == [REMOVED, OLDER]
    assert committed[0][1]['status'] == 'complete'
    assert pack(state)['flashcards'][0]['image_ids'] == [KEPT]
    assert set(state.store.docs('study_images')) == {KEPT}
    assert len(images.deletes) == 4 and len(images.files) == 2
    assert state.store.docs('book_usage')['storage']['bytes'] == 1020
    assert pack(state)['picture_cleanup_pending_ids'] == []
    assert not state.store.docs('credit_refunds')


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_cleanup_failure_preserves_completion_and_can_resume_without_regeneration(background, monkeypatch, scheme):
    state = background(scheme)
    images = pictures_for(state, monkeypatch)
    seed_regeneration(state)
    attempts = []

    def unavailable(method, path, *_args, **_kwargs):
        attempts.append((method, path))
        raise BookError('Synthetic storage unavailable', 503)

    monkeypatch.setattr(pictures.book_storage, 'request', unavailable)
    run_regeneration(state, monkeypatch)

    assert attempts
    assert canonical_job(state)['status'] == 'complete'
    assert pack(state)['picture_cleanup_pending_ids'] == [REMOVED, OLDER]
    assert state.store.docs('book_usage')['storage']['bytes'] == 1260
    assert not state.store.docs('credit_refunds')
    monkeypatch.setattr(pictures.book_storage, 'request', images.request)
    monkeypatch.setattr(pipelines.ai_provider, 'generate_with_policy', lambda *_args, **_kwargs: pytest.fail('No second generation'))
    pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)

    assert canonical_job(state)['status'] == 'complete'
    assert set(state.store.docs('study_images')) == {KEPT}
    assert state.store.docs('book_usage')['storage']['bytes'] == 1020
    assert not state.store.docs('credit_refunds')


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_preserved_card_picture_is_never_cleaned(background, monkeypatch, scheme):
    state = background(scheme)
    images = pictures_for(state, monkeypatch)
    seed_regeneration(state)
    run_regeneration(state, monkeypatch)
    assert pack(state)['flashcards'][0]['image_ids'] == [KEPT]
    assert state.store.docs('study_images')[KEPT]['ready'] is True
    assert all(KEPT not in path for path in images.deletes)
    assert not state.store.docs('credit_refunds')


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_provider_failure_keeps_all_picture_data(background, monkeypatch, scheme):
    state = background(scheme)
    images = pictures_for(state, monkeypatch)
    original_pack, original_files = deepcopy(pack(state)), dict(images.files)
    seed_regeneration(state)
    run_regeneration(state, monkeypatch, fail=True)
    assert pack(state) == original_pack
    assert images.files == original_files and not images.deletes
    assert state.store.docs('book_usage')['storage']['bytes'] == 1260
    assert canonical_job(state)['status'] == 'error'
    assert canonical_job(state)['credit_refunded'] is True


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('failure', ['original', 'preview', 'lease'])
def test_interrupted_cleanup_retries_without_releasing_budget_early(background, monkeypatch, scheme, failure):
    state = background(scheme)
    images = pictures_for(state, monkeypatch)
    seed_regeneration(state)
    affected = state.store.documents[('study_images', REMOVED)]
    interrupted = []
    if failure == 'lease':
        affected['upload_leases'] = {'synthetic-upload': 1180.0}
    else:
        def request(method, path, *args, **kwargs):
            target = affected['path' if failure == 'original' else 'preview_path']
            if path == target and not interrupted:
                interrupted.append(path)
                raise BookError('Synthetic storage interruption', 503)
            return images.request(method, path, *args, **kwargs)
        monkeypatch.setattr(pictures.book_storage, 'request', request)

    run_regeneration(state, monkeypatch)

    assert canonical_job(state)['status'] == 'complete'
    assert pack(state)['picture_cleanup_pending_ids'] == [REMOVED, OLDER]
    assert state.store.docs('study_images')[REMOVED]['deleting'] is True
    assert state.store.docs('book_usage')['storage']['bytes'] == 1260
    assert not state.store.docs('credit_refunds')
    state.store.documents[('study_images', REMOVED)]['upload_leases'] = {}
    monkeypatch.setattr(pictures.book_storage, 'request', images.request)
    monkeypatch.setattr(pipelines.ai_provider, 'generate_with_policy', lambda *_args, **_kwargs: pytest.fail('No second generation'))
    pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)

    assert set(state.store.docs('study_images')) == {KEPT}
    assert len(images.files) == 2
    assert state.store.docs('book_usage')['storage']['bytes'] == 1020
    assert pack(state)['picture_cleanup_pending_ids'] == []
    before = deepcopy(state.store.documents), dict(images.files), list(images.deletes)
    pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)
    assert (state.store.documents, images.files, images.deletes) == before


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
@pytest.mark.parametrize('readback', [True, False], ids=['available', 'unavailable'])
def test_committed_publication_lost_ack_keeps_removal_retryable(background, monkeypatch, scheme, readback):
    state = background(scheme)
    images = pictures_for(state, monkeypatch)
    seed_regeneration(state)
    lost = []

    def after_commit(operations):
        if not writes_generated_pack(operations):
            return
        state.store.after_commit = None
        lost.append(True)
        if not readback:
            state.store.fail_reads.add(('runtime_jobs', 'regenerate'))
        raise RuntimeError('Synthetic lost acknowledgement')

    state.store.after_commit = after_commit
    run_regeneration(state, monkeypatch)

    assert lost == [True]
    assert canonical_job(state)['status'] == 'complete'
    assert not state.store.docs('credit_refunds')
    if not readback:
        assert not images.deletes
        assert pack(state)['picture_cleanup_pending_ids'] == [REMOVED, OLDER]
        assert state.store.docs('book_usage')['storage']['bytes'] == 1260
        state.store.fail_reads.clear()
        monkeypatch.setattr(pipelines.ai_provider, 'generate_with_policy', lambda *_args, **_kwargs: pytest.fail('No second generation'))
        pipelines.regenerate_study_tools_for_pack('regenerate', 'pack', runtime=state.runtime)
    assert set(state.store.docs('study_images')) == {KEPT}
    assert state.store.docs('book_usage')['storage']['bytes'] == 1020
    assert pack(state)['picture_cleanup_pending_ids'] == []


@pytest.mark.parametrize('change', ['cards', 'account', 'commit'])
def test_rejected_publication_does_not_enqueue_or_clean_pictures(background, monkeypatch, change):
    state = background()
    images = pictures_for(state, monkeypatch)
    seed_regeneration(state)
    expected = []

    def change_state():
        if change == 'cards':
            state.store.documents[('study_packs', 'pack')]['flashcards'][0]['back'] = 'Concurrent answer'
        elif change == 'account':
            state.store.documents[('users', 'owner')]['account_status'] = 'deleting'
        else:
            def reject(operations):
                if writes_generated_pack(operations):
                    state.store.before_commit = None
                    raise RuntimeError('Synthetic publication failure')
            state.store.before_commit = reject
        expected.append(deepcopy(pack(state)))

    run_regeneration(state, monkeypatch, change_state)
    assert pack(state) == expected[0]
    assert not images.deletes and len(images.files) == 6
    assert state.store.docs('book_usage')['storage']['bytes'] == 1260
    assert canonical_job(state)['status'] == 'error'


def test_pending_added_during_generation_is_included_without_changing_content_revision(background, monkeypatch):
    state = background()
    images = pictures_for(state, monkeypatch)
    state.store.documents[('study_packs', 'pack')]['picture_cleanup_pending_ids'] = []
    initial_revision = fingerprint(pack(state))
    seed_regeneration(state)

    def add_pending():
        state.store.documents[('study_packs', 'pack')]['picture_cleanup_pending_ids'] = [OLDER, OLDER]
        assert fingerprint(pack(state)) == initial_revision

    run_regeneration(state, monkeypatch, add_pending)
    assert set(state.store.docs('study_images')) == {KEPT}
    assert len(images.deletes) == 4
    assert pack(state)['picture_cleanup_pending_ids'] == []


def test_reattached_picture_before_cleanup_claim_survives(background, monkeypatch):
    state = background()
    images = pictures_for(state, monkeypatch)
    seed_regeneration(state)
    saved_revision = []

    def reattach(operations):
        if not writes_generated_pack(operations):
            return
        state.store.after_commit = None
        cards = pack(state)['flashcards']
        cards[0]['image_ids'].append(REMOVED)
        pending, revision = pictures.update_pack_and_collect_removed(state.runtime, 'owner', 'pack', {'flashcards': cards})
        saved_revision.append(revision)
        assert pending == [OLDER]

    state.store.after_commit = reattach
    run_regeneration(state, monkeypatch)

    assert pack(state)['flashcards'][0]['image_ids'] == [KEPT, REMOVED]
    assert set(state.store.docs('study_images')) == {KEPT, REMOVED}
    assert state.store.docs('study_images')[REMOVED]['ready'] is True
    assert state.store.docs('book_usage')['storage']['bytes'] == 1140
    assert len(images.deletes) == 2 and all(OLDER in path for path in images.deletes)
    assert fingerprint(pack(state)) == saved_revision[0]
    assert not state.store.docs('credit_refunds')


def test_cleanup_claim_prevents_late_reattachment(background, monkeypatch):
    state = background()
    images = pictures_for(state, monkeypatch)
    seed_regeneration(state)
    rejected = []

    def request(method, path, *args, **kwargs):
        if REMOVED in path and not rejected:
            cards = pack(state)['flashcards']
            cards[0]['image_ids'].append(REMOVED)
            with pytest.raises(BookError) as error:
                pictures.update_pack_and_collect_removed(state.runtime, 'owner', 'pack', {'flashcards': cards})
            rejected.append(error.value.status)
        return images.request(method, path, *args, **kwargs)

    monkeypatch.setattr(pictures.book_storage, 'request', request)
    run_regeneration(state, monkeypatch)
    assert rejected == [409]
    assert set(state.store.docs('study_images')) == {KEPT}
    assert pack(state)['flashcards'][0]['image_ids'] == [KEPT]
    assert state.store.docs('book_usage')['storage']['bytes'] == 1020


@pytest.mark.parametrize('change', ['missing', 'owner', 'unreadable'])
def test_pack_change_after_completion_defers_cleanup(background, monkeypatch, change):
    state = background()
    images = pictures_for(state, monkeypatch)
    seed_regeneration(state)

    def changed(operations):
        if not writes_generated_pack(operations):
            return
        state.store.after_commit = None
        if change == 'missing':
            state.store.documents.pop(('study_packs', 'pack'))
        elif change == 'owner':
            state.store.documents[('study_packs', 'pack')]['uid'] = 'other'
        else:
            state.store.fail_reads.add(('study_packs', 'pack'))

    state.store.after_commit = changed
    run_regeneration(state, monkeypatch)
    assert canonical_job(state)['status'] == 'complete'
    assert not images.deletes and len(images.files) == 6
    assert state.store.docs('book_usage')['storage']['bytes'] == 1260
    assert not state.store.docs('credit_refunds')


@pytest.mark.parametrize('scheme', ['historical', 'unified'])
def test_questions_only_regeneration_keeps_cards_and_cleans_only_existing_pending(background, monkeypatch, scheme):
    state = background(scheme)
    images = pictures_for(state, monkeypatch)
    original_cards = deepcopy(pack(state)['flashcards'])
    seed_regeneration(state)
    state.store.documents[('runtime_jobs', 'regenerate')]['study_features'] = 'test'
    run_regeneration(state, monkeypatch)
    assert pack(state)['flashcards'] == original_cards
    assert set(state.store.docs('study_images')) == {KEPT, REMOVED}
    assert len(images.deletes) == 2 and all(OLDER in path for path in images.deletes)
    assert state.store.docs('book_usage')['storage']['bytes'] == 1140
    assert not state.store.docs('credit_refunds')


def test_runtime_cleanup_adapter_passes_current_runtime_and_explicit_ids(app, monkeypatch):
    runtime = app.extensions['lecture_processor']['runtime']
    current_db = object()
    monkeypatch.setattr(runtime.core, 'db', current_db)
    seen = []

    def remove(received_runtime, uid, pack_id, *, image_ids):
        assert received_runtime is runtime.core and received_runtime.db is current_db
        seen.append((uid, pack_id, image_ids))
        return 2

    monkeypatch.setattr(pictures, 'delete_for_pack', remove)
    ids = [REMOVED, OLDER]
    assert runtime.delete_study_pack_pictures('owner', 'pack', image_ids=ids) == 2
    assert seen == [('owner', 'pack', ids)]


def test_runtime_cleanup_adapter_requires_explicit_subset(app, monkeypatch):
    runtime = app.extensions['lecture_processor']['runtime']
    monkeypatch.setattr(pictures, 'delete_for_pack', lambda *_args, **_kwargs: pytest.fail('Whole-pack deletion is not allowed'))
    with pytest.raises(TypeError):
        runtime.delete_study_pack_pictures('owner', 'pack')
    with pytest.raises(ValueError):
        runtime.delete_study_pack_pictures('owner', 'pack', image_ids=None)
