"""Personal Academy library organization, access boundaries, and retryable cleanup."""
import pytest

from lecture_processor.services import elearning_service as studio
from scripts.academy_preview import academy_preview
from tests.test_elearning_api import MemoryStore


@pytest.fixture()
def library(tmp_path, monkeypatch):
    db = MemoryStore()
    monkeypatch.setattr(studio, '_store', lambda _rt: db)
    monkeypatch.setattr(studio.lifecycle, 'ensure_account_allows_writes', lambda *_a, **_kw: (True, ''))
    with academy_preview(tmp_path / 'firebase.json') as app:
        runtime = app.extensions['lecture_processor']['runtime']
        def verify(req):
            uid = req.headers['Authorization'].removeprefix('Bearer ')
            return {'uid': uid, 'email': uid + '@example.test', 'email_verified': True}
        monkeypatch.setattr(runtime, 'verify_firebase_token', verify)
        for uid in ('author', 'other'):
            email = uid + '@example.test'
            db.put(studio._author_key(email), {'email': email})
        yield app.test_client(), db


def headers(uid='author'):
    return {'Authorization': 'Bearer ' + uid}


API = '/api/academy/folders'
COURSES = '/api/elearning/expeditions'
MOVE = '/api/academy/expeditions/lesson/folder'
LESSON = 'elearning_expeditions/lesson'


def test_author_can_file_unfile_and_remove_a_nonempty_folder(library):
    client, db = library
    original = {'id': 'lesson', 'owner_uid': 'author', 'title': 'My lesson', 'revision': 3,
                'share': {'token': 'existing-link', 'enabled': True}, 'members': {'other@example.test': 'edit'},
                'member_emails': ['other@example.test']}
    db.put(LESSON, original)
    db.put(LESSON + '/responses/result', {'score': 4})
    response = client.post(API, json={'name': '  Winter classes  '}, headers=headers())
    assert response.status_code == 201
    folder_id = response.json['id']
    url = API + '/' + folder_id
    assert client.get(COURSES, headers=headers()).json['folders'] == [
        {'id': folder_id, 'name': 'Winter classes', 'deleting': False}]
    assert client.put(MOVE, json={'folderId': folder_id}, headers=headers()).status_code == 200
    card = client.get(COURSES, headers=headers()).json['expeditions'][0]
    assert card['folderId'] == folder_id and card['shareToken'] == 'existing-link'
    assert client.patch(url, json={'name': 'Spring'}, headers=headers()).status_code == 200
    assert client.get(COURSES, headers=headers()).json['folders'][0]['name'] == 'Spring'
    assert client.put(MOVE, json={'folderId': ''}, headers=headers()).status_code == 200
    assert db.get(LESSON) == original
    assert client.put(MOVE, json={'folderId': folder_id}, headers=headers()).status_code == 200
    assert client.delete(url, headers=headers()).status_code == 200
    assert db.get(LESSON) == original
    assert db.get(LESSON + '/responses/result') == {'score': 4}
    assert client.get(COURSES, headers=headers()).json['folders'] == []


def test_shared_courses_and_foreign_folder_ids_cannot_change_another_library(library):
    client, db = library
    folder = client.post(API, json={'name': 'Private group'}, headers=headers()).json['id']
    db.put(LESSON, {'id': 'lesson', 'owner_uid': 'author', 'folder_id': folder,
                    'member_emails': ['other@example.test'], 'members': {'other@example.test': 'edit'}})
    library_data = client.get(COURSES, headers=headers('other')).json
    assert library_data['folders'] == []
    assert 'folderId' not in library_data['expeditions'][0]
    assert 'folder_id' not in client.get(COURSES + '/lesson', headers=headers('other')).json['expedition']
    assert client.delete(API + '/' + folder, headers=headers('other')).status_code == 404
    assert client.put(MOVE, json={'folderId': ''}, headers=headers('other')).status_code == 404
    db.put(LESSON, {'id': 'lesson', 'owner_uid': 'other'})
    assert client.put(MOVE, json={'folderId': folder}, headers=headers('other')).status_code == 404
    assert 'folder_id' not in db.get(LESSON)
    assert client.post(API, json={'name': 'Private group'}, headers=headers('learner')).status_code == 403
    assert client.post(API, json={'name': 'Anon'}).status_code == 401
    db.put('account_deletions/author', {'status': 'processing'})
    assert client.patch(API + '/' + folder, json={'name': 'Changed'}, headers=headers()).status_code == 409


