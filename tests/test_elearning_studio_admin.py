from tests.test_elearning_api import _create_sample, auth_headers, setup as studio_fixture

# Reuse the same isolated store and verified Firebase fixture as the Studio API.
studio = studio_fixture


def test_admin_is_server_authorized_owner_only_and_counts_recorded_sessions(studio, monkeypatch, runtime):
    client, db = studio
    monkeypatch.setattr(runtime.core, 'XPED_STUDIO_ADMIN_UID', '')
    monkeypatch.setattr(runtime.core, 'ADMIN_UIDS', {'owner'})
    monkeypatch.setattr(runtime.core, 'ADMIN_EMAILS', set())
    course = _create_sample(client)
    eid = course['id']
    foreign = client.post('/api/elearning/expeditions', json={'title': 'Other course'}, headers=auth_headers('other')).json['expedition']['id']
    # An ordinary owner may still use their existing sharing controls.
    regular = '/api/elearning/expeditions/' + foreign + '/sharing'
    client.post(regular, headers=auth_headers('other'), json={'action': 'add_member', 'role': 'edit', 'email': 'owner@example.com'})
    prefix = '/api/elearning/admin/expeditions/'
    stats = '/api/elearning/admin/statistics'
    assert client.get(stats).status_code == 401
    assert client.get(stats, headers=auth_headers('other')).status_code == 403
    assert client.get(prefix + foreign + '/sharing', headers=auth_headers('other')).status_code == 403
    assert client.get(prefix + foreign + '/sharing', headers=auth_headers()).status_code == 403
    assert client.post(prefix + foreign + '/sharing', json={'enabled': True}, headers=auth_headers()).status_code == 403
    assert client.get(prefix + eid + '/sharing', headers=auth_headers()).status_code == 200
    assert client.get('/api/elearning/expeditions', headers=auth_headers()).json['studioAdmin'] is True
    assert client.get('/api/elearning/expeditions', headers=auth_headers('other')).json['studioAdmin'] is False
    for i, (exp_id, completed) in enumerate([(eid, False), (eid, True), (foreign, True)]):
        db.put('elearning_responses/session' + str(i), {'expedition_id': exp_id, 'completed': completed, 'answers': {'text': 'private'}})
    assert client.get(stats, headers=auth_headers()).json == {
        'courses': [{'id': eid, 'title': course['title'], 'sessions': 2, 'completed': 1}],
        'sessions': 2, 'completed': 1,
    }


def test_before_signup_email_role_requires_verified_identity_and_is_revocable(studio, monkeypatch, runtime):
    client, _ = studio
    monkeypatch.setattr(runtime.core, 'XPED_STUDIO_ADMIN_UID', '')
    monkeypatch.setattr(runtime.core, 'ADMIN_UIDS', {'owner'})
    exp = _create_sample(client)
    detail = '/api/elearning/expeditions/' + exp['id']
    admin = '/api/elearning/admin/expeditions/' + exp['id'] + '/sharing'
    verified = None

    def identity(req):
        uid = req.headers['Authorization'].removeprefix('Bearer ')
        if uid == 'owner':
            return {'uid': uid, 'email_verified': True, 'email': 'owner@example.com'}
        claims = {'uid': uid, 'email': 'Future@Example.com'}
        if verified is not None:
            claims['email_verified'] = verified
        return claims

    monkeypatch.setattr(runtime.core, 'verify_firebase_token', identity)
    invite = {'action': 'add_member', 'email': '  futUre@EXAMPLE.com ', 'role': 'translate'}
    assert client.post(admin, json=invite, headers=auth_headers()).json['members'] == [{'email': 'future@example.com', 'role': 'translate'}]
    assert client.get('/api/elearning/expeditions', headers=auth_headers('future')).json['expeditions'] == []
    assert client.get(detail, headers=auth_headers('future')).status_code == 403
    verified = False
    assert client.get(detail, headers=auth_headers('future')).status_code == 403
    verified = True
    assert client.get(detail, headers=auth_headers('future')).json['expedition']['role'] == 'translate'
    assert client.get(detail + '/content-export', headers=auth_headers('future')).status_code == 403
    client.post(admin, json={**invite, 'role': 'edit'}, headers=auth_headers())
    assert client.get(detail + '/content-export', headers=auth_headers('future')).status_code == 200
    client.post(admin, json={**invite, 'action': 'remove_member'}, headers=auth_headers())
    assert client.get(detail, headers=auth_headers('future')).status_code == 403


