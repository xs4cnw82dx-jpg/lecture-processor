from types import SimpleNamespace
from unittest.mock import Mock
import time

import pytest

from tests.test_elearning_api import MemoryStore


@pytest.fixture
def accounts(tmp_path, monkeypatch):
    from scripts.academy_preview import academy_preview
    from lecture_processor.services import academy_accounts as service

    with academy_preview(tmp_path / 'synthetic-firebase.json') as app, monkeypatch.context() as patches:
        store = MemoryStore()
        patches.setattr(service, 'ElearningStore', lambda _db: store)
        patches.setattr(service.studio, '_store', lambda _runtime: store)
        user = dict(uid='author-1', email='author@example.test', email_verified=True, auth_time=time.time())
        runtime = app.extensions['lecture_processor']['runtime']
        patches.setattr(runtime, 'decode_identity', lambda req: user if req.headers.get('Authorization') else None)
        admin = SimpleNamespace(uid='studio-owner', email='studio@example.test', email_verified=True, disabled=False)
        profile = SimpleNamespace(user_metadata=SimpleNamespace(creation_timestamp=1, last_sign_in_timestamp=2), provider_data=[])
        patches.setattr(service.auth, 'get_user', lambda uid, *, app: admin if uid == 'studio-owner' else profile)
        remote = Mock()
        patches.setattr(service, '_delete_signin', remote)
        yield app.test_client(), store, user, remote, runtime


def submit(client, uid='author-1'):
    return client.post('/api/academy/account/delete', json={'confirmUid': uid},
                       headers={'Authorization': 'Bearer synthetic-user-token'})


def test_transfers_live_courses_and_preserves_learner_materials(accounts):
    client, store, user, remote, _ = accounts
    email = user['email']
    from lecture_processor.services.elearning_service import _author_key
    course = {'id': 'one', 'owner_uid': user['uid'], 'owner_email': email, 'share': {'token': 'published', 'enabled': True},
              'lease': {'user_id': user['uid']}, 'members': {'third@test.com': 'edit'}, 'modules': [{'id': 'mod'}]}
    store.put('elearning_expeditions/one', course)
    store.put('elearning_expeditions/two', {'owner_uid': 'other', 'members': {email: 'edit'}, 'member_emails': [email]})
    store.put('elearning_expeditions/leased', {'owner_uid': 'someone', 'lease': {'user_id': user['uid'], 'name': email}})
    store.put('elearning_share_index/published', {'expedition_id': 'one'})
    store.put('elearning_responses/session', {'expedition_id': 'one', 'answer': 'synthetic'})
    store.put('elearning_assets/image', {'expedition_id': 'one', 'uploaded_by': user['uid'], 'path': 'test/image.webp'})
    store.put('academy_users/author-1/folders/personal', {'name': 'Private drafts'})
    store.put(_author_key(email), {'email': email})
    store.put('users/author-1', {'email': email})
    learner_path = '/api/elearning/public/published'
    player_before = client.get(learner_path)
    assert player_before.status_code == 200
    remote.side_effect = [service_error(), None]
    first = submit(client)
    assert first.status_code == 503
    assert submit(client).json == {'complete': True}
    assert client.get(learner_path).json == player_before.json
    moved = store.get('elearning_expeditions/one')
    assert moved['owner_uid'] == 'studio-owner' and moved['owner_email'] == 'studio@example.test'
    assert moved['folder_id'] == 'account-review' and not moved['lease']
    assert moved['share'] == course['share'] and moved['modules'] == course['modules'] and moved['members'] == course['members']
    assert store.get('elearning_expeditions/two')['members'] == {}
    assert not store.get('elearning_expeditions/leased')['lease']
    assert store.get('elearning_assets/image') == {'expedition_id': 'one', 'path': 'test/image.webp'}
    assert store.get('elearning_responses/session')['answer'] == 'synthetic'
    assert store.get('elearning_share_index/published') == {'expedition_id': 'one'}
    assert store.get('academy_users/studio-owner/folders/account-review') == {'name': 'Account review'}
    for path in ['academy_users/author-1/folders/personal', _author_key(email), 'users/author-1']:
        assert store.get(path) is None
    assert store.get('account_deletions/author-1') == {'status': 'deleted'}
    assert remote.call_count == 2


