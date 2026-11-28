"""Course sharing and team grants use the Academy's actual authorization boundaries."""
from unittest.mock import Mock

from google.auth.credentials import AnonymousCredentials
from google.cloud import firestore
from google.cloud.firestore_v1 import _helpers
from google.cloud.firestore_v1.types import (
    BatchGetDocumentsResponse, BeginTransactionResponse, CommitRequest, CommitResponse, Document,
)
from lxml import html
import pytest

from lecture_processor.repositories.elearning_repo import ElearningStore
from lecture_processor.services import elearning_service as service
from scripts.academy_preview import academy_preview

ADMIN = {'Authorization': 'Bearer academy-preview-token'}
EDITOR = {'Authorization': 'Bearer academy-preview-editor'}
TRANSLATOR = {'Authorization': 'Bearer academy-preview-translator'}


@pytest.fixture()
def studio(tmp_path):
    with academy_preview(tmp_path / 'synthetic.json', memory=True) as app:
        client = app.test_client()
        response = client.post('/api/elearning/expeditions', headers=ADMIN, json={'title': 'Samen leren'})
        assert response.status_code == 201, response.json
        yield client, response.json['expedition']


def test_hub_enforces_course_roles_and_omits_management_markup_until_authorized(studio):
    client, course = studio
    eid = course['id']
    hub = f'/api/academy/courses/{eid}/workspace'
    assert b'xc-sharing-settings' not in client.get('/expedities/' + eid).data
    assert b'xc-team-table' not in client.get('/team').data
    assert client.get(hub).status_code == 403
    assert client.get(hub, headers=EDITOR).status_code == 403
    for role, email, headers in [('edit', 'editor@example.test', EDITOR), ('translate', 'translator@example.test', TRANSLATOR)]:
        result = client.post('/api/academy/team/invitations', headers=ADMIN, json={'role': role, 'email': email, 'courses': [eid]})
        assert result.status_code == 201, result.json
        workspace = client.get(hub, headers=headers).json
        fragment = html.fragment_fromstring(workspace['html'], create_parent=True)
        assert workspace['course']['role'] == role
        assert 'members' not in workspace['course']
        assert not any('blocks' in station for station in workspace['course']['modules'])
        if role == 'translate':
            assert 'share' not in workspace['course']
        assert not fragment.xpath('//*[@id="xc-sharing-settings" or @id="xc-pause"]')
        assert bool(fragment.xpath('//*[@id="xc-delen"]')) == (role == 'edit')
        assert client.get('/api/academy/team', headers=headers).status_code == 403
    assert client.get('/api/academy/team', headers=ADMIN).json['people'][1:]
    assert client.post('/api/academy/team/invitations', headers=EDITOR, json={'role': 'author', 'email': 'editor@example.test'}).status_code == 403


def test_team_invitations_are_atomic_across_selected_courses(studio):
    client, course = studio
    invite = {'role': 'author', 'email': 'editor@example.test', 'courses': [course['id'], 'missing']}
    assert client.post('/api/academy/team/invitations', headers=ADMIN, json=invite).status_code == 404
    assert client.get('/api/elearning/expeditions', headers=EDITOR).json['canCreate'] is False
    assert client.get('/api/academy/courses/' + course['id'] + '/workspace', headers=EDITOR).status_code == 403


def test_team_invitation_commits_only_membership_fields_for_100_large_courses(studio, monkeypatch):
    client, _ = studio
    email = 'editor@example.test'
    course_ids = [f'course-{index}' for index in range(100)]
    course = {'owner_uid': 'studio-owner', 'members': {'other@example.test': 'translate'},
              '_memberUndo': {service._digest(email): {'nonce': 'old', 'until': service.now() + 12, 'role': 'edit'}},
              'modules': [{'authorContent': 'x' * 150_000}]}
    # Use the actual SDK to encode the complete commit, with an in-process Firestore transport.
    db = firestore.Client(project='demo-academy', credentials=AnonymousCredentials())
    transport = Mock()
    monkeypatch.setattr(db, '_firestore_api_internal', transport)
    transport.begin_transaction.return_value = BeginTransactionResponse(transaction=b'invite')
    transport.commit.return_value = CommitResponse()

    def read_document(request, **_options):
        name, = request['documents']
        if name.rsplit('/', 2)[-2] != 'elearning_expeditions':
            return iter([BatchGetDocumentsResponse(missing=name)])
        fields = request['mask'].field_paths if request['mask'] is not None else course.keys()
        assert 'modules' not in fields
        snapshot = Document(name=name, fields=_helpers.encode_dict({k: course[k] for k in fields if k in course}))
        return iter([BatchGetDocumentsResponse(found=snapshot)])

    transport.batch_get_documents.side_effect = read_document
    monkeypatch.setattr(service, '_store', lambda _runtime: ElearningStore(db))
    response = client.post('/api/academy/team/invitations', headers=ADMIN, json={
        'role': 'author', 'email': email, 'courses': course_ids,
    })
    assert response.status_code == 201, response.json
    transport.commit.assert_called_once()
    commit = CommitRequest(**transport.commit.call_args.kwargs['request'])
    assert len(CommitRequest.serialize(commit)) < 100_000
    course_writes = [write for write in commit.writes if '/elearning_expeditions/' in write.update.name]
    assert {write.update.name.rsplit('/', 1)[-1] for write in course_writes} == set(course_ids)
    assert len(commit.writes) == len(course_ids) + 1  # The same commit grants author status.
    for write in course_writes:
        assert set(write.update_mask.field_paths) == {'members', 'member_emails', 'updated_at', '_memberUndo'}
        assert '_memberUndo' not in write.update.fields  # Deleted by its field mask.
        members = write.update.fields['members'].map_value.fields
        assert {key: value.string_value for key, value in members.items()} == {
            email: 'edit', 'other@example.test': 'translate',
        }


