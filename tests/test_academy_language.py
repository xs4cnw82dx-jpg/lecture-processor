"""First-render language, account preferences and learner eligibility in the isolated Studio."""
import json

from lxml import html
import pytest

from lecture_processor.blueprints import academy_language
from lecture_processor.domains.elearning import model
from lecture_processor.services import elearning_service
from scripts.academy_preview import academy_preview
from tests.test_elearning_api import MemoryStore


@pytest.fixture()
def studio(tmp_path, monkeypatch):
    with academy_preview(tmp_path / 'synthetic-lang.json') as app:
        store = MemoryStore()
        monkeypatch.setattr(academy_language, 'ElearningStore', lambda _db: store)
        monkeypatch.setattr(elearning_service, '_store', lambda _runtime: store)
        yield app.test_client(), store


@pytest.mark.parametrize(('cookie', 'locale', 'heading', 'button'), [
    (None, 'nl', 'Inloggen', 'Doorgaan met Google'),
    ('de', 'de', 'Anmelden', 'Mit Google anmelden'),
    ('en', 'nl', 'Inloggen', 'Doorgaan met Google'),
])
def test_signin_renders_in_the_interface_language_before_js(studio, cookie, locale, heading, button):
    client, _ = studio
    if cookie:
        client.set_cookie('xped-language', cookie)
    response = client.get('/inloggen', headers={'Accept-Language': 'de-DE,de;q=0.9'})
    page = html.fromstring(response.data)
    assert page.get('lang') == locale
    assert page.findtext('.//h1') == heading
    assert page.get_element_by_id('academy-google').text_content().strip() == button
    path = f'/academy/messages/{locale}/signin.js'
    assert page.xpath('//script[@src=$path]', path=path)
    script = client.get(path)
    content = json.loads(script.text.removeprefix('window.XpedMessages=').removesuffix(';'))
    assert content['Create account'] in ('Account aanmaken', 'Konto erstellen')
    assert 'Clean Blank Canvas (1 empty station)' not in content


def test_language_preference_is_personal_and_cannot_recreate_a_deleted_profile(studio):
    client, store = studio
    endpoint = '/api/academy/preferences'
    auth = {'Authorization': 'Bearer academy-preview-token'}
    assert client.get(endpoint).status_code == 401
    assert client.get(endpoint, headers=auth).json == {'language': None}
    store.put('academy_users/studio-owner', {'existing': 'preserved'})
    assert client.put(endpoint, headers=auth, json={'language': 'en'}).status_code == 400
    assert client.put(endpoint, headers=auth, json={'language': 'de'}).status_code == 200
    assert client.get(endpoint, headers=auth).json == {'language': 'de'}
    assert store.get('academy_users/studio-owner') == {'existing': 'preserved', 'language': 'de'}
    store.delete('academy_users/studio-owner')
    store.put('account_deletions/studio-owner', {'status': 'deleted'})
    assert client.put(endpoint, headers=auth, json={'language': 'nl'}).status_code == 409
    assert store.get('academy_users/studio-owner') is None


def test_learners_get_only_complete_reviewed_languages_and_may_request_an_offered_language(studio):
    client, store = studio
    course = model.build_default_expedition('Voorbeeld', 'nl')
    for _, _, loc in model._walk_localized_fields(course):
        if any(loc.get(lang) for lang in model.SUPPORTED_LANGUAGES):
            loc.update(nl='Voorbeeld', de='Beispiel', en='Historical text')
    course.update(id='course', enabledLanguages=['de', 'nl', 'en'], share={'enabled': True, 'token': 'test-lesson'})
    store.put('elearning_expeditions/course', course)
    store.put('elearning_share_index/test-lesson', {'expedition_id': 'course'})
    endpoint = '/start/test-lesson'
    headers = {'Accept-Language': 'de-DE,de;q=0.9'}
    assert html.fromstring(client.get(endpoint, headers=headers).data).get('lang') == 'de'
    assert html.fromstring(client.get(endpoint + '?lang=nl', headers=headers).data).get('lang') == 'nl'
    course['startPage']['title']['_review'] = {'de': True}
    store.put('elearning_expeditions/course', course)
    response = client.get(endpoint + '?lang=de', headers=headers)
    assert response.status_code == 200
    page = html.fromstring(response.data)
    assert page.get('lang') == 'nl'
    data = json.loads(page.get_element_by_id('academy-initial-course').text)
    assert data['enabledLanguages'] == ['nl']
    assert data['startPage']['title'] == {'nl': 'Voorbeeld'}
    assert store.get('elearning_expeditions/course')['startPage']['title']['en'] == 'Historical text'
    course['startPage']['title']['nl'] = ''
    store.put('elearning_expeditions/course', course)
    assert client.get(endpoint).status_code == 410
