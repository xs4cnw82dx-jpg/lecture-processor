"""Behavioral & security tests for xPEDitie Pijn E-Learning Studio, Translation Workflow, and Public Player."""
from __future__ import annotations

import csv
import io
import threading
from copy import deepcopy

import pytest

from lecture_processor.domains.elearning import model
from lecture_processor.services import elearning_service as service


class MemoryStore:
    def __init__(self):
        self.data = {}
        self.lock = threading.RLock()

    def get(self, path):
        return deepcopy(self.data.get(path))

    cached = get

    def put(self, path, value):
        self.data[path] = deepcopy(value)

    def delete(self, path):
        self.data.pop(path, None)

    def list(self, collection, field=None, value=None, operator='==', limit=200, fields=None):
        prefix = collection + '/'
        rows = [
            dict(deepcopy(v), _id=k[len(prefix):])
            for k, v in self.data.items()
            if k.startswith(prefix) and '/' not in k[len(prefix):]
        ]
        if field:
            if operator == 'array_contains':
                rows = [r for r in rows if value in (r.get(field) or [])]
            else:
                rows = [r for r in rows if r.get(field) == value]
        return rows[:limit]

    stream = list

    def count(self, collection, filters):
        return sum(all(row.get(field) == value for field, _, value in filters)
                   for row in self.list(collection, limit=None))

    def atomic(self, operation):
        with self.lock:
            before = deepcopy(self.data)
            try:
                return operation(self)
            except Exception:
                self.data = before
                raise


@pytest.fixture
def setup(client, monkeypatch, runtime):
    db = MemoryStore()
    monkeypatch.setattr(service, '_store', lambda _rt: db)
    monkeypatch.setattr(service.lifecycle, 'ensure_account_allows_writes', lambda *a, **kw: (True, ''))
    monkeypatch.setattr(
        runtime.core,
        'verify_firebase_token',
        lambda req: {
            'uid': req.headers['Authorization'].replace('Bearer ', ''),
            'email': req.headers['Authorization'].replace('Bearer ', '') + '@example.com',
            'email_verified': True,
        } if req.headers.get('Authorization') else None,
        raising=False,
    )
    return client, db


def auth_headers(user='owner', session='tab-1', **extra):
    return {'Authorization': 'Bearer ' + user, 'X-Elearning-Session': session, **extra}


def _create_sample(client, *, enable_public: bool = True):
    payload = {
        'title': 'xPEDitie Pijn Pilot',
        'defaultLanguage': 'nl',
        'enabledLanguages': ['nl', 'en', 'de'],
        'startPage': {
            'eyebrow': {'nl': 'XPEDITIE PIJN', 'en': 'XPEDITION PAIN', 'de': ''},
            'title': {'nl': 'Begrijp je pijn', 'en': 'Understand your pain', 'de': ''},
            'subtitle': {'nl': 'Stap voor stap', 'en': 'Step by step', 'de': ''},
            'ctaLabel': {'nl': 'Start', 'en': 'Start', 'de': ''},
        },
        'modules': [
            {
                'id': 'mod_bio',
                'title': {'nl': 'Station 1: Zenuwstelsel', 'en': 'Station 1: Nervous system', 'de': ''},
                'domain': 'bio',
                'estimatedMinutes': 6,
                'visibleToLearners': True,
                'steps': [
                    {
                        'id': 'stp_1',
                        'title': {'nl': 'Feit of Fabel', 'en': 'Myth or Fact', 'de': ''},
                        'authorNotes': 'INTERNAL THESIS NOTE: confirm citation with PhD candidate',
                        'blocks': [
                            {
                                'id': 'blk_mf',
                                'type': 'myth_fact',
                                'data': {
                                    'statement': {'nl': 'Pijn betekent altijd schade.', 'en': 'Pain always means damage.', 'de': ''},
                                    'correctAnswer': 'myth',
                                    'explanation': {'nl': 'Fabel — pijn is een alarmsignaal.', 'en': 'Myth — pain is an alarm.', 'de': ''},
                                },
                                'settings': {'showPeerResults': True},
                            },
                            {
                                'id': 'blk_vid',
                                'type': 'video',
                                'data': {
                                    'title': {'nl': 'Uitlegvideo', 'en': 'Explainer video', 'de': ''},
                                    'url': 'https://youtu.be/dQw4w9WgXcQ?t=45',
                                },
                                'settings': {},
                            },
                        ],
                    }
                ],
            },
            {
                'id': 'mod_hidden',
                'title': {'nl': 'Verborgen concept', 'en': 'Hidden draft', 'de': ''},
                'domain': 'social',
                'visibleToLearners': False,
                'steps': [{'id': 'stp_h', 'title': {'nl': 'Draft'}, 'blocks': []}],
            },
        ],
    }
    resp = client.post('/api/elearning/expeditions', json=payload, headers=auth_headers('owner'))
    assert resp.status_code == 201, resp.json
    exp = resp.json['expedition']
    assert exp['share']['enabled'] is False
    if enable_public:
        upd = client.post(
            f"/api/elearning/expeditions/{exp['id']}/sharing",
            json={'action': 'update_public', 'enabled': True, 'collectResponses': True,
                  'showPeerResults': True, 'collectPilotFeedback': True},
            headers=auth_headers('owner'),
        )
        assert upd.status_code == 200
        exp['share'] = upd.json['share']
    return exp


def _post_pilot_response(client, url, *, json):
    options = client.get(url.removesuffix('/responses')).json['expedition']['shareOptions']
    return client.post(url, json={**json, 'consent': True, 'collectionVersion': options['collectionVersion']})


def test_crud_coediting_lease_and_revision_conflict(setup):
    client, _ = setup
    exp = _create_sample(client)
    eid = exp['id']

    # Stranger blocked
    assert client.get(f'/api/elearning/expeditions/{eid}', headers=auth_headers('stranger')).status_code == 403
    assert client.get('/api/elearning/expeditions').status_code == 401

    # Add thesis partner as co-editor
    add = client.post(
        f'/api/elearning/expeditions/{eid}/sharing',
        json={'action': 'add_member', 'email': 'partner@example.com', 'role': 'edit'},
        headers=auth_headers('owner'),
    )
    assert add.status_code == 200
    partner_list = client.get('/api/elearning/expeditions', headers=auth_headers('partner')).json['expeditions']
    assert len(partner_list) == 1 and partner_list[0]['role'] == 'edit'

    # Lease contention & takeover
    l1 = client.post(f'/api/elearning/expeditions/{eid}/lease', json={'action': 'acquire'}, headers=auth_headers('owner', 'tab-1'))
    assert l1.status_code == 200 and l1.json['granted'] is True
    token1 = l1.json['lease_token']

    l2 = client.post(f'/api/elearning/expeditions/{eid}/lease', json={'action': 'acquire'}, headers=auth_headers('partner', 'tab-2'))
    assert l2.status_code == 200 and l2.json['granted'] is False

    # Valid save increments revision
    exp['title'] = 'Updated Pilot Title'
    save1 = client.put(
        f'/api/elearning/expeditions/{eid}',
        json={**exp, 'lease_token': token1, 'base_revision': 1, 'editedLanguage': 'nl'},
        headers=auth_headers('owner', 'tab-1'),
    )
    assert save1.status_code == 200 and save1.json['expedition']['revision'] == 2

    # Stale revision rejected with 409
    stale = client.put(
        f'/api/elearning/expeditions/{eid}',
        json={**exp, 'lease_token': token1, 'base_revision': 1, 'editedLanguage': 'nl'},
        headers=auth_headers('owner', 'tab-1'),
    )
    assert stale.status_code == 409


