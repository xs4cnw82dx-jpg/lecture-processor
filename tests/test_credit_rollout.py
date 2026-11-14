from concurrent.futures import ThreadPoolExecutor
from copy import deepcopy
from types import SimpleNamespace

import pytest

from lecture_processor.domains.account import users
from lecture_processor.domains.analytics import events
from lecture_processor.domains.admin import rollups
from lecture_processor.domains.billing import policy, purchases
from lecture_processor.repositories import purchases_repo
from lecture_processor.services import access_service, auth_api_service, payments_api_service
from tests.credit_test_support import make_credit_runtime


def legacy_user():
    return {
        'uid': 'u1', 'email': 'u1@example.com', 'account_status': 'active',
        'lecture_credits_standard': 1, 'lecture_credits_extended': 2,
        'slides_credits': 3, 'interview_credits_short': 1,
        'interview_credits_medium': 2, 'interview_credits_long': 3,
        'unlimited_credits': {'lecture': False, 'slides': False, 'interview': False},
    }


@pytest.fixture
def credit_runtime(monkeypatch):
    runtime, store = make_credit_runtime(users={'u1': legacy_user()})
    runtime.CREDIT_BUNDLES = deepcopy(policy.LEGACY_CHECKOUT_BUNDLES)
    runtime.purchases_repo = purchases_repo
    runtime.stripe = SimpleNamespace(api_key='synthetic-test-key')
    runtime.jsonify = lambda payload: payload
    runtime.STRIPE_PUBLISHABLE_KEY = 'synthetic-publishable-key'
    runtime.sanitize_output_language_pref_key = lambda value: str(value or 'en')
    runtime.sanitize_output_language_pref_custom = lambda value: str(value or '')
    runtime.get_or_create_user = lambda uid, email: users.get_or_create_user(uid, email, runtime=runtime)
    monkeypatch.setattr(rollups, 'increment_purchase_rollups', lambda *_args, **_kwargs: True)
    monkeypatch.setattr(events, 'log_analytics_event', lambda *_args, **_kwargs: None)
    return runtime, store


def checkout(bundle_id, *, session_id='checkout1'):
    bundle = policy.bundle_for_fulfillment(bundle_id)
    amount, currency = bundle['price_cents'], bundle['currency']
    return {
        'id': session_id, 'mode': 'payment', 'status': 'complete', 'payment_status': 'paid',
        'amount_total': amount, 'currency': currency, 'livemode': False,
        'metadata': {'uid': 'u1', 'bundle_id': bundle_id, 'firebase_email': 'u1@example.com'},
        'line_items': {'data': [{'quantity': 1, 'amount_total': amount, 'currency': currency}]},
    }


@pytest.mark.parametrize('bundle_id', list(policy.LEGACY_CHECKOUT_BUNDLES))
@pytest.mark.parametrize('converted_before_fulfillment', [False, True])
def test_historical_session_grants_converted_amount_once(credit_runtime, bundle_id, converted_before_fulfillment):
    runtime, store = credit_runtime
    if converted_before_fulfillment:
        users.get_or_create_user('u1', 'u1@example.com', runtime=runtime)
        runtime.UNIFIED_CREDITS_ENABLED = False
    session = checkout(bundle_id)
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, 'granted')
    user = store.documents[('users', 'u1')]
    expected = policy.bundle_for_fulfillment(bundle_id)['credits']
    assert user['credits'] == 90 + expected
    assert user['credits_version'] == 2
    assert all(user[field] == 0 for field in policy.LEGACY_FIELD_RATES)
    assert store.documents[('purchases', 'checkout1')]['credits'] == expected
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, 'already_processed')
    assert store.documents[('users', 'u1')]['credits'] == 90 + expected


@pytest.mark.parametrize('bundle_id', list(policy.CREDIT_BUNDLES))
def test_new_session_is_held_while_disabled_then_fulfilled_once(credit_runtime, bundle_id):
    runtime, store = credit_runtime
    runtime.UNIFIED_CREDITS_ENABLED = False
    before = deepcopy(store.documents)
    session = checkout(bundle_id)
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (False, 'credits_activation_pending')
    assert store.documents == before
    runtime.UNIFIED_CREDITS_ENABLED = True
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, 'granted')
    assert store.documents[('users', 'u1')]['credits'] == 90 + policy.CREDIT_BUNDLES[bundle_id]['credits']
    runtime.UNIFIED_CREDITS_ENABLED = False
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (True, 'already_processed')


