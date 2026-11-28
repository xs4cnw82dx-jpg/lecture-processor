"""Course sharing and team grants use the Academy's actual authorization boundaries."""
from lxml import html
import pytest

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