def test_transferred_course_can_leave_protected_review_folder(library):
    client, db = library
    admin = headers('studio-owner')
    db.put('academy_users/studio-owner/folders/account-review', {'name': 'Account review'})
    db.put(LESSON, {'id': 'lesson', 'owner_uid': 'studio-owner', 'folder_id': 'account-review'})
    course = client.get(COURSES, headers=admin).json
    assert course['folders'][0]['id'] == course['expeditions'][0]['folderId'] == 'account-review'
    assert client.delete(API + '/account-review', headers=admin).status_code == 403
    assert client.patch(API + '/account-review', json={'name': 'Archive'}, headers=admin).status_code == 403
    assert client.post(API, json={'name': ' account REVIEW '}, headers=admin).status_code == 400
    assert client.put(MOVE, json={'folderId': ''}, headers=admin).status_code == 200
    assert client.put(MOVE, json={'folderId': 'account-review'}, headers=admin).status_code == 200
    db.put(LESSON, {'id': 'lesson', 'owner_uid': 'author'})
    assert client.put(MOVE, json={'folderId': 'account-review'}, headers=headers()).status_code == 404


def test_retry_after_interrupted_removal_preserves_intervening_moves(library, monkeypatch):
    from google.api_core.exceptions import ServiceUnavailable

    client, db = library
    folder = client.post(API, json={'name': 'Remove me'}, headers=headers()).json['id']
    db.put(LESSON, {'id': 'lesson', 'owner_uid': 'author', 'folder_id': folder})
    original_list = db.list
    with monkeypatch.context() as scope:
        def fail(*_args, **_kwargs):
            raise ServiceUnavailable('interrupted')
        scope.setattr(db, 'list', fail)
        assert client.delete(API + '/' + folder, headers=headers()).status_code == 503
    assert db.get('academy_users/author/folders/' + folder)['deleting']
    assert client.put(MOVE, json={'folderId': folder}, headers=headers()).status_code == 404

    # Between querying candidate IDs and the cleanup transaction, the owner moves
    # a course into a different folder. The retried delete must keep that move.
    destination = client.post(API, json={'name': 'Keep'}, headers=headers()).json['id']
    def move_after_query(*args, **kwargs):
        rows = original_list(*args, **kwargs)
        if args[0] == 'elearning_expeditions':
            assert client.put(MOVE, json={'folderId': destination}, headers=headers()).status_code == 200
        return rows
    monkeypatch.setattr(db, 'list', move_after_query)
    assert client.delete(API + '/' + folder, headers=headers()).status_code == 200
    assert db.get(LESSON)['folder_id'] == destination


def test_review_courses_remain_visible_beyond_the_original_library_query_cap(library):
    client, db = library
    db.put('academy_users/studio-owner/folders/account-review', {'name': 'Account review'})
    for index in range(201):
        course_id = f'lesson-{index}'
        db.put('elearning_expeditions/' + course_id, {'id': course_id, 'owner_uid': 'studio-owner'})
    db.put(LESSON, {'id': 'lesson', 'owner_uid': 'studio-owner', 'folder_id': 'account-review'})
    courses = client.get(COURSES, headers=headers('studio-owner')).json['expeditions']
    assert [course['id'] for course in courses if course['folderId'] == 'account-review'] == ['lesson']