def test_german_translator_grant_isolation_csv_and_review_flag(setup):
    client, _ = setup
    exp = _create_sample(client)
    eid = exp['id']

    # Owner creates a revocable German translator link
    g_resp = client.post(
        f'/api/elearning/expeditions/{eid}/sharing',
        json={'action': 'create_grant', 'role': 'translate', 'targetLanguage': 'de', 'label': 'German Editor'},
        headers=auth_headers('owner'),
    )
    assert g_resp.status_code == 201
    raw_token = g_resp.json['grant']['urlPath'].split('/')[-1]

    # Exchange grant token for signed X-Elearning-Access header (zero Firebase login needed)
    ex = client.post('/api/elearning/grant-session', json={'token': raw_token})
    assert ex.status_code == 200
    t_headers = {'X-Elearning-Access': ex.json['accessToken'], 'X-Elearning-Session': 'tr-tab'}

    # Translator cannot mutate structure or save another language
    assert client.put(f'/api/elearning/expeditions/{eid}', json=exp, headers=t_headers).status_code == 403
    assert client.post(
        f'/api/elearning/expeditions/{eid}/translations',
        json={'targetLanguage': 'nl', 'textUpdates': {'startPage.title': 'Hijack'}},
        headers=t_headers,
    ).status_code == 403

    # Translator CAN save German text + German YouTube video override
    tr_save = client.post(
        f'/api/elearning/expeditions/{eid}/translations',
        json={
            'targetLanguage': 'de',
            'textUpdates': {
                'startPage.title': 'Verstehe deinen Schmerz',
                'mod.mod_bio.stp.stp_1.blk.blk_mf.statement': 'Schmerz bedeutet immer Gewebeschaden.',
            },
            'mediaUpdates': {
                'blk_vid': 'https://www.youtube.com/watch?v=abcdefghijk',
            },
        },
        headers=t_headers,
    )
    assert tr_save.status_code == 200
    saved_exp = tr_save.json['expedition']
    assert saved_exp['startPage']['title']['de'] == 'Verstehe deinen Schmerz'
    assert saved_exp['startPage']['title']['nl'] == 'Begrijp je pijn'
    vid_ov = saved_exp['modules'][0]['steps'][0]['blocks'][1]['data']['mediaOverrides']['de']
    assert vid_ov['embedUrl'] == 'https://www.youtube-nocookie.com/embed/abcdefghijk'

    # CSV export & re-import round-trip
    csv_resp = client.get(f'/api/elearning/expeditions/{eid}/translations/export.csv?source=nl&target=de', headers=t_headers)
    assert csv_resp.status_code == 200
    csv_text = csv_resp.data.decode('utf-8-sig')
    assert 'Verstehe deinen Schmerz' in csv_text
    updated_csv = csv_text.replace('Verstehe deinen Schmerz', 'Schmerzen verstehen')
    imp = client.post(
        f'/api/elearning/expeditions/{eid}/translations/import?target=de',
        json={'csv': updated_csv},
        headers=t_headers,
    )
    assert imp.status_code == 200 and imp.json['appliedCount'] >= 1
    assert imp.json['expedition']['startPage']['title']['de'] == 'Schmerzen verstehen'

    # If owner edits Dutch source text later, existing German translation is flagged _review.de = True (never wiped!)
    lease_res = client.post(f'/api/elearning/expeditions/{eid}/lease', json={'action': 'acquire'}, headers=auth_headers('owner', 'tab-1'))
    latest = imp.json['expedition']
    latest['startPage']['title']['nl'] = 'Begrijp jouw aanhoudende pijn'
    owner_save = client.put(
        f'/api/elearning/expeditions/{eid}',
        json={**latest, 'lease_token': lease_res.json['lease_token'], 'base_revision': latest['revision'], 'editedLanguage': 'nl'},
        headers=auth_headers('owner', 'tab-1'),
    )
    assert owner_save.status_code == 200
    title_loc = owner_save.json['expedition']['startPage']['title']
    assert title_loc['de'] == 'Schmerzen verstehen'
    assert title_loc.get('_review', {}).get('de') is True


def test_public_player_sanitization_responses_aggregates_and_scoped_csp(setup):
    client, _ = setup
    exp = _create_sample(client)
    eid = exp['id']
    share_token = exp['share']['token']

    # Public fetch strips authorNotes, hidden modules, and internal members
    pub = client.get(f'/api/elearning/public/{share_token}')
    assert pub.status_code == 200
    pub_exp = pub.json['expedition']
    assert len(pub_exp['modules']) == 1
    assert pub_exp['modules'][0]['id'] == 'mod_bio'
    assert 'authorNotes' not in pub_exp['modules'][0]['steps'][0]
    assert 'members' not in pub_exp

    # Learner submits anonymous response + pilot usability feedback
    sub = _post_pilot_response(
        client,
        f'/api/elearning/public/{share_token}/responses',
        json={
            'sessionId': 'learner_session_001',
            'cohort': 'patients-pilot',
            'language': 'nl',
            'answers': {'blk_mf': 'myth'},
            'peerDisclosureTypes': {'blk_mf': 'myth_fact'},
            'visitedStepIds': ['stp_1'],
            'completed': True,
            'pilotFeedback': {'clarity': 5, 'engagement': 4, 'comment': 'Zeer prettige rustige vormgeving!'},
        },
    )
    assert sub.status_code == 200 and sub.json['saved'] is True

    # Peer aggregate works for enabled block
    agg = client.get(f'/api/elearning/public/{share_token}/aggregates/blk_mf')
    assert agg.status_code == 200
    assert agg.json['aggregate']['counts']['myth'] == 1

    # Owner sees response analytics & CSV export
    analytics = client.get(f'/api/elearning/expeditions/{eid}/responses?cohort=patients-pilot', headers=auth_headers('owner'))
    assert analytics.status_code == 200
    assert analytics.json['summary']['totalSessions'] == 1
    assert analytics.json['summary']['avgClarity'] == 5.0
    csv_out = client.get(f'/api/elearning/expeditions/{eid}/responses/export.csv', headers=auth_headers('owner'))
    assert csv_out.status_code == 200 and b'patients-pilot' in csv_out.data

    # Pausing share link blocks public access with 410
    client.post(
        f'/api/elearning/expeditions/{eid}/sharing',
        json={'action': 'update_public', 'enabled': False, 'pausedMessage': 'Even pauze'},
        headers=auth_headers('owner'),
    )
    paused = client.get(f'/api/elearning/public/{share_token}')
    assert paused.status_code == 410 and 'Even pauze' in paused.json['error']

    # Scoped CSP & Sidebar wiring checks
    dash_html = client.get('/physio/elearning')
    assert dash_html.status_code == 200
    assert 'https://www.youtube-nocookie.com' in dash_html.headers['Content-Security-Policy']
    assert b'xPEDitie Pijn Studio' in dash_html.data

    player_html = client.get(f'/elearning/p/{share_token}')
    assert player_html.status_code == 200
    assert 'https://www.youtube-nocookie.com' in player_html.headers['Content-Security-Policy']

    normal_dash = client.get('/dashboard')
    assert 'youtube-nocookie.com' not in normal_dash.headers.get('Content-Security-Policy', '')