def test_conversion_and_purchase_are_atomic_when_purchase_write_fails(credit_runtime):
    runtime, store = credit_runtime
    before = deepcopy(store.documents)
    store.fail_writes.add(('purchases', 'checkout1'))
    assert purchases.process_checkout_session_credits(checkout('credits_40'), runtime=runtime) == (False, 'could_not_grant_credits')
    assert store.documents == before


def test_concurrent_conversion_and_fulfillment_do_not_duplicate_balance(credit_runtime):
    runtime, store = credit_runtime
    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(lambda index: (
            users.get_or_create_user('u1', 'u1@example.com', runtime=runtime)
            if index % 2 else purchases.process_checkout_session_credits(checkout('credits_40'), runtime=runtime)
        ), range(16)))
    assert results
    assert store.documents[('users', 'u1')]['credits'] == 130
    assert len(store.docs('purchases')) == 1
    assert store.documents[('users', 'u1')]['legacy_credits_snapshot']['slides_credits'] == 3


def test_purchase_commit_acknowledgement_loss_can_be_retried(credit_runtime):
    runtime, store = credit_runtime
    def lost_acknowledgement(_operations):
        store.after_commit = None
        raise RuntimeError('Synthetic acknowledgement loss')
    store.after_commit = lost_acknowledgement
    assert purchases.process_checkout_session_credits(checkout('credits_40'), runtime=runtime) == (False, 'could_not_grant_credits')
    assert purchases.process_checkout_session_credits(checkout('credits_40'), runtime=runtime) == (True, 'already_processed')
    assert store.documents[('users', 'u1')]['credits'] == 130


@pytest.mark.parametrize('bundle_id', ['lecture_5', 'credits_40'])
def test_amount_mismatch_never_converts_or_grants(credit_runtime, bundle_id):
    runtime, store = credit_runtime
    before = deepcopy(store.documents)
    session = checkout(bundle_id)
    session['amount_total'] += 1
    assert purchases.process_checkout_session_credits(session, runtime=runtime) == (False, 'checkout_amount_mismatch')
    assert store.documents == before


def test_disabled_legacy_fulfillment_keeps_existing_units_and_record_shape(credit_runtime):
    runtime, store = credit_runtime
    runtime.UNIFIED_CREDITS_ENABLED = False
    assert purchases.process_checkout_session_credits(checkout('slides_10'), runtime=runtime) == (True, 'granted')
    user = store.documents[('users', 'u1')]
    assert user['slides_credits'] == 13
    assert user['lecture_credits_standard'] == 1
    assert 'credits_version' not in user
    record = store.documents[('purchases', 'checkout1')]
    assert record['credits'] == {'slides_credits': 10}
    assert 'credit_scheme' not in record


def test_new_account_receives_signup_grant_once(credit_runtime):
    runtime, store = credit_runtime
    with ThreadPoolExecutor(max_workers=4) as pool:
        list(pool.map(lambda _: users.get_or_create_user('new', 'new@example.com', runtime=runtime), range(8)))
    user = store.documents[('users', 'new')]
    assert user['credits'] == 12
    assert user['credits_version'] == 2
    assert all(user[field] == 0 for field in policy.LEGACY_FIELD_RATES)


def test_profile_keeps_converted_balance_after_activation_is_disabled(credit_runtime, monkeypatch):
    runtime, store = credit_runtime
    users.get_or_create_user('u1', 'u1@example.com', runtime=runtime)
    runtime.UNIFIED_CREDITS_ENABLED = False
    monkeypatch.setattr(access_service, 'require_allowed_user', lambda *_args: ({'uid': 'u1', 'email': 'u1@example.com'}, None, None))
    monkeypatch.setattr(auth_api_service.shared_parsing, 'build_user_preferences_payload', lambda *_args, **_kwargs: {})
    payload = auth_api_service.get_user(runtime, SimpleNamespace())
    assert payload['credits'] == 90
    assert payload['credits_version'] == 2
    assert payload['credit_costs'] == policy.ACTION_COSTS
    assert store.documents[('users', 'u1')]['credits'] == 90


