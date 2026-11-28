"""The Academy Studio's design foundation is served only on Academy author pages."""
import re

from lxml import html
import pytest

from scripts.academy_preview import academy_preview


FONTSHARE_STYLESHEET = 'https://api.fontshare.com/v2/css?f[]=general-sans@500,600&display=swap'
STUDIO_PAGES = ('/expedities', '/expedities/course/bewerken', '/expedities/course/resultaten',
                '/inloggen', '/privacy', '/instellingen')


@pytest.fixture()
def academy_client(tmp_path):
    with academy_preview(tmp_path / 'synthetic-firebase.json') as app:
        yield app.test_client()


def _stylesheets(page):
    return page.xpath('//head/link[@rel="stylesheet"]/@href')


@pytest.mark.parametrize('path', STUDIO_PAGES)
def test_academy_author_pages_layer_the_foundation_last(academy_client, path):
    response = academy_client.get(path)
    assert response.status_code == 200
    page = html.fromstring(response.data)
    assert page.get('data-product') == 'academy'
    sheets = _stylesheets(page)
    assert FONTSHARE_STYLESHEET in sheets
    paths = [sheet.split('?')[0] for sheet in sheets]
    assert paths.index('/static/css/academy-base.css') < paths.index('/static/css/elearning-foundation.css')
    for sheet in sheets:
        if sheet.startswith('/static/'):
            assert academy_client.get(sheet).status_code == 200, sheet


def test_academy_policy_allows_only_the_fontshare_hosts_the_studio_uses(academy_client):
    policy = academy_client.get('/expedities').headers['Content-Security-Policy']
    directives = dict(part.strip().split(' ', 1) for part in policy.split(';'))
    assert 'https://api.fontshare.com' in directives['style-src'].split()
    assert 'https://cdn.fontshare.com' in directives['font-src'].split()
    assert "'unsafe-inline'" not in directives['style-src']


def test_learner_pages_make_no_font_requests_to_fontshare(academy_client):
    player = academy_client.get('/start/synthetic-course-token')
    assert player.status_code == 404
    assert 'fontshare' not in player.text
    assert html.fromstring(player.data).get('data-product') is None


def test_privacy_page_discloses_the_fontshare_request(academy_client):
    page = html.fromstring(academy_client.get('/privacy').data)
    headings = [heading.text_content().strip() for heading in page.iter('h2')]
    assert 'Lettertypen in de studio' in headings
    text = re.sub(r'\s+', ' ', page.text_content())
    assert 'Fontshare' in text and 'IP-adres' in text and 'De deelnemerspagina’s laden deze lettertypen niet' in text


@pytest.mark.parametrize('path', ('/physio/elearning', '/physio/elearning/x/edit', '/physio/elearning/x/responses'))
def test_lecture_processor_studio_keeps_its_own_look(client, path):
    response = client.get(path)
    assert response.status_code == 200
    page = html.fromstring(response.data)
    assert page.get('data-product') is None
    assert not any('fontshare' in sheet or 'elearning-foundation' in sheet for sheet in _stylesheets(page))
