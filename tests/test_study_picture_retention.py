"""Picture retention through actual pack handlers with fake private storage."""

from copy import deepcopy
from contextlib import contextmanager
import io
import logging
import threading
from types import SimpleNamespace

from flask import Flask, jsonify
import pytest
from PIL import Image

from lecture_processor.domains.books.model import BookError
from lecture_processor.services import study_library_service as library
from lecture_processor.services import study_picture_service as pictures
from tests.test_study_pictures import setup  # noqa: F401


class PackRef:
    def __init__(self, db, path):
        self.db = db
        self.path = path
        self.id = path.rsplit('/', 1)[-1]

    def get(self, **_kwargs):
        data = deepcopy(self.db.data.get(self.path))
        return SimpleNamespace(
            exists=data is not None, reference=self, id=self.id,
            to_dict=lambda: deepcopy(data),
        )

    def update(self, fields):
        self.db.data[self.path].update(deepcopy(fields))

    def delete(self):
        self.db.data.pop(self.path, None)


@pytest.fixture
def retention(setup, monkeypatch):  # noqa: F811
    runtime, db, files, data = setup
    state = SimpleNamespace(runtime=runtime, db=db, files=files, data=data, fail_commit=False)
    runtime.jsonify = jsonify
    runtime.logger = logging.getLogger('synthetic-picture-retention')
    runtime.time = SimpleNamespace(time=lambda: 1000.0)
    runtime.FEATURE_AUDIO_SECTION_SYNC = False
    runtime.repositories = SimpleNamespace(study=SimpleNamespace(
        study_pack_doc_ref=lambda _db, pack_id: PackRef(db, 'study_packs/' + pack_id),
        get_study_pack_doc=lambda _db, pack_id: PackRef(db, 'study_packs/' + pack_id).get(),
        study_pack_source_doc_ref=lambda _db, pack_id: PackRef(db, 'study_pack_sources/' + pack_id),
        list_study_shares_by_owner_and_entity=lambda *_args, **_kwargs: [],
    ))
    runtime.get_study_card_state_doc = lambda uid, pack_id: PackRef(db, f'study_card_states/{uid}__{pack_id}')
    monkeypatch.setattr(library.study_api_support, 'require_user', lambda *_args: ({'uid': 'owner'}, None, 0))
    monkeypatch.setattr(library.study_api_support, 'account_write_guard', lambda *_args: None)
    monkeypatch.setattr(library.study_audio, 'ensure_pack_audio_storage_key', lambda *_args, **_kwargs: '')
    monkeypatch.setattr(library.study_audio, 'audio_storage_key_has_file', lambda *_args, **_kwargs: False)
    monkeypatch.setattr(library.study_audio, 'remove_pack_audio_file', lambda *_args, **_kwargs: None)

    def commit(_runtime, _uid, _pack_id, refs):
        if state.fail_commit:
            raise RuntimeError('Synthetic pack commit failure')
        for ref in refs:
            ref.delete()

    monkeypatch.setattr(library.study_progress_service, 'delete_pack_and_progress', commit)
    image = pictures.save_image(runtime, 'owner', 'pack', data, 'synthetic.png')
    state.image_id = image['id']
    state.asset_path = 'study_images/' + image['id']
    state.asset = deepcopy(db.data[state.asset_path])
    db.data['study_packs/pack']['flashcards'] = [{'front': 'Question', 'back': 'Answer', 'image_ids': [image['id']]}]
    with Flask(__name__).app_context():
        yield state


def response_status(result):
    return result[1] if isinstance(result, tuple) else result.status_code


def update_cards(state, cards):
    request = SimpleNamespace(get_json=lambda **_kwargs: {'flashcards': cards})
    return library.update_study_pack(state.runtime, request, 'pack')


def test_pack_delete_removes_both_private_objects_and_releases_reservation(retention):
    state = retention
    assert len(state.files) == 2
    assert state.db.data['book_usage/storage']['bytes'] > 0

    assert response_status(library.delete_study_pack(state.runtime, None, 'pack')) == 200

    assert 'study_packs/pack' not in state.db.data
    assert state.files == {}
    assert state.asset_path not in state.db.data
    assert state.db.data['book_usage/storage']['bytes'] == 0


