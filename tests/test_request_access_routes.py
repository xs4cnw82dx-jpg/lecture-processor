"""Public HTTP contracts for authenticated service admission."""
import pytest


@pytest.mark.parametrize(('method', 'path'), [
    ('get', '/api/purchase-history'),
    ('post', '/api/create-checkout-session'),
    ('get', '/api/confirm-checkout-session'),
    ('get', '/api/study-packs'),
])
def test_unverified_identity_receives_verification_guidance(client, core, monkeypatch, method, path):
    def unverified(req):
        req.environ['lecture_processor.auth_error'] = 'email_not_verified'
        return None

    monkeypatch.setattr(core, 'verify_firebase_token', unverified)
    response = getattr(client, method)(path)
    assert response.status_code == 403
    assert response.json['error_code'] == 'email_not_verified'


def test_write_checks_membership_before_account_state(client, core, monkeypatch):
    from lecture_processor.domains.account import lifecycle

    user = {'uid': 'study-owner', 'email': 'learner@example.test', 'email_verified': True}
    monkeypatch.setattr(core, 'verify_firebase_token', lambda req: user)
    monkeypatch.setattr(core, 'is_email_allowed', lambda email: False)
    checks = []
    def deletion_status(uid, *, runtime):
        checks.append(uid)
        return False, 'Account deletion in progress.'

    monkeypatch.setattr(lifecycle, 'ensure_account_allows_writes', deletion_status)
    assert client.post('/api/study-packs', json={}).status_code == 403
    assert checks == []
    monkeypatch.setattr(core, 'is_email_allowed', lambda email: True)
    blocked = client.post('/api/study-packs', json={})
    assert blocked.status_code == 409
    assert blocked.json['status'] == 'account_deletion_in_progress'
    assert checks == ['study-owner']