def test_video_url_parser_security():
    yt = model.parse_video_url('https://www.youtube.com/shorts/dQw4w9WgXcQ?t=1m30s')
    assert yt['embedUrl'] == 'https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ'
    assert yt['startSeconds'] == 90
    vm = model.parse_video_url('https://vimeo.com/123456789')
    assert vm['embedUrl'] == 'https://player.vimeo.com/video/123456789'
    with pytest.raises(model.ElearningError):
        model.parse_video_url('javascript:alert(1)')



def test_v3_step_comments_glossary_reveal_and_review_status(setup):
    client, _ = setup
    exp = _create_sample(client)
    eid = exp['id']
    share_token = exp['share']['token']

    # Enable public link + slide reviewer comments
    upd = client.post(
        f'/api/elearning/expeditions/{eid}/sharing',
        json={'action': 'update_public', 'enabled': True, 'allowStepComments': True},
        headers=auth_headers('owner'),
    )
    assert upd.status_code == 200 and upd.json['share']['allowStepComments'] is True

    pub = client.get(f'/api/elearning/public/{share_token}').json['expedition']
    assert pub['shareOptions']['allowStepComments'] is True

    # Submit reviewer slide comment
    sub = _post_pilot_response(
        client,
        f'/api/elearning/public/{share_token}/responses',
        json={
            'sessionId': 'lrn_physio_rev1',
            'cohort': 'physio-review',
            'language': 'nl',
            'answers': {'blk_mf': 'myth'},
            'visitedStepIds': ['stp_1'],
            'stepComments': [{
                'moduleId': 'mod_bio',
                'stepId': 'stp_1',
                'moduleTitle': 'Alarmsysteem',
                'stepTitle': 'Feit of Fabel',
                'comment': 'Mooie uitleg, eventueel nog een voorbeeld toevoegen.',
            }],
        },
    )
    assert sub.status_code == 200
    analytics = client.get(f'/api/elearning/expeditions/{eid}/responses', headers=auth_headers('owner')).json
    assert len(analytics['stepComments']) == 1
    assert 'voorbeeld' in analytics['stepComments'][0]['comment']

    # Normalize supports review status, glossary, and revealAfterAnswer
    norm = model.normalize_expedition_payload({
        'title': 'v3 Test',
        'glossary': [{'nl': 'Draagkracht', 'en': 'Resources', 'de': 'Belastbarkeit'}],
        'modules': [{
            'title': {'nl': 'Station 1'},
            'steps': [{
                'title': {'nl': 'Stap 1'},
                'status': 'review',
                'blocks': [{
                    'type': 'callout',
                    'data': {'title': {'nl': 'Tip'}, 'body': {'nl': 'Tekst'}},
                    'settings': {'revealAfterAnswer': True},
                }],
            }],
        }],
    })
    assert norm['glossary'][0]['de'] == 'Belastbarkeit'
    assert norm['modules'][0]['steps'][0]['status'] == 'review'
    assert norm['modules'][0]['steps'][0]['blocks'][0]['settings']['revealAfterAnswer'] is True

    # Custom SVG / Animation slot sanitizes scripts and event handlers
    sanitized = model.sanitize_svg_markup('<svg viewBox="0 0 10 10" onload="alert(1)"><script>evil()</script><circle cx="5" cy="5" r="4" onclick="bad()"/></svg>')
    assert '<script' not in sanitized.lower()
    assert 'onload' not in sanitized.lower()
    assert 'onclick' not in sanitized.lower()
    assert '<circle' in sanitized


def test_public_media_and_results_only_use_visible_course_content(setup, monkeypatch):
    client, db = setup
    course = _create_sample(client)
    eid = course['id']
    public = '/api/elearning/public/' + course['share']['token']
    saved = db.get('elearning_expeditions/' + eid)
    saved['startPage']['heroMedia'] = {'kind': 'asset', 'assetId': 'visible_media'}
    saved['modules'][1]['steps'][0]['blocks'] = [
        {'id': 'blk_hidden', 'type': 'image', 'data': {'media': {'kind': 'asset', 'assetId': 'draft_media'}},
         'settings': {'showPeerResults': True}},
    ]
    db.put('elearning_expeditions/' + eid, saved)
    for aid in ('visible_media', 'draft_media'):
        db.put('elearning_assets/' + aid, {'id': aid, 'expedition_id': eid, 'path': aid,
                                          'size': 3, 'content_type': 'image/webp'})
    monkeypatch.setattr(service.book_storage, 'request', lambda *_args, **_kwargs: b'img')
    assert client.get(public + '/assets/visible_media').status_code == 200
    assert client.get(public + '/assets/draft_media').status_code == 404
    def unexpected_read(*args, **kwargs):
        pytest.fail('Metadata reads must not download or charge for course media')

    monkeypatch.setattr(service.elearning_storage, 'read_asset', unexpected_read)
    assert client.head(public + '/assets/visible_media').content_length == 3
    assert client.head(public + '/assets/draft_media').status_code == 404
    assert client.head(f'/api/elearning/expeditions/{eid}/assets/visible_media',
                       headers=auth_headers('stranger')).status_code == 403
    meta = db.get('elearning_assets/visible_media')
    db.put('elearning_assets/visible_media', {**meta, 'ready': False})
    assert client.head(public + '/assets/visible_media').status_code == 404
    assert client.get(public + '/aggregates/blk_hidden').status_code == 403


def test_collection_settings_and_session_progress_are_respected(setup):
    client, db = setup
    course = _create_sample(client)
    eid = course['id']
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    client.post(f'/api/elearning/expeditions/{eid}/sharing', headers=auth_headers(), json={
        'action': 'update_public', 'collectPilotFeedback': False, 'allowStepComments': False})
    for completed in (True, False):
        result = _post_pilot_response(client, url, json={'sessionId': 'learner_session', 'answers': {'blk_mf': 'myth', 'draft_answer': 'A'},
                                        'visitedStepIds': ['stp_1', 'stp_h'], 'completed': completed,
                                        'stepComments': [{'stepId': 'stp_1', 'comment': 'Comment'}],
                                        'pilotFeedback': {'clarity': 5}})
        assert result.status_code == 200
    record = db.get('elearning_responses/' + eid + '__learner_session')
    assert record['completed']
    assert record['answers'] == {'blk_mf': 'myth'}
    assert record['visitedStepIds'] == ['stp_1']
    assert record['stepComments'] == [] and record['pilotFeedback'] is None


def test_delete_retries_storage_cleanup_without_losing_accounting(setup, monkeypatch):
    import io

    client, db = setup
    course = _create_sample(client)
    eid = course['id']
    url = '/api/elearning/expeditions/' + eid
    stored = {}

    def storage_request(method, path, data=None, content_type=None):
        if method == 'POST':
            stored[path] = data
        if method == 'DELETE':
            raise service.BookError('Temporary storage interruption', 503)

    monkeypatch.setattr(service.book_storage, 'configured', lambda: True)
    monkeypatch.setattr(service.book_storage, 'request', storage_request)
    audio = b'OggS' + bytes(80)
    media = client.post(url + '/assets', headers=auth_headers(),
                        data={'file': (io.BytesIO(audio), 'lesson.ogg', 'audio/ogg')})
    assert media.status_code == 201
    assert db.get('book_usage/storage')['bytes'] == len(audio)
    assert client.delete(url, headers=auth_headers()).status_code == 503
    assert stored and db.get('book_usage/storage')['bytes'] == len(audio)
    assert client.get('/api/elearning/public/' + course['share']['token']).status_code in (404, 410)
    monkeypatch.setattr(service.book_storage, 'request', lambda method, path: stored.pop(path, None))
    assert client.delete(url, headers=auth_headers()).status_code == 200
    assert not stored and db.get('book_usage/storage')['bytes'] == 0
    assert not any(key.startswith('elearning_') for key in db.data)