def service_error():
    from lecture_processor.domains.elearning.model import ElearningError
    return ElearningError('Please try again.', 503)


def test_refuses_stale_signin_wrong_confirmation_and_admin_deletion(accounts):
    client, store, claims, remote, _ = accounts
    assert client.post('/api/academy/account/delete', json={'confirmUid': 'author-1'}).status_code == 401
    assert submit(client, 'other-account').status_code == 400
    claims['auth_time'] = time.time() - 600
    assert submit(client).status_code == 403
    claims.update(uid='studio-owner', email='studio@example.test', auth_time=time.time())
    assert submit(client, 'studio-owner').status_code == 409
    assert not store.data
    remote.assert_not_called()


def test_requires_a_verified_admin_before_starting_transfer(accounts, monkeypatch):
    from lecture_processor.services import academy_accounts as service
    client, store, claims, remote, _ = accounts
    monkeypatch.setattr(service.auth, 'get_user', lambda *_args, **_kwargs: SimpleNamespace(
        uid='studio-owner', email='studio@example.test', email_verified=False, disabled=False))
    store.put('elearning_expeditions/one', {'owner_uid': claims['uid']})
    assert submit(client).status_code == 503
    assert not store.get('account_deletions/author-1')
    assert store.get('elearning_expeditions/one')['owner_uid'] == claims['uid']
    remote.assert_not_called()


def test_verified_address_ownership_is_required_to_remove_invites(accounts):
    from lecture_processor.services.elearning_service import _author_key
    client, store, user, _, _ = accounts
    user['email_verified'] = False
    store.put(_author_key(user['email']), {'email': user['email']})
    assert submit(client).json == {'complete': True}
    assert store.get(_author_key(user['email']))


def test_export_is_scoped_to_the_requesting_identity(accounts):
    client, store, claims, remote, _ = accounts
    store.put('academy_users/author-1/folders/private', {'name': 'My drafts'})
    store.put('elearning_expeditions/own', {'owner_uid': claims['uid'], 'title': 'My course', 'share': {'token': 'SECRET'}})
    store.put('elearning_expeditions/other', {'owner_uid': 'other', 'title': 'Private course'})
    store.put('elearning_responses/response', {'answer': 'Private response'})
    assert client.get('/api/academy/account/export').status_code == 401
    response = client.get('/api/academy/account/export', headers={'Authorization': 'Bearer synthetic-user-token'})
    assert response.status_code == 200 and response.headers['Content-Disposition'].startswith('attachment')
    assert response.json['account']['email'] == claims['email']
    assert response.json['ownedCourses'] == [{'id': 'own', 'title': 'My course'}]
    assert response.json['folders'] == [{'id': 'private', 'name': 'My drafts'}]
    assert all(value not in response.text for value in ['Private course', 'Private response', 'SECRET', 'synthetic-user-token'])
    remote.assert_not_called()


def test_multiple_requests_move_every_course_and_keep_the_review_folder(accounts):
    client, store, claims, remote, _ = accounts
    for i in range(15):
        store.put(f'elearning_expeditions/{i}', {'owner_uid': claims['uid'], 'id': str(i), 'share': {'enabled': True}})
    assert submit(client).status_code == 202
    remote.assert_not_called()
    receipt = store.get('account_deletions/author-1')
    assert receipt['admin_uid'] == 'studio-owner' and receipt['status'] == 'transferring'
    assert submit(client).json == {'complete': True}
    assert all(row['folder_id'] == 'account-review' for row in store.list('elearning_expeditions'))
    assert len(store.list('academy_users/studio-owner/folders')) == 1