def test_revoke_and_restore_recheck_access_and_expiry_and_rotation_checks_current_title(studio, monkeypatch):
    client, course = studio
    eid = course['id']
    sharing = f'/api/elearning/expeditions/{eid}/sharing'
    def post(action, headers=ADMIN, **kwargs):
        return client.post(sharing, headers=headers, json={'action': action, **kwargs})
    assert post('update_public', rotateToken=True, confirmTitle='Old title').status_code == 409
    assert post('update_public', rotateToken=True, confirmTitle='Samen leren').json['share']['token'] != course['share']['token']
    assert post('add_member', email='editor@example.test', role='edit').status_code == 200
    undo = post('remove_member', email='editor@example.test').json['undo']
    assert post('restore_member', headers=EDITOR, email='editor@example.test', undo=undo).status_code == 403
    assert post('restore_member', email='unknown@example.test', undo=undo).status_code == 409
    assert post('restore_member', email='editor@example.test', undo=undo).status_code == 200
    assert post('restore_member', email='editor@example.test', undo=undo).status_code == 409

    grant = post('create_grant', role='translate', targetLanguage='de', label='Vertaler').json['grant']
    raw_token = grant['urlPath'].rsplit('/', 1)[-1]
    def exchange():
        return client.post('/api/elearning/grant-session', json={'token': raw_token})
    assert exchange().status_code == 200
    assert client.get(sharing, headers=ADMIN).json['grants'][0]['lastOpenedAt'] > 0
    undo = post('revoke_grant', grantId=grant['id']).json['undo']
    assert exchange().status_code == 404
    assert post('restore_grant', grantId=grant['id'], undo=undo).status_code == 200
    assert exchange().status_code == 200
    undo = post('revoke_grant', grantId=grant['id']).json['undo']
    future = service.now() + 30
    monkeypatch.setattr(service, 'now', lambda: future)
    assert post('restore_grant', grantId=grant['id'], undo=undo).status_code == 409
    assert exchange().status_code == 404


def test_undo_is_scoped_to_the_member_and_retries_do_not_extend_its_deadline(studio, monkeypatch):
    client, course = studio
    eid = course['id']
    sharing = f'/api/elearning/expeditions/{eid}/sharing'
    def change(action, email, **data):
        return client.post(sharing, headers=ADMIN, json={'action': action, 'email': email, **data})

    first, second = 'first@example.test', 'second@example.test'
    for email in (first, second):
        assert change('add_member', email, role='edit').status_code == 200
    timestamp = service.now()
    monkeypatch.setattr(service, 'now', lambda: timestamp)
    first_undo = change('remove_member', first).json['undo']
    second_undo = change('remove_member', second).json['undo']
    timestamp += 8
    assert change('remove_member', first).json['undo'] == first_undo
    assert change('restore_member', second, undo=second_undo).status_code == 200
    assert change('restore_member', first, undo=first_undo).status_code == 200
    first_undo = change('remove_member', first).json['undo']
    second_undo = change('remove_member', second).json['undo']
    assert client.post('/api/academy/team/invitations', headers=ADMIN, json={
        'role': 'translate', 'email': second, 'courses': [eid],
    }).status_code == 201
    assert change('restore_member', second, undo=second_undo).status_code == 409
    timestamp += 8
    assert change('remove_member', first).json['undo'] == first_undo
    timestamp += 5
    assert change('restore_member', first, undo=first_undo).status_code == 409


def test_optional_translation_date_is_shared_with_the_assigned_translator(studio):
    client, course = studio
    eid = course['id']
    path = f'/api/academy/courses/{eid}'
    client.post('/api/academy/team/invitations', headers=ADMIN,
                json={'role': 'translate', 'email': 'translator@example.test', 'courses': [eid]})
    def set_date(value, headers=ADMIN, language='de'):
        return client.post(path + '/translation-date', headers=headers, json={'language': language, 'date': value})
    assert set_date('2026-11-35').status_code == 400
    assert set_date('2026-12-02', language='nl').status_code == 400
    assert set_date('2026-12-02', TRANSLATOR).status_code == 403
    assert set_date('2026-12-02').get_json() == {'dueDate': '2026-12-02'}
    assert client.get(path + '/workspace', headers=TRANSLATOR).json['dueDate'] == '2026-12-02'
    assert client.get('/api/academy/overview', headers=TRANSLATOR).json['courses'][0]['dueDate'] == '2026-12-02'
    assert set_date(None).json == {'dueDate': None}
    assert client.get(path + '/workspace', headers=ADMIN).json['dueDate'] is None