def test_account_portability_and_cleanup_preserve_collaborators_courses(setup, monkeypatch, runtime):
    from lecture_processor.services import elearning_account_service as accounts

    client, db = setup
    monkeypatch.setattr(accounts, 'ElearningStore', lambda _: db)
    own = _create_sample(client)
    owned_id = own['id']
    foreign = client.post('/api/elearning/expeditions', json={'title': 'Separate course'},
                          headers=auth_headers('partner')).json['expedition']
    fid = foreign['id']
    for eid, member, owner in ((owned_id, 'partner', 'owner'), (fid, 'owner', 'partner')):
        url = f'/api/elearning/expeditions/{eid}/sharing'
        client.post(url, json={'action': 'add_member', 'email': member + '@example.com', 'role': 'edit'},
                    headers=auth_headers(owner))
    client.post(f'/api/elearning/expeditions/{owned_id}/sharing', headers=auth_headers(),
                json={'action': 'create_grant', 'targetLanguage': 'de'})
    _post_pilot_response(client, '/api/elearning/public/' + own['share']['token'] + '/responses',
                json={'sessionId': 'learner_001', 'answers': {'blk_mf': 'fact'}})
    db.put('elearning_assets/shared_asset', {'id': 'shared_asset', 'expedition_id': fid, 'uploaded_by': 'owner'})
    exported, = accounts.collect(runtime, 'owner')
    assert exported['id'] == owned_id and exported['responses'][0]['answers'] == {'blk_mf': 'fact'}
    assert 'token' not in exported['share'] and 'lease' not in exported
    assert accounts.delete_owned(runtime, 'owner', 'owner@example.com') == 1
    assert accounts.delete_owned(runtime, 'owner', 'owner@example.com') == 0
    assert db.get('elearning_assets/shared_asset') == {'id': 'shared_asset', 'expedition_id': fid}
    assert not db.list('elearning_responses') and not db.list('elearning_grants') and not db.list('elearning_grant_tokens')
    assert len(db.list('elearning_share_index')) == 1 and db.get('elearning_expeditions/' + fid)['members'] == {}
    assert client.get('/api/elearning/expeditions/' + fid, headers=auth_headers('partner')).status_code == 200


@pytest.mark.parametrize('path', [
    '/physio/elearning', '/physio/elearning/example/edit', '/physio/elearning/example/responses',
    '/elearning/translate/example', '/elearning/p/example',
])
def test_all_learning_html_routes_render_with_route_scoped_headers(client, path):
    response = client.get(path)
    assert response.status_code == 200
    assert response.mimetype == 'text/html'
    assert response.headers['Cache-Control'] == 'private, no-store'
    csp = response.headers['Content-Security-Policy']
    assert 'https://www.youtube-nocookie.com' in csp
    assert 'https://player.vimeo.com' in csp


def test_spreadsheet_downloads_protect_authored_and_learner_text(setup):
    import csv
    import io

    client, _ = setup
    own = _create_sample(client)
    eid = own['id']
    url = '/api/elearning/expeditions/' + eid
    client.post(url + '/translations', headers=auth_headers(),
                json={'targetLanguage': 'de', 'textUpdates': {'startPage.title': '+ Eingang'}})
    translated = client.get(url + '/translations/export.csv?target=de', headers=auth_headers())
    rows = list(csv.DictReader(io.StringIO(translated.data.decode('utf-8-sig'))))
    assert next(r for r in rows if r['field_key'] == 'startPage.title')['target_de'] == "'+ Eingang"
    _post_pilot_response(client, '/api/elearning/public/' + own['share']['token'] + '/responses', json={
        'sessionId': 'learner_003', 'pilotFeedback': {'comment': '+ Helder'}})
    responses = client.get(url + '/responses/export.csv', headers=auth_headers())
    row, = csv.DictReader(io.StringIO(responses.data.decode('utf-8-sig')))
    assert row['pilot_comment'] == "'+ Helder"


def test_copy_owns_its_media_after_original_is_removed(setup, monkeypatch):
    import io

    client, db = setup
    source = _create_sample(client)
    eid = source['id']
    url = '/api/elearning/expeditions/' + eid
    stored = {}

    def storage_request(method, path, data=None, **kwargs):
        if method == 'POST':
            stored[path] = data
        if method == 'GET':
            return stored[path]
        if method == 'DELETE':
            stored.pop(path, None)

    monkeypatch.setattr(service.book_storage, 'request', storage_request)
    monkeypatch.setattr(service.book_storage, 'configured', lambda: True)
    audio = b'OggS' + bytes(80)
    media = client.post(url + '/assets', headers=auth_headers(),
                        data={'file': (io.BytesIO(audio), 'lesson.ogg', 'audio/ogg')}).json['asset']
    current = db.get('elearning_expeditions/' + eid)
    current['modules'][0]['steps'][0]['blocks'].append({
        'id': 'audio_step', 'type': 'audio', 'data': {'media': {'kind': 'asset', 'assetId': media['id']}}})
    db.put('elearning_expeditions/' + eid, current)
    response = client.post(url + '/duplicate', headers=auth_headers(), json={})
    assert response.status_code == 201
    copy = response.json['expedition']
    copied_asset = copy['modules'][0]['steps'][0]['blocks'][-1]['data']['media']['assetId']
    assert copied_asset != media['id']
    assert client.delete(url, headers=auth_headers()).status_code == 200
    copied_url = '/api/elearning/expeditions/' + copy['id'] + '/assets/' + copied_asset
    assert client.get(copied_url, headers=auth_headers()).data == audio
    assert db.get('book_usage/storage')['bytes'] == len(audio)


def test_document_limit_fails_with_actionable_status_before_storage():
    from lecture_processor.repositories.elearning_repo import document_fields

    assert document_fields({'text': 'A study prompt', 'answers': [['one']]}) == {
        'text': 'A study prompt', 'answers': [{'_el_list': ['one']}]}
    with pytest.raises(model.ElearningError) as exc:
        document_fields({'text': 'ü' * 600_000})
    assert exc.value.status == 413


