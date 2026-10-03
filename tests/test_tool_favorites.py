import pytest

from lecture_processor.domains.shared.tool_catalog import TOOL_CATALOG, sanitize_favorite_tools
from lecture_processor.services import access_service


@pytest.fixture
def favorite_account(monkeypatch, core):
    user = {'uid': 'tools-user', 'email': 'tools@example.test'}
    monkeypatch.setattr(access_service, 'require_allowed_user', lambda *_: ({'uid': user['uid'], 'email': user['email']}, None, 200))
    monkeypatch.setattr(core, 'get_or_create_user', lambda *_: user.copy())
    monkeypatch.setattr(core.repositories.users, 'set_doc', lambda _db, uid, updates, merge=True: user.update(updates))
    return user


def test_favorites_start_empty_then_preserve_order_and_other_preferences(client, favorite_account):
    assert client.get('/api/user-preferences').get_json()['preferences']['favorite_tools'] == []
    favorite_account['preferred_output_language'] = 'en'
    response = client.put('/api/user-preferences', json={'favorite_tools': ['image-reader', 'lecture-notes', 'image-reader']})
    assert response.status_code == 200
    assert response.get_json()['preferences']['favorite_tools'] == ['image-reader', 'lecture-notes']
    response = client.put('/api/user-preferences', json={'onboarding_completed': True})
    assert response.get_json()['preferences']['favorite_tools'] == ['image-reader', 'lecture-notes']
    response = client.put('/api/user-preferences', json={'favorite_tools': ['lecture-notes', 'image-reader']})
    assert response.get_json()['preferences']['favorite_tools'] == ['lecture-notes', 'image-reader']
    assert client.put('/api/user-preferences', json={'favorite_tools': []}).status_code == 200
    assert client.get('/api/user-preferences').get_json()['preferences']['favorite_tools'] == []


@pytest.mark.parametrize('favorites', ['image-reader', ['https://evil.test'], [{}], ['image-reader'] * 15])
def test_invalid_favorites_cannot_be_saved(client, favorite_account, favorites):
    assert client.put('/api/user-preferences', json={'favorite_tools': favorites}).status_code == 400
    assert 'favorite_tools' not in favorite_account


def test_deleting_account_cannot_modify_favorites(client, favorite_account):
    favorite_account['account_status'] = 'deleting'
    assert client.put('/api/user-preferences', json={'favorite_tools': ['image-reader']}).status_code == 409


def test_removed_tools_are_ignored_in_saved_preferences():
    assert sanitize_favorite_tools(['removed-tool', 'url-reader', None, 'url-reader']) == ['url-reader']


def test_tools_catalog_renders_all_destinations_and_no_default_sidebar_favorites(client):
    html = client.get('/tools').get_data(as_text=True)
    for tool in TOOL_CATALOG:
        assert f'data-tool-id="{tool["id"]}"' in html
        assert f'href="{tool["url"]}"' in html
    assert 'id="shell-tool-favorites" hidden' in html
    assert 'id="shell-more-tools-link"' in html
    assert 'id="shell-more-tools-panel"' not in html