def test_dropping_last_card_reference_deletes_image_and_releases_reservation(retention):
    state = retention
    assert response_status(update_cards(state, [{'front': 'Question', 'back': 'Answer'}])) == 200

    assert state.db.data['study_packs/pack']['flashcards'] == [{'front': 'Question', 'back': 'Answer'}]
    assert state.files == {}
    assert state.asset_path not in state.db.data
    assert state.db.data['book_usage/storage']['bytes'] == 0


def test_failed_pack_commit_keeps_pack_picture_bytes_and_budget(retention):
    state = retention
    before = deepcopy(state.db.data)
    files_before = dict(state.files)
    state.fail_commit = True

    assert response_status(library.delete_study_pack(state.runtime, None, 'pack')) == 500

    assert state.db.data == before
    assert state.files == files_before


def test_image_still_used_by_another_card_is_retained(retention):
    state = retention
    reserved = state.db.data['book_usage/storage']['bytes']
    files_before = dict(state.files)
    state.db.data['study_packs/pack']['flashcards'].append({'front': 'Second', 'back': 'Answer', 'image_ids': [state.image_id]})

    assert response_status(update_cards(state, [
        {'front': 'Question', 'back': 'Answer'},
        {'front': 'Second', 'back': 'Answer', 'image_ids': [state.image_id]},
    ])) == 200

    assert state.files == files_before
    assert state.db.data['book_usage/storage']['bytes'] == reserved
    assert state.db.data[state.asset_path]['ready'] is True


@pytest.mark.parametrize('operation', ['delete-pack', 'drop-card'])
def test_partial_storage_failure_retries_committed_removal_and_releases_budget_once(retention, monkeypatch, operation):
    state = retention
    unrelated_bytes = 4096
    state.db.data['book_usage/storage']['bytes'] += unrelated_bytes
    reserved = state.db.data['book_usage/storage']['bytes']
    storage = pictures.book_storage.request
    failed = []

    def fail_first_preview_delete(method, path, *args, **kwargs):
        if method == 'DELETE' and path == state.asset['preview_path'] and not failed:
            failed.append(path)
            raise BookError('Synthetic storage outage', 503)
        return storage(method, path, *args, **kwargs)

    monkeypatch.setattr(pictures.book_storage, 'request', fail_first_preview_delete)

    def remove():
        if operation == 'delete-pack':
            return library.delete_study_pack(state.runtime, None, 'pack')
        return update_cards(state, [{'front': 'Question', 'back': 'Answer'}])

    assert response_status(remove()) == 503
    if operation == 'delete-pack':
        assert 'study_packs/pack' not in state.db.data
    else:
        assert state.db.data['study_packs/pack']['flashcards'] == [{'front': 'Question', 'back': 'Answer'}]
    assert state.asset['path'] not in state.files
    assert state.asset['preview_path'] in state.files
    assert state.db.data[state.asset_path]['ready'] is False
    assert state.db.data['book_usage/storage']['bytes'] == reserved

    assert response_status(remove()) == 200
    assert state.files == {}
    assert state.asset_path not in state.db.data
    assert state.db.data['book_usage/storage']['bytes'] == unrelated_bytes

    assert response_status(remove()) in (200, 404)
    assert state.db.data['book_usage/storage']['bytes'] == unrelated_bytes


def test_late_cleaner_cannot_remove_same_image_uploaded_again(retention, monkeypatch):
    state = retention
    storage = pictures.book_storage.request
    replacement = []
    entered = False
    reserved = state.db.data['book_usage/storage']['bytes']

    def finish_cleanup_and_replace_before_old_delete_returns(method, path, *args, **kwargs):
        nonlocal entered
        if method == 'DELETE' and not entered:
            entered = True
            assert response_status(update_cards(state, [{'front': 'Question', 'back': 'Answer'}])) == 200
            image = pictures.save_image(state.runtime, 'owner', 'pack', state.data, 'replacement.png')
            assert image['id'] == state.image_id
            replacement.append(deepcopy(state.db.data[state.asset_path]))
        return storage(method, path, *args, **kwargs)

    monkeypatch.setattr(pictures.book_storage, 'request', finish_cleanup_and_replace_before_old_delete_returns)

    assert response_status(update_cards(state, [{'front': 'Question', 'back': 'Answer'}])) == 200

    assert len(replacement) == 1
    asset = replacement[0]
    assert asset['path'] != state.asset['path']
    assert state.db.data[state.asset_path] == asset
    assert state.files[asset['path']] == state.data
    assert set(state.files) == {asset['path'], asset['preview_path']}
    assert state.db.data['book_usage/storage']['bytes'] == reserved