@pytest.mark.parametrize('disabled_setting', ['course', 'block'])
def test_peer_word_cloud_only_includes_answers_disclosed_when_first_entered(setup, monkeypatch, disabled_setting):
    client, db = setup
    monkeypatch.setattr(service, 'PEER_RESULT_SECONDS', 0)
    course = _create_sample(client)
    path = 'elearning_expeditions/' + course['id']
    url = '/api/elearning/public/' + course['share']['token']
    cloud = {'id': 'cloud', 'type': 'wordcloud', 'data': {'maxWords': 3}, 'settings': {'showPeerResults': True}}
    course['modules'][0]['steps'][0]['blocks'] = [cloud]
    settings = course['share'] if disabled_setting == 'course' else cloud['settings']
    settings['showPeerResults'] = False
    db.put(path, course)

    def answer(session, words, disclosed, expected_status=200):
        result = _post_pilot_response(client, url + '/responses', json={
            'sessionId': session, 'answers': {'cloud': words},
            'peerDisclosureTypes': {'cloud': 'wordcloud'} if disclosed else {},
        })
        assert result.status_code == expected_status

    answer('stored_private', ['private at entry'], True)
    db.put('elearning_responses/' + course['id'] + '__legacy_learner', {
        'expedition_id': course['id'], 'answers': {'cloud': ['legacy']}})
    settings['showPeerResults'] = True
    db.put(path, course)
    # Replaying a full progress snapshot cannot promote a previously private answer.
    answer('stored_private', ['private at entry'], True)
    answer('legacy_learner', ['legacy', 'added later'], True, expected_status=409)
    # The learner who submitted after the change still saw the private course.
    answer('delayed_learner', ['delayed private'], False)
    answer('public_learner', ['shared'], True)

    def aggregate():
        response = client.get(url + '/aggregates/cloud')
        assert response.status_code == 200
        return response.json['aggregate']

    assert aggregate() == {'type': 'wordcloud', 'count': 1, 'words': [{'word': 'shared', 'count': 1}]}
    owner = client.get('/api/elearning/expeditions/' + course['id'] + '/responses', headers=auth_headers())
    assert owner.json['blockStats']['cloud']['count'] == 4
    answer('public_learner', ['updated shared'], True)
    assert aggregate()['words'] == [{'word': 'updated shared', 'count': 1}]
    answer('public_learner', ['private edit'], False)
    answer('public_learner', ['private edit'], True)
    assert aggregate() == {'type': 'wordcloud', 'count': 0, 'words': []}


def test_peer_results_cannot_reinterpret_an_existing_answer_as_public_words(setup):
    client, db = setup
    course = _create_sample(client)
    path = 'elearning_expeditions/' + course['id']
    bid = 'reused_block'
    block = {'id': bid, 'type': 'reflection', 'data': {}, 'settings': {'showPeerResults': True}}
    course['modules'][0]['steps'][0]['blocks'] = [block]
    db.put(path, course)
    url = '/api/elearning/public/' + course['share']['token']
    posted = _post_pilot_response(client, url + '/responses', json={
        'sessionId': 'answer_session', 'answers': {bid: 'reflection content'},
        'peerDisclosureTypes': {bid: 'reflection'},
    })
    assert posted.status_code == 200
    block['type'] = 'wordcloud'
    db.put(path, course)
    assert client.get(url + '/aggregates/' + bid).json['aggregate'] == {'type': 'wordcloud', 'count': 0, 'words': []}


def test_large_pilot_totals_csv_and_repeated_peer_reads(setup, monkeypatch):
    import csv
    import io

    client, db = setup
    course = _create_sample(client)
    eid = course['id']
    peer_url = '/api/elearning/public/' + course['share']['token'] + '/aggregates/blk_mf'
    list_responses = db.list
    queries = []

    def counted(collection, *args, **kwargs):
        if collection == 'elearning_responses':
            queries.append(collection)
        return list_responses(collection, *args, **kwargs)
    monkeypatch.setattr(db, 'list', counted)
    for i in range(501):
        db.put(f'elearning_responses/{eid}_{i}', {'expedition_id': eid, 'session_id': f'session_{i}',
                                                  'answers': {'blk_mf': 'myth'}, 'completed': True,
                                                  'peerAnswers': {'blk_mf': {'myth_fact': 'myth'}}})
    for _ in range(2):
        assert client.get(peer_url).json['aggregate']['counts'] == {'myth': 501}
    assert len(queries) == 1
    owner_url = '/api/elearning/expeditions/' + eid + '/responses'
    assert client.get(owner_url, headers=auth_headers()).json['summary']['totalSessions'] == 501
    output = client.get(owner_url + '/export.csv', headers=auth_headers()).data.decode('utf-8-sig')
    assert len(list(csv.DictReader(io.StringIO(output)))) == 501


def test_sharing_changes_preserve_a_collaborators_interleaved_save(setup, monkeypatch):
    client, db = setup
    course = _create_sample(client)
    eid = course['id']
    atomic = db.atomic
    path = 'elearning_expeditions/' + eid

    def after_collaborator_save(operation):
        latest = db.get(path)
        latest.update(title='Saved by co-author', revision=latest['revision'] + 1)
        db.put(path, latest)
        return atomic(operation)

    monkeypatch.setattr(db, 'atomic', after_collaborator_save)
    response = client.post('/api/elearning/expeditions/' + eid + '/sharing', headers=auth_headers(), json={
        'action': 'update_public', 'rotateToken': True, 'collectPilotFeedback': False})
    assert response.status_code == 200
    assert db.get(path)['title'] == 'Saved by co-author'
    assert db.get(path)['revision'] == 2
    assert db.get('elearning_share_index/' + course['share']['token']) is None
    assert db.get('elearning_share_index/' + response.json['share']['token'])['expedition_id'] == eid


def test_budget_refusal_leaves_media_and_project_unchanged(setup, monkeypatch):
    import io

    client, db = setup
    course = _create_sample(client)
    eid = course['id']
    requested = []
    monkeypatch.setattr(service.book_storage, 'configured', lambda: True)
    monkeypatch.setattr(service.book_storage, 'request', lambda *args, **kwargs: requested.append(args))
    db.put('book_usage/storage', {'bytes': service.book_storage.GLOBAL_BYTES})
    response = client.post('/api/elearning/expeditions/' + eid + '/assets', headers=auth_headers(),
                           data={'file': (io.BytesIO(b'OggS' + bytes(25)), 'example.ogg', 'audio/ogg')})
    assert response.status_code == 413
    assert requested == [] and db.list('elearning_assets') == []
    assert db.get('book_usage/storage')['bytes'] == service.book_storage.GLOBAL_BYTES


def test_custom_visual_publishes_finished_art_without_the_drafting_brief(setup):
    client, db = setup
    course = _create_sample(client)
    eid = course['id']
    root = 'elearning_expeditions/' + eid
    draft = db.get(root)
    blocks = draft['modules'][0]['steps'][0]['blocks']
    for preset in ('breathing-circle', 'placeholder'):
        blocks.append({'id': preset, 'type': 'custom_visual', 'settings': {},
                       'data': {'preset': preset, 'agentBrief': 'internal notes', 'slotId': 'internal slot'}})
    db.put(root, draft)
    published = client.get('/api/elearning/public/' + course['share']['token']).json['expedition']
    by_id = {b['id']: b for b in published['modules'][0]['steps'][0]['blocks']}
    assert by_id['breathing-circle']['data'] == {'preset': 'breathing-circle'}
    assert 'placeholder' not in by_id
    assert db.get(root)['modules'][0]['steps'][0]['blocks'][-1]['data']['agentBrief'] == 'internal notes'


def test_learning_telemetry_keeps_tokens_and_learner_text_private():
    import json
    from lecture_processor.calendar_observability import redact_calendar_url, scrub_calendar_event

    path = '/api/elearning/public/synthetic-link/responses'
    event = {'request': {'url': path, 'data': {'answers': {'reflection': 'synthetic-answer'}},
                         'headers': {'X-Elearning-Access': 'synthetic-access'}},
             'exception': {'vars': {'learner': 'synthetic-name'}},
             'breadcrumbs': [{'url': '/elearning/translate/synthetic-grant'},
                             {'url': '/elearning/p/synthetic-link'}]}
    assert redact_calendar_url(path) == '/api/elearning/public/[redacted]/responses'
    assert 'synthetic-' not in json.dumps(scrub_calendar_event(event))
    assert event['request']['data']['answers']['reflection'] == 'synthetic-answer'


