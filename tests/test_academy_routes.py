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
    for language in ('nl', 'de'):
        expired = client.get('/start/' + token, headers={'Accept-Language': language})
        assert expired.status_code == 410
        assert html.fromstring(expired.data).xpath('//a[@referrerpolicy="no-referrer"]/@href') == [f'https://xped.net/{language}/']
    assert client.get('/api/elearning/public/' + token).json['error_code'] == 'link_expired'
    store.put('elearning_share_index/new-preview-token', {'expedition_id': 'exp-preview'})
    active = client.get('/start/new-preview-token')
    assert active.status_code == 200
    page = html.fromstring(active.data)
    payloads = [json.loads(script.text) for script in page.xpath('//script[@type="application/json"]') if script.text]
    assert any(isinstance(item, dict) and item.get('title') == 'Preview course' for item in payloads)
    assert not page.xpath('//script[contains(@src,"firebase")]') and 'fontshare' not in active.text


@pytest.mark.parametrize('locale', ['nl', 'de'])
def test_studio_pages_and_errors_have_the_requested_language_before_javascript(academy, locale):
    client, _ = academy
    client.set_cookie('xped-language', locale)
    paths = ['/', '/expedities', '/expedities/example', '/expedities/example/bewerken',
             '/expedities/example/resultaten', '/resultaten', '/vertalingen', '/team',
             '/instellingen', '/inloggen', '/privacy', '/hulp', '/vertalen/example', '/unknown-preview-page']
    for path in paths:
        response = client.get(path)
        assert response.status_code == (404 if path == '/unknown-preview-page' else 200), path
        assert html.fromstring(response.data).get('lang') == locale, path


def test_all_registered_pages_only_reference_academy_pages_and_available_product_assets(academy):
    from urllib.parse import urljoin, urlsplit
    import re

    from lecture_processor.domains.elearning import model

    client, store = academy
    token = 'published-preview-token'
    course = model.build_default_expedition('Preview course', 'nl')
    course.update(id='preview', share={'token': token, 'enabled': True})
    store.put('elearning_expeditions/preview', course)
    store.put('elearning_share_index/' + token, {'expedition_id': 'preview'})
    args = {'expedition_id': 'preview', 'grant_token': 'preview-grant', 'share_token': token}
    non_pages = {'static', 'academy_style', 'healthz', 'academy_language.messages'}
    urls = client.application.url_map.bind('localhost')
    pages = {urls.build(rule.endpoint, {name: args[name] for name in rule.arguments})
             for rule in urls.map.iter_rules() if not rule.rule.startswith('/api/') and rule.endpoint not in non_pages}
    checked_assets = set()
    for path in sorted(pages | {'/start/unavailable', '/missing-preview-page'}):
        response = client.get(path, follow_redirects=True)
        assert response.status_code == (404 if path in ('/start/unavailable', '/missing-preview-page') else 200), path
        for previous in response.history:
            assert previous.status_code == 301 and previous.location in pages, path
        page = html.fromstring(response.data)
        final = response.request.path
        for item in page.xpath('//a[@href] | //form | //*[@formaction]'):
            target = item.get('formaction') or item.get('action') or item.get('href') or final
            url = urlsplit(urljoin('http://localhost' + final, target))
            if url.scheme == 'mailto':
                assert url.path == 'contact@example.test', (path, target)
            elif url.hostname != 'localhost':
                assert item.tag == 'a' and url.geturl() in ('https://xped.net/nl/', 'https://xped.net/de/'), (path, target)
            else:
                method = item.get('formmethod') or item.get('method') or 'GET'
                # A dialog form closes locally without submitting an HTTP method.
                endpoint, _ = urls.match(url.path, method='GET' if method.lower() == 'dialog' else method.upper())
                assert endpoint.startswith('academy.') or endpoint == 'privacy', (path, target)
        sheets = page.xpath('//link[@rel="stylesheet"]/@href')
        assert len([href for href in sheets if href.startswith('/static/')]) == 1, (path, sheets)
        assets = page.xpath('//link[@href]/@href | //script[@src]/@src | //img[@src]/@src | //source[@srcset]/@srcset')
        for asset in assets:
            if asset in checked_assets:
                continue
            checked_assets.add(asset)
            if urlsplit(asset).netloc:
                assert urlsplit(asset).hostname in {'www.gstatic.com', 'api.fontshare.com', 'cdn.fontshare.com'}, asset
                continue
            resource = client.get(asset)
            assert resource.status_code == 200, (path, asset)
            if resource.mimetype == 'text/css':
                for match in re.finditer(r'''url\(["']?([^\s()"']+)["']?\)''', resource.text):
                    relative = match[1]
                    if not relative.startswith('data:'):
                        assert client.get(urljoin(asset, relative)).status_code == 200, (asset, relative)


def test_each_host_owns_its_editor_controls(academy, client):
    academy_client, _ = academy
    academy_editor = html.fromstring(academy_client.get('/expedities/preview/bewerken').data)
    lp_editor = html.fromstring(client.get('/physio/elearning/preview/edit').data)
    for page, standalone in ((academy_editor, True), (lp_editor, False)):
        assert bool(page.xpath('//*[@id="academy-outline-toggle"]')) == standalone
        assert bool(page.xpath('//*[@id="el-tr-alt-toggle"]')) != standalone
        rotate, = page.xpath('//*[@id="el-share-rotate-btn"]')
        assert bool(rotate.xpath('ancestor::details[@id="academy-link-reset"]')) == standalone