def test_content_export_import_round_trip_is_private_and_upload_free(studio):
    client, db = studio
    original = _create_sample(client)
    eid = original['id']
    course = db.get('elearning_expeditions/' + eid)
    course['localizedTitle']['de'] = 'Die Geschichte'
    course['startPage']['heroMediaOverrides'] = {'de': {'kind': 'asset', 'assetId': 'file_private'}}
    course['startPage']['heroMedia'] = {'kind': 'xped', 'staticPath': '/static/images/xped/xped-jan.png'}
    course['modules'][0]['steps'][0]['blocks'].append({
        'id': 'visual', 'type': 'custom_visual', 'data': {'preset': 'placeholder', 'agentBrief': 'private brief', 'slotId': 'private slot'},
    })
    db.put('elearning_expeditions/' + eid, course)
    response = client.get('/api/elearning/expeditions/' + eid + '/content-export', headers=auth_headers())
    assert response.status_code == 200 and response.json['excludedUploads'] == 1
    exported = response.json['course']
    for key in ('owner_uid', 'owner_email', 'share', 'members', 'editor', 'role', 'id', 'lease', 'member_emails'):
        assert key not in exported
    assert original['share']['token'] not in response.text
    for text in ('authorNotes', 'INTERNAL THESIS NOTE', 'agentBrief', 'private slot', 'file_private'):
        assert text not in response.text
    assert exported['startPage']['heroMedia'] == {'kind': 'xped', 'assetId': '', 'staticPath': '/static/images/xped/xped-jan.png'}
    assert client.post('/api/elearning/import-preview', json=exported, headers=auth_headers('receiver')).status_code == 200
    copy = client.post('/api/elearning/expeditions', json=exported, headers=auth_headers('receiver')).json['expedition']
    assert copy['localizedTitle']['de'] == 'Die Geschichte'
    assert copy['owner_uid'] == 'receiver' and not copy['share']['enabled']
    assert [module['id'] for module in copy['modules']] == [module['id'] for module in course['modules']]
    assert db.get('elearning_expeditions/' + eid) == course


def test_multiple_general_admins_do_not_gain_studio_admin_access(studio, monkeypatch, runtime):
    client, _ = studio
    monkeypatch.setattr(runtime.core, 'XPED_STUDIO_ADMIN_UID', '')
    monkeypatch.setattr(runtime.core, 'ADMIN_UIDS', {'owner', 'other'})
    monkeypatch.setattr(runtime.core, 'ADMIN_EMAILS', set())
    def eligible(user):
        return client.get('/api/elearning/expeditions', headers=auth_headers(user)).json['studioAdmin']

    assert not eligible('owner') and not eligible('other')
    monkeypatch.setattr(runtime.core, 'XPED_STUDIO_ADMIN_UID', 'owner')
    assert eligible('owner') and not eligible('other')
    monkeypatch.setattr(runtime.core, 'XPED_STUDIO_ADMIN_UID', 'stranger')
    assert not eligible('stranger')
    monkeypatch.setattr(runtime.core, 'XPED_STUDIO_ADMIN_UID', '')
    monkeypatch.setattr(runtime.core, 'ADMIN_UIDS', set())
    monkeypatch.setattr(runtime.core, 'ADMIN_EMAILS', {'owner@example.com'})
    assert eligible('owner') and not eligible('other')


def test_statistics_include_all_sessions_and_courses_without_a_title(studio, monkeypatch, runtime):
    client, db = studio
    monkeypatch.setattr(runtime.core, 'XPED_STUDIO_ADMIN_UID', 'owner')
    monkeypatch.setattr(runtime.core, 'ADMIN_UIDS', {'owner'})
    db.put('elearning_expeditions/older', {'owner_uid': 'owner'})
    for index in range(215):
        db.put(f'elearning_responses/r{index}', {'expedition_id': 'older', 'completed': index < 6})
    db.put('elearning_responses/unfinished', {'expedition_id': 'older'})
    stats = client.get('/api/elearning/admin/statistics', headers=auth_headers())
    assert stats.status_code == 200
    assert stats.json['courses'] == [{'id': 'older', 'title': 'Untitled Expedition', 'sessions': 216, 'completed': 6}]


def test_export_preserves_over_limit_legacy_content_and_import_stays_strict(studio):
    client, db = studio
    course = _create_sample(client)
    path = 'elearning_expeditions/' + course['id']
    stored = db.get(path)
    old_title = 'Oud hoofdstuk ' * 30
    stored['startPage']['title']['nl'] = old_title
    stored['startPage']['highlights'] = [{'id': f'hl_{n}', 'text': {'nl': str(n)}} for n in range(9)]
    stored['startPage']['privateMetadata'] = 'ignore this'
    db.put(path, stored)
    response = client.get('/api/elearning/expeditions/' + course['id'] + '/content-export', headers=auth_headers())
    assert response.status_code == 200
    exported = response.json['course']
    assert response.json['exceedsImportLimits']
    assert exported['startPage']['title']['nl'] == old_title
    assert len(exported['startPage']['highlights']) == 9
    assert 'privateMetadata' not in response.text
    assert 'authorNotes' not in response.text
    assert db.get(path) == stored
    assert client.post('/api/elearning/import-preview', json=exported, headers=auth_headers('receiver')).status_code == 400
    assert client.post('/api/elearning/expeditions', json=exported, headers=auth_headers('receiver')).status_code == 400
    exported['startPage']['title']['nl'] = 'Oud hoofdstuk'
    exported['startPage']['highlights'].pop()
    assert client.post('/api/elearning/import-preview', json=exported, headers=auth_headers('receiver')).status_code == 200