def test_picture_claimed_after_prevalidation_cannot_be_reattached(retention, monkeypatch):
    state = retention
    sanitize = pictures.sanitize_cards
    files_before = dict(state.files)
    reserved = state.db.data['book_usage/storage']['bytes']

    def claim_between_validation_and_pack_commit(*args, **kwargs):
        cleaned = sanitize(*args, **kwargs)
        state.db.data['study_packs/pack']['flashcards'] = []
        state.db.data['study_packs/pack']['picture_cleanup_pending_ids'] = [state.image_id]
        state.db.data[state.asset_path].update(ready=False, deleting=True)
        return cleaned

    monkeypatch.setattr(pictures, 'sanitize_cards', claim_between_validation_and_pack_commit)

    result = update_cards(state, [{'front': 'Question', 'back': 'Answer', 'image_ids': [state.image_id]}])

    assert response_status(result) == 403
    assert state.db.data['study_packs/pack']['flashcards'] == []
    assert state.db.data[state.asset_path]['ready'] is False
    assert state.files == files_before
    assert state.db.data['book_usage/storage']['bytes'] == reserved


@pytest.mark.parametrize('cleanup_fails', [False, True])
def test_pack_delete_during_upload_keeps_retryable_cleanup_until_last_write(retention, monkeypatch, cleanup_fails):
    state = retention
    storage = pictures.book_storage.request
    output = io.BytesIO()
    Image.new('RGB', (16, 16), 'blue').save(output, 'PNG')
    new_bytes = output.getvalue()
    unrelated_bytes = 4096
    state.db.data['book_usage/storage']['bytes'] += unrelated_bytes
    interrupted = []
    failed = []

    def delete_pack_before_pending_post_returns(method, path, *args, **kwargs):
        if method == 'POST' and not interrupted:
            asset = next(deepcopy(asset) for key, asset in state.db.data.items()
                         if key.startswith('study_images/') and asset.get('path') == path)
            observation = {'asset': asset}
            interrupted.append(observation)
            observation['status'] = response_status(library.delete_study_pack(state.runtime, None, 'pack'))
            observation['metadata'] = deepcopy(state.db.data.get('study_images/' + asset['id']))
            observation['reserved'] = state.db.data['book_usage/storage']['bytes']
        if (method == 'DELETE' and cleanup_fails and interrupted
                and path == interrupted[0]['asset']['path'] and not failed):
            failed.append(path)
            raise BookError('Synthetic compensation outage', 503)
        return storage(method, path, *args, **kwargs)

    monkeypatch.setattr(pictures.book_storage, 'request', delete_pack_before_pending_post_returns)

    with pytest.raises(BookError) as error:
        pictures.save_image(state.runtime, 'owner', 'pack', new_bytes, 'pending.png')

    assert len(interrupted) == 1
    observation = interrupted[0]
    asset = observation['asset']
    asset_path = 'study_images/' + asset['id']
    assert observation['status'] == 503
    assert observation['metadata']['ready'] is False
    assert observation['reserved'] == unrelated_bytes + asset['size']
    assert 'study_packs/pack' not in state.db.data
    if cleanup_fails:
        assert error.value.status == 503
        assert state.db.data[asset_path]['ready'] is False
        assert state.db.data['book_usage/storage']['bytes'] == unrelated_bytes + asset['size']
        assert asset['path'] in state.files
        assert response_status(library.delete_study_pack(state.runtime, None, 'pack')) == 200
    else:
        assert error.value.status in (404, 409)

    assert state.files == {}
    assert not any(key.startswith('study_images/') for key in state.db.data)
    assert state.db.data['book_usage/storage']['bytes'] == unrelated_bytes
    assert response_status(library.delete_study_pack(state.runtime, None, 'pack')) == 404
    assert state.db.data['book_usage/storage']['bytes'] == unrelated_bytes


def test_pack_delete_drains_multiple_metadata_pages_including_legacy_paths(retention):
    state = retention
    unrelated_bytes = 4096
    state.db.data['book_usage/storage']['bytes'] += unrelated_bytes
    for index in range(205):
        aid = f'{index:064x}'
        asset = {**state.asset, 'id': aid, 'path': f'study/owner/{aid}/original',
                 'preview_path': f'study/owner/{aid}/preview.webp'}
        asset.pop('generation', None)
        state.db.data['study_images/' + aid] = asset
        state.files[asset['path']] = state.data
        state.files[asset['preview_path']] = b'synthetic preview'
        state.db.data['book_usage/storage']['bytes'] += asset['size']

    assert response_status(library.delete_study_pack(state.runtime, None, 'pack')) == 200

    assert state.files == {}
    assert not any(key.startswith('study_images/') for key in state.db.data)
    assert state.db.data['book_usage/storage']['bytes'] == unrelated_bytes


