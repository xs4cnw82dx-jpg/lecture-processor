"""Academy author invitations, course-specific sharing, and learner access over HTTP."""
from contextvars import Context
import io

import pytest

from lecture_processor import academy
from lecture_processor.domains.elearning import model
from lecture_processor.services import elearning_service as service
from scripts.academy_preview import academy_preview
from tests.support.book_cloud_sync import PrivateStorage
from tests.test_elearning_api import MemoryStore, auth_headers, setup as lecture_studio_fixture


lecture_studio = lecture_studio_fixture


AUTHORS = '/api/academy/authors'
LIBRARY = '/api/elearning/expeditions'
PREVIEW_IMPORT = '/api/elearning/import-preview'
ADMIN = auth_headers('studio-owner')
AUTHOR = auth_headers('author')
OTHER = auth_headers('other')
AUDIO = b'synthetic audio bytes'


@pytest.fixture()
def studio(tmp_path, monkeypatch):
    with academy_preview(tmp_path / 'synthetic-firebase.json') as app:
        store = MemoryStore()
        monkeypatch.setattr(service, '_store', lambda _runtime: store)
        storage = PrivateStorage()
        monkeypatch.setattr(service.book_storage, 'request', lambda method, path, data=None, **_opts: storage.request(method, path, data))

        def verify(token, **_options):
            if token not in ('studio-owner', 'author', 'other'):
                raise ValueError('Unknown test identity')
            return {'uid': token, 'email': token + '@example.test', 'email_verified': True}

        monkeypatch.setattr(academy.auth, 'verify_id_token', verify)
        yield app.test_client()


def change_author(client, action, email='author@example.test', headers=ADMIN):
    return client.post(AUTHORS, json={'action': action, 'email': email}, headers=headers)


def create_course(client, headers):
    response = client.post(LIBRARY, json={'title': 'Synthetic course'}, headers=headers)
    assert response.status_code == 201, response.json
    return response.json['expedition']


def upload_clip(client, path, headers):
    return client.post(path + '/assets', headers=headers, data={
        'file': (io.BytesIO(AUDIO), 'clip.mp3', 'audio/mpeg'),
    })


def test_only_the_admin_can_list_grant_or_revoke_academy_authors(studio):
    assert studio.get(AUTHORS, headers=ADMIN).json == {'authors': []}
    for headers, status in (({}, 401), (AUTHOR, 403)):
        assert studio.get(AUTHORS, headers=headers).status_code == status
        assert change_author(studio, 'grant', headers=headers).status_code == status
        assert change_author(studio, 'revoke', headers=headers).status_code == status
    assert change_author(studio, 'grant', 'not-an-email').status_code == 400
    assert change_author(studio, 'other-action').status_code == 400
    for email in ('  Author@Example.Test  ', 'author@example.test'):
        assert change_author(studio, 'grant', email).status_code == 200
    assert studio.get(AUTHORS, headers=ADMIN).json == {'authors': ['author@example.test']}
    assert studio.get(AUTHORS, headers=AUTHOR).status_code == 403
    assert change_author(studio, 'grant', 'other@example.test', AUTHOR).status_code == 403
    assert change_author(studio, 'revoke', headers=AUTHOR).status_code == 403
    for _ in range(2):
        assert change_author(studio, 'revoke').status_code == 200
    assert studio.get(AUTHORS, headers=ADMIN).json == {'authors': []}


def test_invitation_controls_creation_import_and_duplication_independently_of_edit_sharing(studio):
    template = model.build_default_expedition('Synthetic import', 'nl')
    course = create_course(studio, ADMIN)
    course_path = LIBRARY + '/' + course['id']
    assert studio.post(course_path + '/sharing', headers=ADMIN, json={
        'action': 'add_member', 'email': 'author@example.test', 'role': 'edit',
    }).status_code == 200
    assert studio.get(course_path, headers=AUTHOR).json['expedition']['role'] == 'edit'
    assert studio.get(LIBRARY, headers=AUTHOR).json['canCreate'] is False
    for endpoint, payload in (
        (LIBRARY, {'title': 'New draft'}), (LIBRARY, template), (PREVIEW_IMPORT, template), (course_path + '/duplicate', {}),
    ):
        assert studio.post(endpoint, json=payload, headers=AUTHOR).status_code == 403, endpoint

    assert change_author(studio, 'grant').status_code == 200
    assert studio.get(LIBRARY, headers=AUTHOR).json['canCreate'] is True
    assert studio.post(PREVIEW_IMPORT, json=template, headers=AUTHOR).status_code == 200
    imported = studio.post(LIBRARY, json=template, headers=AUTHOR)
    assert imported.status_code == 201 and imported.json['expedition']['owner_uid'] == 'author'
    duplicate = studio.post(course_path + '/duplicate', headers=AUTHOR, json={})
    assert duplicate.status_code == 201 and duplicate.json['expedition']['owner_uid'] == 'author'
    assert create_course(studio, AUTHOR)['owner_uid'] == 'author'


