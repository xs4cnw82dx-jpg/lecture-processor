"""Rendered pricing follows the active billing catalog without redefining prices."""

from html.parser import HTMLParser

from lecture_processor.domains.billing import policy


class PricingPage(HTMLParser):
    def __init__(self, html):
        super().__init__()
        self.bundles = []
        self.actions = {}
        self.row = None
        self.feed(html)

    def handle_starttag(self, tag, attributes):
        attrs = dict(attributes)
        if tag == 'button' and attrs.get('data-bundle-id'):
            self.bundles.append(attrs)
        if tag == 'tr' and attrs.get('data-credit-action'):
            self.row = attrs['data-credit-action']
            self.actions[self.row] = []

    def handle_endtag(self, tag):
        if tag == 'tr':
            self.row = None

    def handle_data(self, data):
        if self.row and data.strip():
            self.actions[self.row].append(data.strip())


def test_active_pricing_renders_policy_bundles_and_every_action(client, runtime, monkeypatch):
    monkeypatch.setattr(runtime, 'UNIFIED_CREDITS_ENABLED', True, raising=False)
    response = client.get('/buy_credits')
    assert response.status_code == 200
    page = PricingPage(response.get_data(as_text=True))
    assert [bundle['data-bundle-id'] for bundle in page.bundles] == list(policy.CREDIT_BUNDLES)
    assert set(page.actions) == set(policy.ACTION_COSTS)
    for action, prices in policy.ACTION_COSTS.items():
        assert str(prices['instant']) in page.actions[action]
        assert str(prices['overnight']) in page.actions[action] if prices['overnight'] is not None else '—' in page.actions[action]


def test_pricing_uses_changed_catalog_amounts_without_copying_rates(client, runtime, monkeypatch):
    monkeypatch.setattr(runtime, 'UNIFIED_CREDITS_ENABLED', True, raising=False)
    monkeypatch.setattr(policy, 'CREDIT_BUNDLES', {
        'synthetic': {'name': 'Test credits', 'description': 'Synthetic bundle', 'credits': 53, 'price_cents': 1234, 'currency': 'usd', 'badge': ''},
    })
    monkeypatch.setitem(policy.ACTION_COSTS, 'lecture_notes', {'category': 'lecture', 'instant': 14, 'overnight': 7})
    page = PricingPage(client.get('/buy_credits').get_data(as_text=True))
    assert [bundle['data-bundle-id'] for bundle in page.bundles] == ['synthetic']
    assert page.bundles[0]['data-price-cents'] == '1234'
    assert page.bundles[0]['data-currency'] == 'USD'
    assert '14' in page.actions['lecture_notes']
    assert '7' in page.actions['lecture_notes']


def test_disabled_pricing_keeps_legacy_bundles(client, runtime, monkeypatch):
    monkeypatch.setattr(runtime, 'UNIFIED_CREDITS_ENABLED', False, raising=False)
    page = PricingPage(client.get('/buy_credits').get_data(as_text=True))
    assert [bundle['data-bundle-id'] for bundle in page.bundles] == list(policy.LEGACY_CHECKOUT_BUNDLES)