def test_transaction_retries_do_not_repeat_storage_deletes_or_release_budget_twice(retention, monkeypatch):
    state = retention
    unrelated_bytes = 4096
    state.db.data['book_usage/storage']['bytes'] += unrelated_bytes
    atomic = state.db.atomic
    storage = pictures.book_storage.request
    delete_calls = []
    retried = []

    def replay_transaction_after_conflict(operation):
        before = deepcopy(state.db.data)
        atomic(operation)
        retried.append(True)
        state.db.data = before
        return atomic(operation)

    def record_delete(method, path, *args, **kwargs):
        if method == 'DELETE':
            delete_calls.append(path)
        return storage(method, path, *args, **kwargs)

    monkeypatch.setattr(state.db, 'atomic', replay_transaction_after_conflict)
    monkeypatch.setattr(pictures.book_storage, 'request', record_delete)

    assert response_status(update_cards(state, [{'front': 'Question', 'back': 'Answer'}])) == 200

    assert delete_calls == [state.asset['path'], state.asset['preview_path']]
    assert state.files == {}
    assert state.asset_path not in state.db.data
    assert state.db.data['book_usage/storage']['bytes'] == unrelated_bytes
    assert retried


def test_foreign_upload_lease_blocks_pack_cleanup_until_expiry(retention, monkeypatch):
    state = retention
    now = [1000.0]
    monkeypatch.setattr(pictures, 'time', SimpleNamespace(time=lambda: now[0]))
    state.db.data[state.asset_path]['upload_leases'] = {'foreign-attempt': 1180.0}
    files_before = dict(state.files)
    reserved = state.db.data['book_usage/storage']['bytes']

    assert response_status(library.delete_study_pack(state.runtime, None, 'pack')) == 503

    assert 'study_packs/pack' not in state.db.data
    assert state.files == files_before
    assert state.db.data[state.asset_path]['ready'] is False
    assert state.db.data['book_usage/storage']['bytes'] == reserved
    assert response_status(library.delete_study_pack(state.runtime, None, 'pack')) == 503
    assert state.files == files_before

    now[0] = 1181.0
    assert response_status(library.delete_study_pack(state.runtime, None, 'pack')) == 200
    assert state.files == {}
    assert state.asset_path not in state.db.data
    assert state.db.data['book_usage/storage']['bytes'] == 0


def test_expired_foreign_upload_lease_allows_cleanup(retention, monkeypatch):
    state = retention
    monkeypatch.setattr(pictures, 'time', SimpleNamespace(time=lambda: 1000.0))
    state.db.data[state.asset_path]['upload_leases'] = {'crashed-attempt': 999.0}

    assert response_status(library.delete_study_pack(state.runtime, None, 'pack')) == 200

    assert state.files == {}
    assert state.asset_path not in state.db.data
    assert state.db.data['book_usage/storage']['bytes'] == 0


@contextmanager
def held_picture_upload(state, monkeypatch):
    """Hold a real upload at private storage while its heartbeat keeps running."""
    state.db.data[state.asset_path]['ready'] = False
    state.files.clear()
    now = [1000.0]
    condition = threading.Condition(threading.RLock())
    started = threading.Event()
    release = threading.Event()
    results = []
    errors = []
    transactions = []
    observed_tokens = []
    atomic = state.db.atomic
    put = state.db.put
    storage = pictures.book_storage.request

    def serialized_atomic(operation):
        with condition:
            transactions.append(True)
            return atomic(operation)

    def notify_put(path, value):
        put(path, value)
        with condition:
            condition.notify_all()

    def hold_first_post(method, path, *args, **kwargs):
        if method == 'POST':
            with condition:
                observed_tokens.append(set(state.db.data[state.asset_path].get('upload_leases', {})))
            if not started.is_set():
                started.set()
                assert release.wait(3), 'Synthetic upload gate was not released'
        return storage(method, path, *args, **kwargs)

    def run():
        try:
            results.append(pictures.save_image(state.runtime, 'owner', 'pack', state.data, 'held.png'))
        except BaseException as error:
            errors.append(error)

    monkeypatch.setattr(pictures, 'time', SimpleNamespace(time=lambda: now[0]))
    monkeypatch.setattr(pictures, 'UPLOAD_HEARTBEAT_SECONDS', 0.01, raising=False)
    monkeypatch.setattr(state.db, 'atomic', serialized_atomic)
    monkeypatch.setattr(state.db, 'put', notify_put)
    monkeypatch.setattr(pictures.book_storage, 'request', hold_first_post)
    worker = threading.Thread(target=run, name='synthetic-picture-upload')
    worker.start()
    try:
        assert started.wait(2), errors
        yield SimpleNamespace(now=now, condition=condition, release=release, worker=worker,
                              results=results, errors=errors, transactions=transactions,
                              observed_tokens=observed_tokens)
    finally:
        release.set()
        worker.join(2)
        assert not worker.is_alive()


