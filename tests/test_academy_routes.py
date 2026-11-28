"""Bookmarks, host boundaries and truthful learner status on the standalone Academy."""
import json
from lxml import html
import pytest
from werkzeug.exceptions import Forbidden, InternalServerError, ServiceUnavailable

from lecture_processor.services import elearning_service as service
from scripts.academy_preview import academy_preview
from tests.test_elearning_api import MemoryStore


@pytest.fixture()
def academy(tmp_path, monkeypatch):
    with academy_preview(tmp_path / 'synthetic.json') as app:
        store = MemoryStore()
        monkeypatch.setattr(service, '_store', lambda _runtime: store)
        yield app.test_client(), store


@pytest.mark.parametrize(('old', 'canonical'), [
    ('/signin', '/inloggen'), ('/account', '/instellingen'),
    ('/physio/elearning', '/expedities'),
    ('/physio/elearning/sample/edit', '/expedities/sample/bewerken'),
    ('/physio/elearning/sample/responses', '/expedities/sample/resultaten'),
    ('/elearning/p/synthetic-token', '/start/synthetic-token'),
    ('/elearning/translate/synthetic-grant', '/vertalen/synthetic-grant'),
])
def test_bookmarks_stay_on_the_same_host_and_retain_queries(academy, old, canonical):
    client, _ = academy
    query = '?lang=de&cohort=group%2B1&tag=a&tag=b'
    response = client.get(old + query)
    assert response.status_code == 301
    assert response.location == canonical + query
    assert response.headers['Referrer-Policy'] == 'strict-origin'


def test_translation_workspace_deep_link_keeps_course_and_mode(academy):
    client, _ = academy
    page = html.fromstring(client.get('/expedities/my-course/bewerken?modus=vertalen&taal=de').data)
    assert page.find('body').get('data-expedition-id') == 'my-course'
    assert page.find('body').get('data-initial-mode') == 'translate'
    normal = html.fromstring(client.get('/expedities/my-course/bewerken').data)
    assert normal.find('body').get('data-initial-mode') == 'edit'


def test_old_lecture_processor_links_continue_to_the_original_app(client):
    for path in ('/physio/elearning', '/physio/elearning/sample/edit', '/physio/elearning/sample/responses',
                 '/elearning/p/printed-learner-link', '/elearning/translate/synthetic-grant'):
        result = client.get(path)
        assert result.status_code == 200, path
        page = html.fromstring(result.data)
        assert not page.xpath('//*[@id="academy-firebase-config"]'), path
    assert html.fromstring(client.get('/physio/elearning').data).xpath('//a[@href="https://xped.academy/"]')


@pytest.mark.parametrize(('err', 'status'), [(Forbidden, 403), (InternalServerError, 500), (ServiceUnavailable, 503)])
def test_error_pages_and_api_errors_keep_their_protocol(academy, err, status):
    client, _ = academy
    def fail():
        raise err()
    client.application.add_url_rule('/temporary-error', endpoint='error-test', view_func=fail)
    client.application.add_url_rule('/api/temporary-error', endpoint='api-error-test', view_func=fail)
    result = client.get('/temporary-error')
    assert result.status_code == status and result.mimetype == 'text/html'
    page = html.fromstring(result.data)
    assert page.xpath('//main//h1') and page.xpath('//main//a[@href="/"]')
    assert str(status) in page.xpath('//main')[0].text_content()
    result = client.get('/api/temporary-error')
    assert result.status_code == status and isinstance(result.json['error'], str)
    assert client.post('/healthz').status_code == 405
    assert 'GET' in client.post('/healthz').headers['Allow']


def test_player_status_and_private_pause_note_before_any_script_runs(academy):
    client, store = academy
    token = 'printed-preview-token'
    index = 'elearning_share_index/' + token
    course = 'elearning_expeditions/exp-preview'
    store.put(index, {'expedition_id': 'exp-preview'})
    share = {'token': token, 'enabled': False}
    from lecture_processor.domains.elearning import model
    exp = {**model.build_default_expedition('Preview course', 'nl'), 'id': 'exp-preview', 'share': share}
    store.put(course, exp)
    for note in ('', 'We oefenen dinsdag verder.'):
        share['pausedMessage'] = note
        store.put(course, exp)
        result = client.get('/start/' + token)
        assert result.status_code == 410
        page = html.fromstring(result.data)
        assert 'gepauzeerd' in page.findtext('.//h1')
        assert (note or 'Probeer het later opnieuw') in page.text_content()
        assert not page.xpath('//script[@src]') and 'fontshare' not in result.text
    share.update(token='new-preview-token', enabled=True)
    store.put(course, exp)
    assert client.get('/start/' + token).status_code == 410
    assert client.get('/api/elearning/public/' + token).json['error_code'] == 'link_expired'
    store.put('elearning_share_index/new-preview-token', {'expedition_id': 'exp-preview'})
    active = client.get('/start/new-preview-token')
    assert active.status_code == 200
    page = html.fromstring(active.data)
    payloads = [json.loads(script.text) for script in page.xpath('//script[@type="application/json"]') if script.text]
    assert any(isinstance(item, dict) and item.get('title') == 'Preview course' for item in payloads)
    assert not page.xpath('//script[contains(@src,"firebase")]') and 'fontshare' not in active.text
