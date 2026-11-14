from types import SimpleNamespace

import pytest

from lecture_processor.domains.billing import policy
from lecture_processor.repositories import purchases_repo
from lecture_processor.services import payments_api_service


@pytest.mark.parametrize('enabled', [False, True])
def test_config_bundle_badges_come_from_the_active_catalog(client, core, monkeypatch, enabled):
    monkeypatch.setattr(core, 'UNIFIED_CREDITS_ENABLED', enabled)
    monkeypatch.setattr(core, 'STRIPE_PUBLISHABLE_KEY', 'synthetic-publishable-key')
    if enabled:
        monkeypatch.setitem(policy.CREDIT_BUNDLES['credits_40'], 'badge', 'semester')
    response = client.get('/api/config')
    assert response.status_code == 200
    bundles = response.get_json()['bundles']
    if enabled:
        assert bundles['credits_40']['badge'] == 'semester'
        assert bundles['credits_80']['badge'] == 'best_value'
        assert bundles['credits_200']['badge'] == 'semester'
        assert bundles['credits_80']['credits'] == 80
    else:
        assert set(bundles) == set(policy.LEGACY_CHECKOUT_BUNDLES)
        assert all('badge' not in bundle for bundle in bundles.values())


def test_history_keeps_recorded_unified_and_original_purchase_units(client, core, monkeypatch):
    monkeypatch.setattr(core, 'verify_firebase_token', lambda _request: {'uid': 'one', 'email': 'one@example.test'})
    monkeypatch.setattr(payments_api_service, '_require_allowed_email', lambda *_args: None)
    records = {
        'converted-old': {'credit_scheme': 2, 'credits': 40, 'legacy_credits': {'lecture_credits_standard': 5}, 'bundle_name': 'Original lecture bundle'},
        'new': {'credit_scheme': 2, 'credits': 80, 'bundle_name': '80 credits'},
        'legacy': {'credits': {'slides_credits': 10}, 'bundle_name': 'Original slides bundle'},
    }
    def history(_db, uid, limit, _firestore):
        assert uid == 'one'
        assert limit == 50
        return [SimpleNamespace(id=key, to_dict=lambda value=value: value) for key, value in records.items()]
    monkeypatch.setattr(purchases_repo, 'list_by_uid_recent', history)
    response = client.get('/api/purchase-history')
    assert response.status_code == 200
    items = {item['id']: item for item in response.get_json()['purchases']}
    assert items['converted-old']['credits'] == 40
    assert items['converted-old']['credit_scheme'] == 2
    assert items['converted-old']['legacy_credits'] == {'lecture_credits_standard': 5}
    assert items['new']['credit_scheme'] == 2
    assert items['new']['credits'] == 80
    assert 'legacy_credits' not in items['new']
    assert items['legacy']['credits'] == {'slides_credits': 10}
    assert 'credit_scheme' not in items['legacy']
    assert 'legacy_credits' not in items['legacy']


@pytest.mark.parametrize(('url', 'phrase'), [
    ('/helpcenter', 'One credit balance covers your processing tools.'),
    ('/faq', 'Each overnight batch action costs exactly half its instant price'),
    ('/features', 'Optional summaries and sectioned transcripts add to the displayed credit cost.'),
    ('/terms', 'Processing tools use one shared credit balance.'),
])
@pytest.mark.parametrize('enabled', [False, True])
def test_public_credit_copy_follows_server_activation(client, core, monkeypatch, url, phrase, enabled):
    monkeypatch.setattr(core, 'UNIFIED_CREDITS_ENABLED', enabled)
    response = client.get(url, follow_redirects=True)
    assert response.status_code == 200
    assert (phrase in response.get_data(as_text=True)) is enabled


@pytest.mark.parametrize('enabled', [False, True])
def test_initial_creation_quote_does_not_advertise_legacy_units_when_active(client, core, monkeypatch, enabled):
    monkeypatch.setattr(core, 'UNIFIED_CREDITS_ENABLED', enabled)
    html = client.get('/lecture-notes').get_data(as_text=True)
    expected = 'Checking credits…' if enabled else 'Uses <strong>1 lecture credit</strong>'
    assert f'<div class="mode-credit-cost" id="mode-credit-cost">{expected}</div>' in html