def test_upload_heartbeat_renews_persisted_lease_and_stops_on_return(retention, monkeypatch):
    state = retention
    with held_picture_upload(state, monkeypatch) as pending:
        with pending.condition:
            leases = dict(state.db.data[state.asset_path].get('upload_leases', {}))
            assert len(leases) == 1
            token, previous_expiry = next(iter(leases.items()))
            for _ in range(3):
                pending.now[0] += 60
                assert pending.condition.wait_for(
                    lambda: state.db.data[state.asset_path]['upload_leases'].get(token, 0) > previous_expiry,
                    timeout=1,
                )
                previous_expiry = state.db.data[state.asset_path]['upload_leases'][token]
                assert previous_expiry > pending.now[0]
        pending.release.set()
        pending.worker.join(2)
        assert not pending.worker.is_alive()
        assert pending.errors == []
        assert len(pending.results) == 1
        assert state.db.data[state.asset_path]['ready'] is True
        assert state.db.data[state.asset_path].get('upload_leases', {}) == {}
        completed = deepcopy(state.db.data)
        transaction_count = len(pending.transactions)
        pending.now[0] += 1000
        assert not threading.Event().wait(0.05)
        assert state.db.data == completed
        assert len(pending.transactions) == transaction_count


def test_duplicate_upload_finish_releases_only_its_own_persisted_lease(retention, monkeypatch):
    state = retention
    reserved = state.db.data['book_usage/storage']['bytes']
    with held_picture_upload(state, monkeypatch) as pending:
        with pending.condition:
            first_tokens = set(state.db.data[state.asset_path].get('upload_leases', {}))
        assert len(first_tokens) == 1

        image = pictures.save_image(state.runtime, 'owner', 'pack', state.data, 'duplicate.png')

        assert image['id'] == state.image_id
        assert any(len(tokens) == 2 for tokens in pending.observed_tokens)
        assert set(state.db.data[state.asset_path]['upload_leases']) == first_tokens
        assert state.db.data['book_usage/storage']['bytes'] == reserved
        # Another request may have completed the shared asset, but this first
        # writer still needs a lease until its own storage request returns.
        with pending.condition:
            token = next(iter(first_tokens))
            previous_expiry = state.db.data[state.asset_path]['upload_leases'][token]
            assert state.db.data[state.asset_path]['ready'] is True
            pending.now[0] += 240
            assert pending.condition.wait_for(
                lambda: state.db.data[state.asset_path]['upload_leases'].get(token, 0) > previous_expiry,
                timeout=1,
            )
            assert state.db.data[state.asset_path]['upload_leases'][token] > pending.now[0]
        pending.release.set()
        pending.worker.join(2)
        assert not pending.worker.is_alive()
        assert pending.errors == []
        assert state.db.data[state.asset_path].get('upload_leases', {}) == {}
        assert state.db.data['book_usage/storage']['bytes'] == reserved


def test_final_deletion_claim_cannot_be_renewed_or_revived(retention, monkeypatch):
    state = retention
    monkeypatch.setattr(pictures, 'time', SimpleNamespace(time=lambda: 1000.0))
    state.db.data[state.asset_path].update(
        ready=False, deleting=True, delete_started=True, upload_leases={'late-attempt': 1180.0},
    )
    before = deepcopy(state.db.data)

    assert pictures._renew_upload_lease(state.db, state.asset, 'late-attempt', allow_deleting=True) is False

    assert state.db.data == before