def test_learner_response_size_errors_describe_the_learning_request(setup):
    client, _ = setup
    course = _create_sample(client)
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    result = client.post(url, json={'sessionId': 'learner_001', 'answers': {'reflection': 'a' * (512 * 1024)}})
    assert result.status_code == 413
    assert result.json['error'] == 'This learning response is too large to save.'


@pytest.mark.parametrize('path', ['', '/{eid}', '/{eid}/sharing', '/{eid}/assets/illustration'])
def test_course_metadata_reads_preserve_the_course_and_media(setup, monkeypatch, path):
    client, db = setup
    eid = _create_sample(client)['id']
    db.put('elearning_assets/illustration', {
        'id': 'illustration', 'expedition_id': eid, 'size': 3, 'content_type': 'image/png', 'ready': True,
    })
    saved = deepcopy(db.data)

    def unexpected_write(*args, **kwargs):
        pytest.fail('A metadata request must stay on the read path')

    for method in ('create_expedition', 'delete_expedition', 'delete_asset'):
        monkeypatch.setattr(service, method, unexpected_write)
    monkeypatch.setattr(service.elearning_storage, 'read_asset', unexpected_write)
    response = client.head('/api/elearning/expeditions' + path.format(eid=eid), headers=auth_headers())
    assert response.status_code == 200
    assert response.data == b''
    if '/assets/' in path:
        assert response.content_type == 'image/png'
        assert response.content_length == 3
    assert db.data == saved


def test_media_cleanup_checks_all_references_and_retries_storage(setup, monkeypatch):
    client, db = setup
    course = _create_sample(client)
    eid = course['id']
    url = '/api/elearning/expeditions/' + eid
    root = 'elearning_expeditions/' + eid
    exp = db.get(root)
    exp['startPage']['heroMediaOverrides'] = {'de': {'kind': 'asset', 'assetId': 'held_asset'}}
    exp['modules'][1]['steps'][0]['blocks'] = [{
        'id': 'draft_block', 'type': 'image', 'data': {'media': {'kind': 'asset', 'assetId': 'draft_asset'}}}]
    db.put(root, exp)
    for aid in ('held_asset', 'draft_asset', 'old_asset'):
        db.put('elearning_assets/' + aid, {'id': aid, 'expedition_id': eid, 'path': aid, 'ready': True,
                                          'size': 5, 'kind': 'image', 'reserved': True})
    db.put('book_usage/storage', {'bytes': 15})
    edit = client.post(url + '/lease', headers=auth_headers(), json={}).json
    args = {'lease_token': edit['lease_token'], 'base_revision': course['revision']}
    def erase(aid):
        return client.delete(url + '/assets/' + aid, headers=auth_headers(), json=args)

    inventory = client.get(url + '/assets', headers=auth_headers())
    assert inventory.status_code == 200
    assert [asset['id'] for asset in inventory.json['unused']] == ['old_asset']
    assert erase('held_asset').status_code == 409 and erase('draft_asset').status_code == 409
    assert client.delete(url + '/assets/old_asset', headers=auth_headers('owner', 'other-tab'), json=args).status_code == 409
    def unavailable(*_args, **_kwargs):
        raise service.BookError('Temporary failure', 503)
    monkeypatch.setattr(service.book_storage, 'request', unavailable)
    failed = erase('old_asset')
    assert failed.status_code == 503 and failed.json['removalPending']
    assert db.get('book_usage/storage')['bytes'] == 15
    # A concurrent structural edit or translation cannot reattach a file after cleanup claimed it.
    stale = deepcopy(exp)
    stale['startPage']['heroMedia'] = {'kind': 'asset', 'assetId': 'old_asset'}
    assert client.put(url, headers=auth_headers(), json={**stale, **args}).status_code == 409
    rejected = client.post(url + '/translations', headers=auth_headers(), json={
        'targetLanguage': 'de', 'mediaUpdates': {'startPage.heroMedia': {'kind': 'asset', 'assetId': 'old_asset'}}})
    assert rejected.status_code == 409
    assert db.get(root)['revision'] == 1
    monkeypatch.setattr(service.book_storage, 'request', lambda *_args, **_kwargs: b'')
    assert erase('old_asset').status_code == 200
    assert db.get('book_usage/storage')['bytes'] == 10 and db.get('elearning_assets/old_asset') is None
    assert erase('old_asset').status_code == 404


def test_pending_collaborator_upload_and_newly_attached_file_survive_cleanup(setup, monkeypatch):
    import io

    client, db = setup
    course = _create_sample(client)
    eid = course['id']
    url = '/api/elearning/expeditions/' + eid
    monkeypatch.setattr(service.book_storage, 'configured', lambda: True)
    monkeypatch.setattr(service.book_storage, 'request', lambda *args, **kwargs: b'')
    client.post(url + '/sharing', headers=auth_headers(), json={
        'action': 'add_member', 'role': 'edit', 'email': 'partner@example.com'})
    media = client.post(url + '/assets', headers=auth_headers('partner', 'partner-tab'),
                        data={'file': (io.BytesIO(b'OggScontent'), 'lesson.ogg', 'audio/ogg')}).json['asset']
    aid = media['id']
    lease = client.post(url + '/lease', headers=auth_headers(), json={}).json['lease_token']
    args = {'lease_token': lease, 'base_revision': 1}
    assert client.get(url + '/assets', headers=auth_headers()).json['unused'] == []
    assert client.delete(url + '/assets/' + aid, headers=auth_headers(), json=args).status_code == 409
    draft = deepcopy(course)
    draft['startPage']['heroMedia'] = {'kind': 'asset', 'assetId': aid}
    assert client.put(url, headers=auth_headers(), json={**draft, **args}).status_code == 200
    result = client.put(url, headers=auth_headers(), json={**course, **args, 'base_revision': 2})
    assert result.status_code == 200
    assert client.get(url + '/assets', headers=auth_headers()).json['unused'][0]['id'] == aid
    assert client.delete(url + '/assets/' + aid, headers=auth_headers(), json={**args, 'base_revision': 3}).status_code == 200
    assert db.get('book_usage/storage')['bytes'] == 0


def test_rejected_author_and_translation_sizes_leave_revision_and_draft_intact(setup):
    client, _ = setup
    headers = auth_headers()
    endpoint = '/api/elearning/expeditions'
    assert client.post(endpoint, headers=headers, json={'title': 'T' * 201}).status_code == 400
    exp = _create_sample(client)
    url = endpoint + '/' + exp['id']
    lease = client.post(url + '/lease', headers=headers, json={'action': 'acquire'}).json
    changed = deepcopy(exp)
    changed['startPage']['highlights'] = [{'text': {'en': 'Highlight'}}] * 9
    failed_save = client.put(url, headers=headers, json={
        **changed, 'lease_token': lease['lease_token'], 'base_revision': exp['revision'],
    })
    assert failed_save.status_code == 400 and '8' in failed_save.json['error']
    failed_translation = client.post(url + '/translations', headers=headers, json={
        'targetLanguage': 'de', 'textUpdates': {'startPage.eyebrow': 'W' * 121},
    })
    assert failed_translation.status_code == 400 and '120' in failed_translation.json['error']
    unchanged = client.get(url, headers=headers).json['expedition']
    assert unchanged['revision'] == exp['revision']
    assert unchanged['startPage'] == exp['startPage']