def test_deletion_calls_firebase_as_the_end_user_only(monkeypatch):
    from lecture_processor.services import academy_accounts as service
    post = Mock(return_value=SimpleNamespace(status_code=200))
    monkeypatch.setattr(service.requests, 'post', post)
    monkeypatch.setenv('ACADEMY_FIREBASE_API_KEY', 'example-public-key')
    service._delete_signin('synthetic-recent-id-token')
    (url,), kwargs = post.call_args
    assert url == 'https://identitytoolkit.googleapis.com/v1/accounts:delete'
    assert kwargs['params'] == {'key': 'example-public-key'}
    assert kwargs['json'] == {'idToken': 'synthetic-recent-id-token'}
    assert kwargs['allow_redirects'] is False


def test_retry_with_another_configured_admin_stops_before_next_transfer(accounts):
    client, store, claims, remote, _ = accounts
    store.put('account_deletions/author-1', {'status': 'transferring', 'email': claims['email'], 'admin_uid': 'former-admin'})
    store.put('elearning_expeditions/one', {'owner_uid': claims['uid']})
    assert submit(client).status_code == 409
    assert store.get('elearning_expeditions/one')['owner_uid'] == claims['uid']
    remote.assert_not_called()


def test_a_new_invitation_waits_until_firebase_has_confirmed_identity_deletion(accounts, monkeypatch):
    from lecture_processor.services import elearning_service as studio
    from lecture_processor.domains.elearning.model import ElearningError
    client, db, claims, _, runtime = accounts
    uid, email = claims['uid'], claims['email']
    lock = studio.academy_removal_key(email)
    receipt = 'account_deletions/' + uid
    db.put(lock, {'uid': uid})
    db.put(receipt, {'status': 'auth_delete_pending', 'removal_key': lock})
    with client.application.test_request_context():
        monkeypatch.setattr(runtime, 'academy_identity_removed', lambda _uid: False)
        with pytest.raises(ElearningError) as pending:
            db.atomic(lambda tx: studio._allow_invitation(runtime, tx, email))
        assert pending.value.status == 409 and db.get(lock) == {'uid': uid}
        monkeypatch.setattr(runtime, 'academy_identity_removed', lambda _uid: True)
        db.atomic(lambda tx: studio._allow_invitation(runtime, tx, email))
    assert db.get(lock) is None
    assert db.get(receipt) == {'status': 'deleted'}


def test_an_empty_account_can_delete_when_no_recipient_is_available(accounts, monkeypatch):
    from lecture_processor.services import academy_accounts as service
    client, _, _, remote, _ = accounts
    destination = Mock(side_effect=AssertionError('An empty account has no courses to transfer'))
    monkeypatch.setattr(service, '_admin', destination)
    assert submit(client).json == {'complete': True}
    remote.assert_called_once()
    destination.assert_not_called()


def test_course_created_just_before_the_tombstone_is_picked_up_on_retry(accounts, monkeypatch):
    from lecture_processor.services import academy_accounts as service
    client, store, claims, remote, _ = accounts
    start = service._start

    def interleaved(*args):
        if not store.get('account_deletions/author-1'):
            store.put('elearning_expeditions/raced', {'owner_uid': claims['uid']})
        return start(*args)
    monkeypatch.setattr(service, '_start', interleaved)
    assert submit(client).status_code == 202
    remote.assert_not_called()
    assert submit(client).json == {'complete': True}
    assert store.get('elearning_expeditions/raced')['owner_uid'] == 'studio-owner'


def test_each_transfer_checks_its_recipient_is_still_available(accounts):
    client, store, claims, remote, _ = accounts
    store.put('account_deletions/author-1', {'status': 'transferring', 'email': claims['email'], 'admin_uid': 'studio-owner'})
    store.put('account_deletions/studio-owner', {'status': 'transferring'})
    store.put('elearning_expeditions/one', {'owner_uid': claims['uid']})
    assert submit(client).status_code == 409
    assert store.get('elearning_expeditions/one')['owner_uid'] == claims['uid']
    remote.assert_not_called()