def test_revoking_an_author_preserves_explicit_collaboration_and_public_learning(studio):
    assert change_author(studio, 'grant').status_code == 200
    owned = create_course(studio, AUTHOR)
    owned_path = LIBRARY + '/' + owned['id']
    assert upload_clip(studio, owned_path, AUTHOR).status_code == 201
    published = studio.post(owned_path + '/sharing', headers=AUTHOR, json={'action': 'update_public', 'enabled': True})
    assert published.status_code == 200
    public = '/api/elearning/public/' + published.json['share']['token']
    shared = create_course(studio, ADMIN)
    shared_path = LIBRARY + '/' + shared['id']
    assert studio.post(shared_path + '/sharing', headers=ADMIN, json={
        'action': 'add_member', 'email': 'author@example.test', 'role': 'edit',
    }).status_code == 200
    assert change_author(studio, 'revoke').status_code == 200

    library = studio.get(LIBRARY, headers=AUTHOR).json
    assert library['canCreate'] is False
    assert [(row['id'], row['role']) for row in library['expeditions']] == [(shared['id'], 'edit')]
    assert studio.get(owned_path, headers=AUTHOR).status_code == 403
    assert studio.post(owned_path + '/lease', headers=AUTHOR, json={'action': 'acquire'}).status_code == 403
    assert upload_clip(studio, owned_path, AUTHOR).status_code == 403
    assert studio.get(shared_path, headers=AUTHOR).json['expedition']['role'] == 'edit'
    assert upload_clip(studio, shared_path, AUTHOR).status_code == 201
    assert upload_clip(studio, shared_path, OTHER).status_code == 403
    assert studio.post(shared_path + '/duplicate', headers=AUTHOR, json={}).status_code == 403
    player = studio.get(public)
    assert player.status_code == 200
    assert player.json['expedition']['title']
    assert studio.post(LIBRARY, headers=AUTHOR, json={'title': 'Blocked'}).status_code == 403

    assert change_author(studio, 'grant').status_code == 200
    assert studio.get(owned_path, headers=AUTHOR).json['expedition']['role'] == 'owner'


def test_no_admin_config_leaves_the_academy_without_creation_or_invitation_authority(studio, monkeypatch):
    monkeypatch.delenv('XPED_STUDIO_ADMIN_UID', raising=False)
    monkeypatch.delenv('XPED_STUDIO_ADMIN_EMAIL', raising=False)
    client = academy.create_app().test_client()
    library = client.get(LIBRARY, headers=ADMIN)
    assert library.status_code == 200
    assert library.json['studioAdmin'] is False
    assert library.json['canCreate'] is False
    assert client.get(AUTHORS, headers=ADMIN).status_code == 403
    assert change_author(client, 'grant').status_code == 403
    assert client.post(LIBRARY, headers=ADMIN, json={'title': 'Blocked'}).status_code == 403


def test_lecture_processor_keeps_its_original_creation_and_management_behavior(lecture_studio):
    client, _ = lecture_studio
    assert client.get(AUTHORS, headers=ADMIN).status_code == 404
    assert 'canCreate' not in client.get(LIBRARY, headers=AUTHOR).json
    course = create_course(client, AUTHOR)
    assert client.post(LIBRARY + '/' + course['id'] + '/duplicate', headers=AUTHOR, json={}).status_code == 201


def test_revoke_during_upload_releases_the_media_and_storage_reservation(studio, monkeypatch):
    assert change_author(studio, 'grant').status_code == 200
    course = create_course(studio, AUTHOR)
    path = LIBRARY + '/' + course['id']
    storage = PrivateStorage()
    monkeypatch.setattr(service.book_storage, 'GLOBAL_BYTES', len(AUDIO))

    def revoke_during_transfer(method, key, data=None, **_opts):
        result = storage.request(method, key, data)
        if method == 'POST':
            # The administrator's request has its own Flask identity and request context.
            assert Context().run(change_author, studio, 'revoke').status_code == 200
        return result

    monkeypatch.setattr(service.book_storage, 'request', revoke_during_transfer)
    assert upload_clip(studio, path, AUTHOR).status_code == 403
    assert not storage.data
    assert change_author(studio, 'grant').status_code == 200
    remaining = studio.get(path + '/assets', headers=AUTHOR)
    assert remaining.status_code == 200
    assert remaining.json['unused'] == []
    monkeypatch.setattr(service.book_storage, 'request', lambda method, key, data=None, **_opts: storage.request(method, key, data))
    assert upload_clip(studio, path, AUTHOR).status_code == 201


def test_translation_grant_still_works_without_an_academy_author_invitation(studio):
    course = create_course(studio, ADMIN)
    path = LIBRARY + '/' + course['id']
    grant = studio.post(path + '/sharing', headers=ADMIN, json={
        'action': 'create_grant', 'role': 'translate', 'targetLanguage': 'de',
    })
    assert grant.status_code == 201
    token = grant.json['grant']['urlPath'].split('/')[-1]
    exchanged = studio.post('/api/elearning/grant-session', json={'token': token})
    assert exchanged.status_code == 200
    headers = {'X-Elearning-Access': exchanged.json['accessToken']}
    assert studio.get(path, headers=headers).json['expedition']['role'] == 'translate'
    assert upload_clip(studio, path, headers).status_code == 201
    assert studio.post(path + '/duplicate', headers=headers, json={}).status_code == 401
