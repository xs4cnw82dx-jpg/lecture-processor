"""Truthful picture cleanup responses with synthetic private storage."""

from copy import deepcopy
import io
from types import SimpleNamespace

from PIL import Image
import pytest

from lecture_processor.domains.books.model import BookError
from lecture_processor.services import account_data_service as accounts
from lecture_processor.services import study_library_service as library
from lecture_processor.services import study_picture_service as pictures
from tests.credit_test_support import make_credit_runtime
from tests.test_study_picture_retention import retention as retention
from tests.test_study_picture_retention import response_status, update_cards
from tests.test_study_pictures import setup as setup


def _payload(result):
    return (result[0] if isinstance(result, tuple) else result).get_json()


def _pending(state):
    state.db.data['study_packs/pack'].update(flashcards=[], picture_cleanup_pending_ids=[state.image_id])


@pytest.mark.parametrize('change', ['notes', 'pin', 'cards'])
@pytest.mark.parametrize('failure', ['storage', 'lease'])
def test_committed_patch_succeeds_and_keeps_picture_cleanup_retryable(retention, monkeypatch, caplog, change, failure):
    state = retention
    if change != 'cards':
        _pending(state)
    storage = pictures.book_storage.request
    fail = [True]

    def request(method, path, *args, **kwargs):
        if method == 'DELETE' and fail[0]:
            raise BookError('Synthetic storage failure', 503)
        return storage(method, path, *args, **kwargs)

    if failure == 'storage':
        monkeypatch.setattr(pictures.book_storage, 'request', request)
    else:
        monkeypatch.setattr(pictures, 'time', SimpleNamespace(time=lambda: 1000.0))
        state.db.data[state.asset_path]['upload_leases'] = {'other-process': 1180.0}
    before = state.db.data['book_usage/storage']['bytes']
    fields = {'notes': {'notes_markdown': 'New synthetic notes'}, 'pin': {'pinned': True},
              'cards': {'flashcards': [{'front': 'New question', 'back': 'New answer'}]}}[change]
    response = library.update_study_pack(state.runtime, SimpleNamespace(get_json=lambda **_: fields), 'pack')
    assert response_status(response) == 200
    assert _payload(response) == {'ok': True}
    pack = state.db.data['study_packs/pack']
    assert all(pack[key] == value for key, value in fields.items())
    assert pack['picture_cleanup_pending_ids'] == [state.image_id]
    assert state.db.data[state.asset_path]['deleting'] is True
    assert state.db.data['book_usage/storage']['bytes'] == before
    assert state.files
    assert 'cleanup' in caplog.text.lower()
    fail[0] = False
    state.db.data[state.asset_path]['upload_leases'] = {}
    retry = library.update_study_pack(state.runtime, SimpleNamespace(get_json=lambda **_: {'pinned': False}), 'pack')
    assert response_status(retry) == 200
    assert not state.files and state.asset_path not in state.db.data
    assert state.db.data['book_usage/storage']['bytes'] == 0
    assert state.db.data['study_packs/pack']['picture_cleanup_pending_ids'] == []


def test_pack_delete_explains_committed_removal_and_can_retry_cleanup(retention, monkeypatch):
    state = retention
    storage = pictures.book_storage.request
    fail = [True]

    def request(method, path, *args, **kwargs):
        if method == 'DELETE' and fail[0]:
            raise BookError('Synthetic storage failure', 503)
        return storage(method, path, *args, **kwargs)

    monkeypatch.setattr(pictures.book_storage, 'request', request)
    response = library.delete_study_pack(state.runtime, None, 'pack')
    assert response_status(response) == 503
    assert _payload(response) == {
        'error': 'The study pack was deleted, but picture cleanup is still pending. Please try deleting it again.',
        'error_code': 'study_pack_cleanup_pending', 'deleted': True,
    }
    assert 'study_packs/pack' not in state.db.data
    assert state.db.data[state.asset_path]['deleting'] is True
    assert state.files and state.db.data['book_usage/storage']['bytes'] > 0
    fail[0] = False
    assert response_status(library.delete_study_pack(state.runtime, None, 'pack')) == 200
    assert not state.files and state.asset_path not in state.db.data
    assert state.db.data['book_usage/storage']['bytes'] == 0