def test_disabled_unconverted_profile_retains_existing_credit_object(credit_runtime, monkeypatch):
    runtime, _store = credit_runtime
    runtime.UNIFIED_CREDITS_ENABLED = False
    monkeypatch.setattr(access_service, 'require_allowed_user', lambda *_args: ({'uid': 'u1', 'email': 'u1@example.com'}, None, None))
    monkeypatch.setattr(auth_api_service.shared_parsing, 'build_user_preferences_payload', lambda *_args, **_kwargs: {})
    payload = auth_api_service.get_user(runtime, SimpleNamespace())
    assert payload['credits'] == {
        'lecture_standard': 1, 'lecture_extended': 2, 'slides': 3,
        'interview_short': 1, 'interview_medium': 2, 'interview_long': 3,
        'unlimited': {'lecture': False, 'slides': False, 'interview': False},
    }
    assert 'credits_version' not in payload
    assert 'credit_costs' not in payload


def test_catalog_switches_only_from_server_configuration(credit_runtime):
    runtime, _store = credit_runtime
    runtime.UNIFIED_CREDITS_ENABLED = False
    old = payments_api_service.get_config(runtime)
    assert set(old) == {'stripe_publishable_key', 'bundles'}
    assert set(old['bundles']) == set(policy.LEGACY_CHECKOUT_BUNDLES)
    runtime.UNIFIED_CREDITS_ENABLED = True
    current = payments_api_service.get_config(runtime)
    assert set(current['bundles']) == {'credits_40', 'credits_80', 'credits_200'}
    assert current['action_costs'] == policy.ACTION_COSTS
    assert current['free_signup_credits'] == 12


@pytest.mark.parametrize('enabled,bundle_id', [(False, 'credits_40'), (True, 'lecture_5')])
def test_request_cannot_choose_an_inactive_checkout_catalog(credit_runtime, monkeypatch, enabled, bundle_id):
    runtime, _store = credit_runtime
    runtime.UNIFIED_CREDITS_ENABLED = enabled
    runtime.verify_firebase_token = lambda _request: {'uid': 'u1', 'email': 'u1@example.com'}
    runtime.CHECKOUT_RATE_LIMIT_MAX_REQUESTS = 10
    runtime.CHECKOUT_RATE_LIMIT_WINDOW_SECONDS = 60
    monkeypatch.setattr(payments_api_service, '_require_allowed_email', lambda *_args: None)
    monkeypatch.setattr(payments_api_service, '_require_account_write_access', lambda *_args: None)
    monkeypatch.setattr(payments_api_service.rate_limiter, 'check_rate_limit', lambda **_kwargs: (True, 0))
    request = SimpleNamespace(get_json=lambda **_kwargs: {'bundle_id': bundle_id, 'unified_credits_enabled': not enabled})
    payload, status = payments_api_service.create_checkout_session(runtime, request)
    assert status == 400
    assert payload == {'error': 'Invalid bundle selected'}


@pytest.mark.parametrize('target', ['profile', 'tombstone'])
def test_purchase_never_converts_a_deleting_account(credit_runtime, target):
    runtime, store = credit_runtime
    if target == 'profile':
        store.documents[('users', 'u1')]['account_status'] = 'deleting'
    else:
        store.documents[('account_deletions', 'u1')] = {'status': 'deleted', 'phase': 'deleted'}
    before = deepcopy(store.documents)
    result = purchases.process_checkout_session_credits(checkout('credits_40'), runtime=runtime)
    assert result == (False, 'account_deletion_in_progress' if target == 'profile' else 'account_deleted')
    assert store.documents == before


@pytest.mark.parametrize('tombstone', [{}, {'status': 'unknown'}])
@pytest.mark.parametrize('enabled', [False, True])
def test_unreadable_deletion_state_holds_purchase_without_granting(credit_runtime, tombstone, enabled):
    runtime, store = credit_runtime
    runtime.UNIFIED_CREDITS_ENABLED = enabled
    store.documents[('account_deletions', 'u1')] = tombstone
    before = deepcopy(store.documents)
    assert purchases.process_checkout_session_credits(checkout('lecture_5'), runtime=runtime) == (False, 'account_state_unavailable')
    assert store.documents == before


def test_cancelled_account_deletion_allows_purchase(credit_runtime):
    runtime, store = credit_runtime
    store.documents[('account_deletions', 'u1')] = {'status': 'cancelled'}
    assert purchases.process_checkout_session_credits(checkout('credits_40'), runtime=runtime) == (True, 'granted')
    assert store.documents[('users', 'u1')]['credits'] == 130
