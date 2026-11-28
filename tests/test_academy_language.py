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
    # Older Studio versions also marked the canonical text when a translation changed.
    course['startPage']['title']['_review'] = {'nl': True, 'de': True}
    store.put('elearning_expeditions/course', course)
    response = client.get(endpoint + '?lang=de', headers=headers)
    assert response.status_code == 200
    page = html.fromstring(response.data)
    assert page.get('lang') == 'nl'
    data = json.loads(page.get_element_by_id('academy-initial-course').text)
    assert data['enabledLanguages'] == ['nl']
    assert data['startPage']['title'] == {'nl': 'Voorbeeld'}
    assert store.get('elearning_expeditions/course')['startPage']['title'] == {
        'nl': 'Voorbeeld', 'de': 'Beispiel', 'en': 'Historical text', '_review': {'nl': True, 'de': True},
    }
    course['startPage']['title']['nl'] = ''
    store.put('elearning_expeditions/course', course)
    assert client.get(endpoint).status_code == 410


@pytest.mark.parametrize(('source', 'target'), [('nl', 'de'), ('de', 'nl')])
def test_editing_published_course_preserves_source_and_requires_review_of_stale_translation(studio, source, target):
    client, store = studio
    api = '/api/elearning/expeditions'
    auth = {'Authorization': 'Bearer academy-preview-token', 'X-Elearning-Session': 'author-tab'}
    created = client.post(api, json={'title': 'Route', 'defaultLanguage': source}, headers=auth)
    assert created.status_code == 201
    course = created.json['expedition']
    endpoint = f"{api}/{course['id']}"
    token = course['share']['token']
    assert client.post(endpoint + '/sharing', headers=auth,
                       json={'action': 'update_public', 'enabled': True}).status_code == 200
    lease = client.post(endpoint + '/lease', headers=auth, json={'action': 'acquire'}).json['lease_token']

    def save_as(content, edited):
        response = client.put(endpoint, headers=auth, json={
            **content, 'editedLanguage': edited, 'base_revision': content['revision'], 'lease_token': lease,
        })
        assert response.status_code == 200, response.json
        return response.json['expedition']

    def offered():
        response = client.get('/start/' + token + '?lang=' + target)
        assert response.status_code == 200
        page = html.fromstring(response.data)
        payload = json.loads(page.get_element_by_id('academy-initial-course').text)
        assert client.get('/api/elearning/public/' + token).json['expedition'] == payload
        return payload['enabledLanguages']

    assert offered() == [source]
    course['startPage']['title'][target] = 'Vertaling'
    course = save_as(course, target)
    assert source not in course['startPage']['title'].get('_review', {})
    assert offered() == [source]
    card = client.get(api, headers=auth).json['expeditions'][0]['languageCoverage']
    assert card[source]['needsReview'] == 0 and card[source]['translated'] == card[source]['total']
    assert card[target]['translated'] == 1 < card[target]['total']

    # A historical source flag must not hide the course while an author is still translating it.
    path = 'elearning_expeditions/' + course['id']
    historic = store.get(path)
    historic['startPage']['title']['_review'] = {source: True}
    store.put(path, historic)
    assert offered() == [source]
    assert client.get(api, headers=auth).json['expeditions'][0]['languageCoverage'][source]['needsReview'] == 0
    for _, _, field in model._walk_localized_fields(course):
        if field[source]:
            field[target] = 'Vertaling'
    course = save_as(course, target)
    assert '_review' not in course['startPage']['title']
    assert offered() == ['nl', 'de']

    # Editing the source invalidates the translated field, even when written in the translation workspace.
    edited = client.post(endpoint + '/translations', headers=auth,
                         json={'targetLanguage': source, 'textUpdates': {'startPage.title': 'Gewijzigd'}})
    assert edited.status_code == 200
    assert edited.json['expedition']['startPage']['title']['_review'] == {target: True}
    assert offered() == [source]
    approved = client.post(endpoint + '/translations', headers=auth,
                           json={'targetLanguage': target, 'textUpdates': {'startPage.title': 'Vertaling'}})
    assert approved.status_code == 200
    assert offered() == ['nl', 'de']

    course = approved.json['expedition']
    course['startPage']['title'][source] = 'Laatste versie'
    course = save_as(course, source)
    assert course['startPage']['title']['_review'] == {target: True}
    assert offered() == [source]


