import pytest


@pytest.mark.parametrize('path', ['/privacy', '/terms'])
@pytest.mark.parametrize('contact', ['policy-test@example.invalid', ''])
def test_policy_revision_and_optional_contact_render(client, runtime, monkeypatch, path, contact):
    monkeypatch.setitem(runtime.__dict__, 'LEGAL_CONTACT_EMAIL', contact)
    response = client.get(path)
    assert response.status_code == 200
    html = response.get_data(as_text=True)
    assert '<time datetime="2026-11-15">November 15, 2026</time>' in html
    assert 'AI-assisted study tools' in html
    if contact:
        assert 'mailto:policy-test@example.invalid' in html
    else:
        assert 'mailto:' not in html
        assert 'contact the project owner' in html
    assert 'href="/helpcenter"' in html
    assert 'href="/FAQ"' in html