def test_translation_attachment_between_inventory_and_cleanup_keeps_its_file(setup, monkeypatch):
    client, db = setup
    course = _create_sample(client)
    eid = course['id']
    url = '/api/elearning/expeditions/' + eid
    key = 'elearning_assets/clip_asset'
    db.put(key, {'id': 'clip_asset', 'ready': True, 'kind': 'image', 'expedition_id': eid,
                 'size': 8, 'path': 'clip.webp'})
    client.post(url + '/sharing', headers=auth_headers(), json={
        'action': 'add_member', 'role': 'translate', 'email': 'partner@example.com'})
    lease = client.post(url + '/lease', headers=auth_headers(), json={}).json['lease_token']
    listed = client.get(url + '/assets', headers=auth_headers()).json
    assert listed['unused'][0]['id'] == 'clip_asset'
    assert client.get(url + '/assets', headers=auth_headers('partner')).status_code == 403
    edit = client.post(url + '/translations', headers=auth_headers('partner'), json={
        'targetLanguage': 'de', 'mediaUpdates': {'startPage.heroMedia': {'kind': 'asset', 'assetId': 'clip_asset'}}})
    assert edit.status_code == 200
    monkeypatch.setattr(service.book_storage, 'request', lambda *args, **kwargs: pytest.fail('File must remain'))
    for revision in (listed['revision'], edit.json['expedition']['revision']):
        assert client.delete(url + '/assets/clip_asset', headers=auth_headers(), json={
            'lease_token': lease, 'base_revision': revision}).status_code == 409
    assert db.get(key)['ready']


def test_ux_review_backend_contracts(setup):
    client, _ = setup
    exp = _create_sample(client, enable_public=False)
    eid = exp['id']
    # UX-080: New expeditions start private by default
    assert exp['share']['enabled'] is False
    assert client.get('/api/elearning/public/' + exp['share']['token']).status_code == 410

    # UX-002 / UX-010: Summary cards include coverMedia and languageCoverage
    listed = client.get('/api/elearning/expeditions', headers=auth_headers('owner')).json['expeditions']
    card = next(item for item in listed if item['id'] == eid)
    assert 'coverMedia' in card
    assert card['languageCoverage']['nl']['translated'] > 0
    assert card['languageCoverage']['de']['translated'] == 0

    # UX-089: Lease denial distinguishes same-account tab vs collaborator
    l1 = client.post(f'/api/elearning/expeditions/{eid}/lease', json={'action': 'acquire'}, headers=auth_headers('owner', 'tab-a'))
    assert l1.json['granted'] is True
    l_same = client.post(f'/api/elearning/expeditions/{eid}/lease', json={'action': 'acquire'}, headers=auth_headers('owner', 'tab-b'))
    assert l_same.json['granted'] is False and l_same.json['same_account'] is True

    # UX-115: Filtered CSV export respects cohort and language query params
    client.post(f'/api/elearning/expeditions/{eid}/sharing', json={'action': 'update_public', 'enabled': True, 'collectResponses': True}, headers=auth_headers('owner'))
    pub_url = '/api/elearning/public/' + exp['share']['token'] + '/responses'
    _post_pilot_response(client, pub_url, json={'sessionId': 'sess_nl_alpha', 'cohort': 'alpha', 'language': 'nl', 'answers': {'blk_mf': 'myth'}})
    _post_pilot_response(client, pub_url, json={'sessionId': 'sess_de_beta', 'cohort': 'beta', 'language': 'de', 'answers': {'blk_mf': 'fact'}})
    filtered = client.get(f'/api/elearning/expeditions/{eid}/responses/export.csv?cohort=alpha&language=nl', headers=auth_headers('owner'))
    assert filtered.status_code == 200
    assert 'alpha-nl.csv' in filtered.headers.get('Content-Disposition', '')
    body_text = filtered.data.decode('utf-8-sig')
    assert 'sess_nl_alpha' in body_text and 'sess_de_beta' not in body_text

    # UX-040: Bare DOI normalized to https://doi.org/...
    assert model.safe_external_url('10.3174/ajnr.A4173') == 'https://doi.org/10.3174/ajnr.A4173'
    assert model.safe_external_url('doi:10.3174/ajnr.A4173') == 'https://doi.org/10.3174/ajnr.A4173'


def test_import_preview_validates_the_real_model_without_creating_any_draft(setup):
    client, db = setup
    preview = '/api/elearning/import-preview'
    payload = model.build_default_expedition('Schmerzen verstehen', 'de')
    assert client.post(preview, json=payload).status_code == 401
    response = client.post(preview, json=payload, headers=auth_headers())
    assert response.status_code == 200
    assert response.json == {'title': 'Schmerzen verstehen', 'stationCount': 1, 'stepCount': 1,
                             'enabledLanguages': ['nl', 'en', 'de']}
    bad = deepcopy(payload)
    bad['modules'][0]['steps'][0]['blocks'] = [{'type': 'unknown'}]
    for malformed in (bad, {'modules': [{}]}, {'unrelated': True},
                      {**payload, 'modules': payload['modules'] * 2},
                      {**payload, 'startPage': {'heroMedia': {'kind': 'asset', 'assetId': 'ast_private'}}}):
        rejected = client.post(preview, json=malformed, headers=auth_headers())
        assert rejected.status_code == 400
        assert rejected.json['error']
    assert db.data == {}


def test_report_distinguishes_all_reflections_and_counts_people_who_made_a_choice(setup):
    client, db = setup
    exp = _create_sample(client)
    module = exp['modules'][0]
    module['steps'][0]['blocks'] = [
        {'id': 'poll', 'type': 'mcq', 'settings': {'allowMultiple': True}, 'data': {
            'options': [{'id': 'a', 'label': {'en': 'Walk'}}, {'id': 'b', 'label': {'en': 'Talk'}}],
        }},
        {'id': 'writing', 'type': 'reflection', 'settings': {}, 'data': {}},
    ]
    db.put('elearning_expeditions/' + exp['id'], exp)
    for i in range(57):
        answers = {'writing': f'Reflection {i}'}
        if i < 3:
            answers['poll'] = [['a', 'b'], ['b'], []][i]
        db.put(f'elearning_responses/{i}', {'expedition_id': exp['id'], 'answers': answers})
    result = client.get(f"/api/elearning/expeditions/{exp['id']}/responses", headers=auth_headers())
    stats = result.json['blockStats']
    assert stats['writing']['sampleTotal'] == 57
    assert len(stats['writing']['samples']) == 50
    assert stats['poll']['count'] == 2
    assert stats['poll']['counts'] == {'a': 1, 'b': 2}


def test_private_course_round_trip_retains_translated_figure_layout_and_station_domains(setup):
    client, _ = setup
    course = model.build_default_expedition('Neue Wege', 'de')
    step = course['modules'][0]['steps'][0]
    step['blocks'] = [{'id': 'blk_photo', 'type': 'image', 'data': {
        'sideTextBelow': True, 'crop': True, 'sideBody': {'de': 'Schau genauer hin.', 'nl': 'Kijk goed.'},
        'focalX': 72, 'focalY': 13,
    }}]
    for domain in (None, None, 'social'):
        mod = deepcopy(course['modules'][0])
        mod['id'] = model.new_id('mod')
        mod['steps'] = []
        mod['domain'] = domain
        course['modules'].append(mod)
    canonical = client.post('/api/elearning/expeditions', json=course, headers=auth_headers()).json['expedition']
    assert canonical['startPage']['title'] == {'nl': '', 'en': '', 'de': 'Neue Wege'}
    rows = model.extract_translation_rows(canonical, 'nl', 'en')
    assert next(row for row in rows if row['key'] == 'startPage.title')['status'] == 'untranslated'
    assert [m['domain'] for m in canonical['modules']] == ['general', 'general', 'general', 'social']
    assert not canonical['share']['enabled']
    public_url = '/api/elearning/public/' + canonical['share']['token']
    assert client.get(public_url).status_code == 410
    sharing = f"/api/elearning/expeditions/{canonical['id']}/sharing"
    assert client.post(sharing, json={'action': 'update_public', 'enabled': True}, headers=auth_headers()).status_code == 200
    public = client.get(public_url).json['expedition']
    figure = public['modules'][0]['steps'][0]['blocks'][0]['data']
    assert (figure['crop'], figure['sideTextBelow'], figure['focalX'], figure['focalY']) == (True, True, 72, 13)
    assert figure['sideBody']['de'] == 'Schau genauer hin.'


