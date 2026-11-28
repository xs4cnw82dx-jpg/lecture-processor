"""HTTP behavior of the standalone Studio with no real provider credentials."""
import json

from lxml import html
import pytest

from scripts.academy_preview import academy_preview


@pytest.fixture()
def academy_client(tmp_path):
    with academy_preview(tmp_path / 'synthetic-firebase.json') as app:
        yield app.test_client()


def test_academy_root_and_pages_use_the_fresh_firebase_project(academy_client):
    dashboard = academy_client.get('/', follow_redirects=True)
    assert dashboard.status_code == 200
    assert dashboard.request.path == '/physio/elearning'
    for path in ('/signin', '/physio/elearning', '/physio/elearning/course/edit', '/physio/elearning/course/responses'):
        response = academy_client.get(path)
        assert response.status_code == 200
        page = html.fromstring(response.data)
        assert 'xPEDitie Pijn Studio' in page.findtext('.//title')
        assert 'Lecture Processor' not in page.findtext('.//title')
        config = json.loads(page.get_element_by_id('academy-firebase-config').text)
        assert config['projectId'] == 'demo-xped-academy'
        assert config['authDomain'] == 'demo-xped-academy.firebaseapp.com'
        assert config['apiKey'] == 'synthetic-web-api-key'
        assert 'synthetic-private-storage-key' not in response.text
        local_assets = page.xpath('//link[@rel="stylesheet"]/@href | //script[@src]/@src | //img/@src')
        for url in local_assets:
            if url.startswith('/static/'):
                assert academy_client.get(url).status_code == 200, (path, url)


def test_academy_excludes_lecture_processor_pages_and_apis(academy_client):
    for path in ('/dashboard', '/lecture-notes', '/admin', '/study', '/api/books', '/api/auth/user',
                 '/static/js/app-shell.js', '/static/css/admin.css'):
        assert academy_client.get(path).status_code == 404, path
    assert academy_client.post('/api/tools/extract').status_code == 404
    assert academy_client.get('/healthz').status_code == 200


def test_academy_accepts_its_own_identity_and_starts_with_an_empty_library(academy_client):
    library = '/api/elearning/expeditions'
    assert academy_client.get(library).status_code == 401
    assert academy_client.get(library, headers={'Authorization': 'Bearer unrelated-project'}).status_code == 401
    response = academy_client.get(library, headers={'Authorization': 'Bearer academy-preview-token'})
    assert response.status_code == 200, response.text
    assert response.json == {'expeditions': [], 'storageAvailable': True, 'studioAdmin': True, 'canCreate': True, 'folders': []}
    assert academy_client.get('/api/elearning/admin/statistics').status_code == 401


def test_learner_page_is_public_but_unknown_course_is_unavailable(academy_client):
    player = academy_client.get('/elearning/p/synthetic-course-token')
    assert player.status_code == 200
    assert html.fromstring(player.data).findtext('.//title') == 'xPEDitie Pijn · xPED Academy'
    assert academy_client.get('/api/elearning/public/synthetic-course-token').status_code == 404
    assert academy_client.get('/privacy').status_code == 200


def test_academy_rejects_the_lecture_processor_project(academy_client, monkeypatch):
    from lecture_processor import academy

    monkeypatch.setenv('ACADEMY_FIREBASE_PROJECT_ID', 'lecture-processor-cdff6')
    with pytest.raises(RuntimeError, match='dedicated Academy'):
        academy.create_app()


def test_academy_rejects_credentials_for_another_project(tmp_path, monkeypatch):
    from types import SimpleNamespace
    from lecture_processor import academy

    monkeypatch.delenv('ACADEMY_FIREBASE_CREDENTIALS', raising=False)
    monkeypatch.setattr(academy.credentials, 'Certificate', lambda _path: SimpleNamespace(project_id='unrelated-test'))
    with pytest.raises(RuntimeError, match='credential must belong'):
        academy._firebase_clients('demo-xped-academy', str(tmp_path / 'synthetic-firebase.json'))


