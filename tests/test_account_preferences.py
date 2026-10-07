from copy import deepcopy

import pytest


@pytest.fixture
def accounts(core, monkeypatch):
    users = {
        'a': {'uid': 'a', 'email': 'a@example.test', 'preferred_output_language': 'other',
              'preferred_output_language_custom': 'French', 'favorite_tools': ['image-reader']},
        'b': {'uid': 'b', 'email': 'b@example.test'},
    }

    def verify(request, **kwargs):
        uid = request.headers.get('Authorization', '').removeprefix('Bearer ')
        return {'uid': uid, 'email': users[uid]['email'], 'email_verified': True} if uid in users else None

    def save(_db, uid, updates, merge=True):
        assert merge
        users[uid].update(updates)

    monkeypatch.setattr(core, 'verify_firebase_token', verify)
    monkeypatch.setattr(core, 'is_email_allowed', lambda email: True)
    monkeypatch.setattr(core, 'get_or_create_user', lambda uid, email: deepcopy(users[uid]))
    monkeypatch.setattr(core.repositories.users, 'set_doc', save)
    return users


def test_preferences_require_authentication(client, accounts):
    assert client.get('/api/user-preferences').status_code == 401
    assert client.put('/api/user-preferences', json={'theme': 'dark'}).status_code == 401
    assert 'theme' not in accounts['a']


def test_preferences_persist_and_are_scoped_to_authenticated_account(client, accounts):
    headers = {'Authorization': 'Bearer a'}
    initial = client.get('/api/user-preferences', headers=headers).get_json()['preferences']
    assert initial['interface_language'] == 'en'
    assert initial['theme'] == 'light'
    response = client.put('/api/user-preferences', headers=headers, json={
        'interface_language': 'nl', 'theme': 'dark', 'uid': 'b', 'is_admin': True,
    })
    assert response.status_code == 200
    persisted = client.get('/api/user-preferences', headers=headers).get_json()['preferences']
    assert persisted['interface_language'] == 'nl'
    assert persisted['theme'] == 'dark'
    assert persisted['favorite_tools'] == ['image-reader']
    assert accounts['a']['preferred_output_language'] == 'other'
    assert accounts['a']['preferred_output_language_custom'] == 'French'
    assert 'is_admin' not in accounts['a']
    other = client.get('/api/user-preferences', headers={'Authorization': 'Bearer b'}).get_json()['preferences']
    assert other['interface_language'] == 'en'
    assert other['theme'] == 'light'
    response = client.put('/api/user-preferences', headers=headers, json={'theme': 'light'})
    assert response.get_json()['preferences']['interface_language'] == 'nl'


@pytest.mark.parametrize('payload', [[], False, 0, 'dark', {'theme': 'system'}, {'theme': []},
                                     {'interface_language': 'de'}, {'interface_language': None}])
def test_invalid_preferences_do_not_write_any_fields(client, accounts, payload):
    before = deepcopy(accounts)
    response = client.put('/api/user-preferences', headers={'Authorization': 'Bearer a'}, json=payload)
    assert response.status_code == 400
    assert accounts == before


def test_preferences_deleting_account_and_storage_failure(client, accounts, core, monkeypatch):
    headers = {'Authorization': 'Bearer a'}
    accounts['a']['account_status'] = 'deleting'
    assert client.put('/api/user-preferences', headers=headers, json={'theme': 'dark'}).status_code == 409
    accounts['a'].pop('account_status')
    before = deepcopy(accounts)

    def failure(*args, **kwargs):
        raise RuntimeError('synthetic storage failure')

    monkeypatch.setattr(core.repositories.users, 'set_doc', failure)
    assert client.put('/api/user-preferences', headers=headers, json={'theme': 'dark'}).status_code == 500
    assert accounts == before


def test_workout_remains_admin_protected_after_navigation_move(client, core, accounts, monkeypatch):
    monkeypatch.setattr(core, 'is_admin_user', lambda decoded: False)
    assert client.post('/api/session/login', headers={'Authorization': 'Bearer a'}).status_code == 403
    assert client.get('/api/admin/workout/bootstrap', headers={'Authorization': 'Bearer a'}).status_code == 403
    monkeypatch.setattr(core.auth, 'verify_session_cookie', lambda *args, **kwargs: {'uid': 'a', 'email': 'a@example.test'})
    client.set_cookie(core.ADMIN_SESSION_COOKIE_NAME, 'synthetic-non-admin-cookie')
    response = client.get('/admin/workout')
    assert response.status_code == 302
    assert response.headers['Location'].endswith('/lecture-notes?auth=signin&next=/admin/workout')