def test_report_and_download_apply_both_filters_and_agree_on_all_rows(setup):
    client, _ = setup
    exp = _create_sample(client)
    for language in ('nl', 'de'):
        for cohort in ('pilot-1', 'pilot-2'):
            session = f'pilot_{language}_{cohort}'
            saved = _post_pilot_response(client, f"/api/elearning/public/{exp['share']['token']}/responses",
                                json={'language': language, 'cohort': cohort, 'sessionId': session,
                                      'answers': {'blk_mf': 'myth'}})
            assert saved.status_code == 200
    report_url = f"/api/elearning/expeditions/{exp['id']}/responses"
    for filters, count in [('', 4), ('?language=de', 2), ('?cohort=pilot-2', 2), ('?cohort=pilot-2&language=de', 1)]:
        report = client.get(report_url + filters, headers=auth_headers())
        download = client.get(report_url + '/export.csv' + filters, headers=auth_headers())
        rows = list(csv.DictReader(io.StringIO(download.data.decode('utf-8-sig'))))
        assert report.json['summary']['totalSessions'] == len(rows) == count
        for row in rows:
            if 'language=de' in filters:
                assert row['language'] == 'de'
            if 'cohort=pilot-2' in filters:
                assert row['cohort'] == 'pilot-2'
    assert 'pilot-2-de.csv' in download.headers['Content-Disposition']


def test_publication_collection_and_current_consent_are_independent(setup):
    client, db = setup
    exp = _create_sample(client, enable_public=False)
    share_url = f"/api/elearning/expeditions/{exp['id']}/sharing"
    public_url = '/api/elearning/public/' + exp['share']['token']
    response_url = public_url + '/responses'
    body = {'sessionId': 'pilot_session', 'answers': {'blk_mf': 'myth'}, 'stepComments': [], 'completed': True}

    def settings(**changes):
        result = client.post(share_url, headers=auth_headers(), json={'action': 'update_public', **changes})
        assert result.status_code == 200
        return client.get(public_url).json['expedition']['shareOptions']

    private = settings(enabled=True)
    assert not private['collectResponses']
    assert client.post(response_url, json={**body, 'consent': True, 'collectionVersion': private['collectionVersion']}).status_code == 403
    first = settings(collectResponses=True, showPeerResults=True)
    for unchecked in ({}, {'consent': False}, {'consent': 'true'}):
        assert client.post(response_url, json={**body, **unchecked, 'collectionVersion': first['collectionVersion']}).status_code == 403
    assert not db.list('elearning_responses')
    accepted = {**body, 'consent': True, 'collectionVersion': first['collectionVersion']}
    assert client.post(response_url, json=accepted).status_code == 200
    off = settings(collectResponses=False)
    assert not off['showPeerResults']
    assert client.get(public_url + '/aggregates/blk_mf').status_code == 403
    assert client.post(response_url, json=accepted).status_code == 403
    again = settings(collectResponses=True)
    assert again['collectionVersion'] != first['collectionVersion']
    assert client.post(response_url, json=accepted).status_code == 409
    assert len(db.list('elearning_responses')) == 1


@pytest.mark.parametrize('pilot,peer,comments,active', [
    (False, False, False, False), (True, False, False, True),
    (False, True, False, True), (False, False, True, True),
])
def test_existing_learner_links_use_their_configured_pilot_features(setup, pilot, peer, comments, active):
    client, db = setup
    course = _create_sample(client)
    course['share'].pop('collectResponses')
    course['share'].update(collectPilotFeedback=pilot, showPeerResults=peer, allowStepComments=comments)
    db.put('elearning_expeditions/' + course['id'], course)
    public = '/api/elearning/public/' + course['share']['token']
    assert client.get(public).json['expedition']['shareOptions']['collectResponses'] is active
    result = client.post(public + '/responses', json={'sessionId': 'legacy_browser', 'answers': {'blk_mf': 'myth'}})
    assert result.status_code == 403
    assert not db.list('elearning_responses')


def test_a_response_session_cannot_be_moved_between_pilot_groups(setup):
    client, db = setup
    course = _create_sample(client)
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    first = {'sessionId': 'stable_session', 'cohort': 'group-a', 'answers': {'blk_mf': 'myth'}, 'visitedStepIds': ['stp_1']}
    assert _post_pilot_response(client, url, json=first).status_code == 200
    path = f"elearning_responses/{course['id']}__stable_session"
    saved = db.get(path)
    second = {**first, 'cohort': 'group-b', 'answers': {'blk_mf': 'fact'}, 'completed': True}
    assert _post_pilot_response(client, url, json=second).status_code == 409
    assert db.get(path) == saved
    assert _post_pilot_response(client, url, json={**second, 'sessionId': 'another_session'}).status_code == 200
    assert {record['cohort'] for record in db.list('elearning_responses')} == {'group-a', 'group-b'}


@pytest.mark.parametrize('legacy', [False, True])
def test_new_consent_records_start_separately_and_preserve_the_previous_record(setup, monkeypatch, legacy):
    client, db = setup
    course = _create_sample(client)
    share = f"/api/elearning/expeditions/{course['id']}/sharing"
    url = '/api/elearning/public/' + course['share']['token'] + '/responses'
    old = {'sessionId': 'original_session', 'answers': {'blk_mf': 'myth'},
           'visitedStepIds': ['stp_1'], 'pilotFeedback': {'comment': 'My original feedback'}}
    monkeypatch.setattr(service, 'now', lambda: 100)
    assert _post_pilot_response(client, url, json=old).status_code == 200
    path = f"elearning_responses/{course['id']}__original_session"
    saved = db.get(path)
    if legacy:
        saved.pop('consentVersion')
        db.put(path, saved)
    changed = client.post(share, headers=auth_headers(), json={'action': 'update_public', 'allowStepComments': True})
    assert changed.status_code == 200
    monkeypatch.setattr(service, 'now', lambda: 200)
    assert _post_pilot_response(client, url, json={'sessionId': 'original_session', 'completed': True}).status_code == 409
    assert db.get(path) == saved

    fresh = {'sessionId': 'new_participation', 'completed': True}
    assert _post_pilot_response(client, url, json=fresh).status_code == 200
    new_path = f"elearning_responses/{course['id']}__new_participation"
    record = db.get(new_path)
    assert record['consentVersion'] == changed.json['share']['collectionVersion']
    assert record['consented_at'] == 200
    assert (record['answers'], record['visitedStepIds'], record['pilotFeedback']) == ({}, [], None)
    monkeypatch.setattr(service, 'now', lambda: 300)
    assert _post_pilot_response(client, url, json=fresh).status_code == 200
    assert db.get(new_path)['consented_at'] == 200