@pytest.mark.parametrize(('admin_uid', 'is_admin'), [('', True), ('someone-else', False)])
def test_admin_email_fallback_respects_uid_precedence(academy_client, monkeypatch, admin_uid, is_admin):
    from lecture_processor import academy

    monkeypatch.setenv('XPED_STUDIO_ADMIN_UID', admin_uid)
    monkeypatch.setenv('XPED_STUDIO_ADMIN_EMAIL', 'STUDIO@example.test')
    client = academy.create_app().test_client()
    response = client.get('/api/elearning/expeditions', headers={'Authorization': 'Bearer academy-preview-token'})
    assert response.status_code == 200
    assert response.json['studioAdmin'] is is_admin


@pytest.mark.parametrize('path', ['/api/academy/authors', '/api/elearning/expeditions', '/api/elearning/admin/statistics'])
def test_unverified_email_cannot_use_studio_admin(academy_client, monkeypatch, path):
    from lecture_processor import academy

    monkeypatch.delenv('XPED_STUDIO_ADMIN_UID')
    monkeypatch.setenv('XPED_STUDIO_ADMIN_EMAIL', 'studio@example.test')
    monkeypatch.setattr(academy.auth, 'verify_id_token', lambda *_args, **_kw: {
        'uid': 'another-id', 'email': 'studio@example.test', 'email_verified': False,
    })
    client = academy.create_app().test_client()
    response = client.get(path, headers={'Authorization': 'Bearer unverified'})
    assert response.status_code == 403
    assert response.json['error_code'] == 'email_not_verified'
    assert 'verify your email' in response.json['error'].lower()


def test_invalid_inline_credential_is_rejected_without_disclosing_its_value(monkeypatch, tmp_path):
    from lecture_processor import academy

    marker = 'synthetic-secret-do-not-log'
    monkeypatch.setenv('ACADEMY_FIREBASE_CREDENTIALS', marker)
    with pytest.raises(RuntimeError) as error:
        academy._firebase_clients('demo-xped-academy', str(tmp_path / 'synthetic-firebase.json'))
    assert marker not in str(error.value)
    assert error.value.__cause__ is None


def test_inline_service_account_and_firestore_use_the_same_named_project(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import Mock
    from lecture_processor import academy

    project = 'demo-xped-academy'
    service_account = {'project_id': project, 'type': 'service_account'}
    certificate = Mock(return_value=SimpleNamespace(project_id=project))
    sdk_app = object()
    initialize = Mock(return_value=sdk_app)
    firestore_client = Mock()
    monkeypatch.setenv('ACADEMY_FIREBASE_CREDENTIALS', json.dumps(service_account))
    monkeypatch.setattr(academy.credentials, 'Certificate', certificate)
    monkeypatch.setattr(academy.firebase_admin, 'get_app', Mock(side_effect=ValueError('No application')))
    monkeypatch.setattr(academy.firebase_admin, 'initialize_app', initialize)
    monkeypatch.setattr(academy.firestore, 'client', firestore_client)

    database, app = academy._firebase_clients(project, '')
    certificate.assert_called_once_with(service_account)
    initialize.assert_called_once_with(certificate.return_value, {'projectId': project}, name='academy-' + project)
    firestore_client.assert_called_once_with(app=sdk_app)
    assert app is sdk_app and database is firestore_client.return_value


def test_privacy_contact_uses_only_the_deployment_mailbox(academy_client, monkeypatch):
    monkeypatch.setenv('LEGAL_CONTACT_EMAIL', 'support@example.test')
    page = html.fromstring(academy_client.get('/privacy').data)
    assert page.xpath('//a[@href="mailto:support@example.test"]')

    monkeypatch.delenv('LEGAL_CONTACT_EMAIL')
    page = html.fromstring(academy_client.get('/privacy').data)
    assert not page.xpath('//a[starts-with(@href, "mailto:")]')