@pytest.mark.parametrize('outcome', ['success', 'error'])
@pytest.mark.parametrize('cleanup_error', [BookError('Synthetic cleanup outage', 503), RuntimeError('Synthetic cleanup failure')])
def test_upload_final_cleanup_preserves_the_original_outcome(retention, monkeypatch, caplog, outcome, cleanup_error):
    state = retention
    original_drop = pictures._drop_upload_lease
    storage = pictures.book_storage.request
    primary_errors = []
    original_save = pictures._save_image
    entered = []

    def save(*args, **kwargs):
        try:
            return original_save(*args, **kwargs)
        except Exception as error:
            primary_errors.append(error)
            raise

    def drop(*args):
        original_drop(*args)
        if outcome == 'success':
            # Another removal commits just after this upload returned its result.
            update_cards(state, [])

    def request(method, path, *args, **kwargs):
        if method == 'POST' and outcome == 'error' and not entered:
            entered.append(path)
            library.delete_study_pack(state.runtime, None, 'pack')
        if method == 'DELETE':
            raise cleanup_error
        return storage(method, path, *args, **kwargs)

    monkeypatch.setattr(pictures, '_save_image', save)
    monkeypatch.setattr(pictures, '_drop_upload_lease', drop)
    monkeypatch.setattr(pictures.book_storage, 'request', request)
    if outcome == 'success':
        result = pictures.save_image(state.runtime, 'owner', 'pack', state.data, 'synthetic.png')
        assert result['id'] == state.image_id
        assert primary_errors == []
    else:
        output = io.BytesIO()
        Image.new('RGB', (16, 16), 'blue').save(output, 'PNG')
        with pytest.raises(BookError) as raised:
            pictures.save_image(state.runtime, 'owner', 'pack', output.getvalue(), 'second.png')
        assert primary_errors and raised.value is primary_errors[0]
        assert raised.value.status in (404, 409)
    assert 'cleanup' in caplog.text.lower()
    assert state.db.data['book_usage/storage']['bytes'] > 0
    assert any(key.startswith('study_images/') for key in state.db.data)
    assert not pictures._UPLOADS


@pytest.mark.parametrize('state_name', ['removing', 'pending', 'foreign-owner', 'foreign-pack', 'unfinished'])
def test_picture_attachment_distinguishes_owned_removal_from_foreign_assets(retention, state_name):
    state = retention
    asset = state.db.data[state.asset_path]
    if state_name in ('removing', 'pending'):
        _pending(state)
        asset.update(ready=state_name == 'pending', deleting=state_name == 'removing')
    elif state_name.startswith('foreign'):
        asset.update(deleting=True, ready=False)
        asset['uid' if state_name == 'foreign-owner' else 'pack_id'] = 'other'
    else:
        asset.update(ready=False, deleting=False)
    before = deepcopy(state.db.data)
    result = update_cards(state, [{'front': 'Question', 'back': 'Answer', 'image_ids': [state.image_id]}])
    owned_removal = state_name in ('removing', 'pending')
    assert response_status(result) == (409 if owned_removal else 403)
    assert _payload(result)['error'] == (
        'This picture is being removed; add it again shortly.' if owned_removal
        else 'This picture does not belong to this study pack.'
    )
    assert state.db.data == before


def test_account_deletion_live_picture_lease_explains_delay_then_finishes_on_retry(retention, core, client, monkeypatch):
    state = retention
    credit_runtime, store = make_credit_runtime(users={'owner': {
        'uid': 'owner', 'email': 'owner@example.test', 'account_status': 'active',
    }})
    monkeypatch.setattr(core, 'db', credit_runtime.db)
    monkeypatch.setattr(core.firestore, 'transactional', credit_runtime.firestore.transactional)
    monkeypatch.setattr(accounts.access_service, 'require_recent_allowed_user', lambda *_args, **_kwargs: (
        {'uid': 'owner', 'email': 'owner@example.test'}, None, 0,
    ))
    monkeypatch.setattr(accounts, '_account_action_rate_limit', lambda *_args: None)
    monkeypatch.setattr('lecture_processor.services.book_account_service.delete_owned', lambda *_args: 0)
    monkeypatch.setattr('lecture_processor.services.calendar_sync_service.delete_account_connection', lambda *_args: None)
    deleted_users = []
    monkeypatch.setattr(core.auth, 'delete_user', lambda uid: deleted_users.append(uid))
    now = [1000.0]
    monkeypatch.setattr(pictures, 'time', SimpleNamespace(time=lambda: now[0]))
    state.db.data[state.asset_path]['upload_leases'] = {'crashed-process': 1180.0}
    body = {'confirm_text': 'DELETE MY ACCOUNT', 'confirm_email': 'owner@example.test'}

    response = client.post('/api/account/delete', json=body)
    assert response.status_code == 503
    assert response.get_json() == {
        'error': 'A picture upload is still finishing. Please try deleting your account again in a few minutes.',
        'error_code': 'account_deletion_picture_upload_pending', 'status': 'deletion_retry_required',
    }
    assert store.docs('account_deletions')['owner']['status'] == 'retry_required'
    assert deleted_users == []
    assert state.files and state.asset_path in state.db.data
    assert state.db.data['book_usage/storage']['bytes'] > 0

    now[0] = 1181.0
    response = client.post('/api/account/delete', json=body)
    assert response.status_code == 200
    assert response.get_json()['ok'] is True
    assert deleted_users == ['owner']
    assert store.docs('account_deletions')['owner']['status'] == 'deleted'
    assert 'owner' not in store.docs('users')
    assert not state.files and state.asset_path not in state.db.data
    assert state.db.data['book_usage/storage']['bytes'] == 0
