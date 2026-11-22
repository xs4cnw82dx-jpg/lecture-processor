"""Behavioral & security tests for xPEDitie Pijn E-Learning Studio, Translation Workflow, and Public Player."""
from __future__ import annotations

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

    def list(self, collection, field=None, value=None, operator='==', limit=200):
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


def _create_sample(client):
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
    return resp.json['expedition']


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
    sub = client.post(
        f'/api/elearning/public/{share_token}/responses',
        json={
            'sessionId': 'learner_session_001',
            'cohort': 'patients-pilot',
            'language': 'nl',
            'answers': {'blk_mf': 'myth'},
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
    sub = client.post(
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