def test_every_academy_catalog_key_is_used_and_preserves_its_placeholders():
    """Shared catalog integrity guard. Interaction and first paint are tested separately."""
    import ast
    import re
    from pathlib import Path
    from jinja2 import Environment, nodes

    root = Path(__file__).resolve().parents[1]
    expected = set()
    token = re.compile(r"""\buiText\(\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')""")
    for path in (root / 'static/js').glob('*.js'):
        if path.name.startswith(('elearning-', 'academy-')) and not path.name.endswith('.min.js'):
            expected.update(ast.literal_eval(match[1]) for match in token.finditer(path.read_text()))
    parser = Environment()
    for path in (root / 'templates').rglob('*.html'):
        source = path.read_text()
        if 'xped_t(' in source or '_academy_copy.html' in source or 'elearning' in path.relative_to(root / 'templates').parts:
            for call in parser.parse(source).find_all(nodes.Call):
                name = getattr(call.node, 'name', None)
                if ((name == 'tr' and len(call.args) == 1 or name == 'xped_t' and call.args)
                        and isinstance(call.args[0], nodes.Const)):
                    expected.add(call.args[0].value)

    # The API returns stable English messages shared with LP. Only the Academy UI
    # translates these known messages; an author's custom pause note stays literal.
    error_sources = (
        'lecture_processor/domains/elearning/model.py',
        'lecture_processor/blueprints/academy_collaboration.py',
        'lecture_processor/services/academy_accounts.py',
        'lecture_processor/services/elearning_service.py',
        'lecture_processor/services/elearning_storage.py',
    )
    for path in (root / name for name in error_sources):
        for call in ast.walk(ast.parse(path.read_text())):
            if not isinstance(call, ast.Call):
                continue
            if getattr(call.func, 'id', None) == 'jsonify':
                for keyword in call.keywords:
                    if keyword.arg == 'error' and isinstance(keyword.value, ast.Constant) and isinstance(keyword.value.value, str):
                        expected.add(keyword.value.value)
            if not call.args:
                continue
            name = getattr(call.func, 'id', None) or getattr(call.func, 'attr', None)
            if name == 'ElearningError' and isinstance(call.args[0], ast.Constant) and isinstance(call.args[0].value, str):
                expected.add(call.args[0].value)

    def signature(text):
        parsed = academy_language.compile_message(text)
        if isinstance(parsed, str):
            return (None, set(re.findall(r'\{(\w+)\}', text)))
        branches = {key: set(re.findall(r'\{(\w+)\}', value)) for key, value in parsed['choices'].items()}
        return (parsed['plural'], branches)

    reference = {key: value for group in academy_language.catalog('nl').values() for key, value in group.items()}
    for locale in academy_language.LANGUAGES:
        groups = academy_language.catalog(locale)
        actual = {key: value for group in groups.values() for key, value in group.items()}
        assert sorted(expected - actual.keys()) == [], f'Missing {locale} messages'
        assert sorted(actual.keys() - expected) == [], f'Unused {locale} messages'
        assert len(actual) == sum(map(len, groups.values())), f'Duplicate {locale} messages'
        for key, value in actual.items():
            assert value.strip() and '▁' not in value and '�' not in value, (locale, key, value)
            assert signature(reference[key]) == signature(value), (locale, key, value)
            if not re.fullmatch(r'[a-z][\w.-]*\.[\w.-]+', key):
                assert signature(key) == signature(value), (locale, key, value)


def test_legacy_english_grants_and_writes_cannot_open_an_english_editing_workspace(studio):
    client, store = studio
    auth = {'Authorization': 'Bearer academy-preview-token'}
    created = client.post('/api/elearning/expeditions', json={'title': 'Expeditie'}, headers=auth)
    assert created.status_code == 201
    eid = created.json['expedition']['id']
    course = f'/api/elearning/expeditions/{eid}'
    invitation = {'action': 'create_grant', 'role': 'translate', 'targetLanguage': 'en', 'label': 'Archief'}
    assert client.post(course + '/sharing', json=invitation, headers=auth).status_code == 403
    original = store.get('elearning_expeditions/' + eid)
    assert client.post(course + '/translations', json={'targetLanguage': 'en', 'textUpdates': {'startPage.title': 'Change'}}, headers=auth).status_code == 403
    imported = client.post(course + '/translations/import?target=en', json={'csv': 'key,en\nstartPage.title,Change'}, headers=auth)
    assert imported.status_code == 403
    exported = client.get(course + '/translations/export.csv?target=en', headers=auth)
    assert exported.status_code == 200 and exported.mimetype == 'text/csv'
    assert store.get('elearning_expeditions/' + eid) == original
    grant = client.post(course + '/sharing', json={**invitation, 'targetLanguage': 'de'}, headers=auth)
    assert grant.status_code == 201
    token = grant.json['grant']['urlPath'].rsplit('/', 1)[1]
    path = 'elearning_grants/' + grant.json['grant']['id']
    current = store.get(path)
    store.put(path, {**current, 'target_language': 'en'})
    assert client.post('/api/elearning/grant-session', json={'token': token}).status_code == 403
    assert client.get(course + '/sharing', headers=auth).json['grants'] == []
    assert store.get(path)['target_language'] == 'en'


def test_cardinal_messages_render_before_javascript_and_keep_inserted_text_literal(studio):
    client, _ = studio
    for locale, expected in [('nl', '7 dagen'), ('de', '7 Tage')]:
        client.set_cookie('xped-language', locale)
        page = html.fromstring(client.get('/').data)
        assert page.xpath('string(//button[@data-days="7"])') == expected
        scoped = json.loads(client.get(f'/academy/messages/{locale}/overview.js').text.removeprefix('window.XpedMessages=').removesuffix(';'))
        assert scoped['overview.days']['plural'] == 'count'
        assert 'workspace.people' not in scoped
    example = '{count, plural, =0 {Nog niemand} one {{name} heeft # stap} other {{name} heeft # stappen}}'
    assert academy_language.format_message(example, {'count': 0}) == 'Nog niemand'
    assert academy_language.format_message(example, {'count': 1, 'name': '{count} #'}) == '{count} # heeft 1 stap'
    assert academy_language.format_message(example, {'count': 1200, 'name': 'Ada'}) == 'Ada heeft 1.200 stappen'
    with pytest.raises(ValueError):
        academy_language.compile_message('{count, plural, one {# stap}}')
