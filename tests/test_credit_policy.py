from types import SimpleNamespace

import pytest

from lecture_processor.domains.billing import policy


def test_unified_credit_runtime_defaults_on_but_unconfigured_callers_stay_conservative():
    assert policy.DEFAULT_UNIFIED_CREDITS_ENABLED is True
    assert policy.is_unified_enabled() is False
    assert policy.uses_unified_credits({}) is False
    assert policy.is_unified_enabled(SimpleNamespace(UNIFIED_CREDITS_ENABLED=True)) is True


def test_converted_accounts_stay_on_unified_credits_after_activation_is_disabled():
    runtime = SimpleNamespace(UNIFIED_CREDITS_ENABLED=False)
    assert policy.uses_unified_credits({'credits_version': 2, 'credits': 12}, runtime) is True
    assert policy.uses_unified_credits({'slides_credits': 5}, runtime) is False


@pytest.mark.parametrize(
    ('action', 'instant', 'overnight'),
    [
        ('lecture_notes', 8, 4),
        ('slides_extraction', 2, 1),
        ('interview_transcription', 10, 5),
        ('interview_extra', 2, 1),
        ('text_combine', 8, 4),
        ('audio_transcription', 10, 5),
    ],
)
def test_batch_costs_are_exact_for_single_and_odd_row_counts(action, instant, overnight):
    assert policy.action_cost(action) == instant
    assert policy.action_cost(action, overnight=True) == overnight
    assert policy.action_cost(action, units=3, overnight=True) == 3 * overnight
    assert 2 * policy.action_cost(action, units=3, overnight=True) == policy.action_cost(action, units=3)


@pytest.mark.parametrize(
    ('action', 'cost'),
    [
        ('tools_extraction', 2),
        ('tools_transcription', 10),
        ('voice_note', 10),
        ('regenerate_study_tools', 2),
        ('interview_coding', 2),
    ],
)
def test_actions_without_a_batch_variant_keep_the_instant_rate(action, cost):
    assert policy.action_cost(action) == cost
    assert policy.action_cost(action, overnight=True) == cost


def test_every_instant_rate_is_even_and_every_defined_batch_rate_is_half():
    for cost in policy.ACTION_COSTS.values():
        assert type(cost['instant']) is int
        assert cost['instant'] > 0
        assert cost['instant'] % 2 == 0
        if cost['overnight'] is not None:
            assert type(cost['overnight']) is int
            assert cost['overnight'] * 2 == cost['instant']


def test_zero_optional_features_cost_nothing_and_coding_units_scale():
    assert policy.action_cost('interview_extra', units=0) == 0
    assert policy.action_cost('interview_coding', units=3) == 6


@pytest.mark.parametrize('overnight', [False, True])
def test_category_exemption_does_not_make_other_interview_components_free(overnight):
    quote = policy.quote_components({
        'primary': {'action': 'interview_transcription'},
        'extras': {'action': 'interview_extra', 'units': 3},
    }, overnight=overnight, unlimited={'interview': True, 'slides': False})
    assert quote['credit_scheme'] == 2
    assert quote['components']['primary']['charged_credits'] == 0
    assert quote['components']['extras']['charged_credits'] == (3 if overnight else 6)
    assert quote['charged_credits'] == (3 if overnight else 6)
    assert quote['quoted_credits'] == (8 if overnight else 16)


def test_slides_exemption_preserves_the_interview_primary_charge():
    quote = policy.quote_components({
        'primary': {'action': 'interview_transcription'},
        'extras': {'action': 'interview_extra', 'units': 2},
    }, unlimited={'slides': True})
    assert quote['charged_credits'] == 10
    assert quote['components']['extras']['charged_credits'] == 0


def test_charge_quote_is_a_snapshot_of_the_prices_at_charge_time(monkeypatch):
    quote = policy.quote_components({'primary': {'action': 'lecture_notes'}})
    monkeypatch.setitem(policy.ACTION_COSTS, 'lecture_notes', {'category': 'lecture', 'instant': 12, 'overnight': 6})
    assert policy.action_cost('lecture_notes') == 12
    assert quote['components']['primary']['unit_cost'] == 8
    assert quote['charged_credits'] == 8


@pytest.mark.parametrize('units', [-1, 0.5, True, None, '2'])
def test_charges_require_a_nonnegative_integer_number_of_units(units):
    with pytest.raises(ValueError):
        policy.action_cost('lecture_notes', units=units)


def test_unknown_actions_are_not_charged_at_a_default_rate():
    with pytest.raises(ValueError):
        policy.action_cost('unknown_action')


def test_conversion_preserves_all_legacy_units_and_other_account_fields():
    user = {
        'uid': 'synthetic-user', 'email': 'synthetic@example.test',
        'lecture_credits_standard': 2, 'lecture_credits_extended': 3,
        'slides_credits': 4, 'interview_credits_short': 1,
        'interview_credits_medium': 2, 'interview_credits_long': 3,
    }
    original = dict(user)
    updates = policy.conversion_updates(user)
    assert updates['credits'] == 108
    assert updates['credits_version'] == 2
    assert updates['legacy_credits_snapshot'] == {
        field: original[field] for field in policy.LEGACY_FIELD_RATES
    }
    assert all(updates[field] == 0 for field in policy.LEGACY_FIELD_RATES)
    assert user == original
    converted = {**user, **updates}
    assert converted['email'] == original['email']
    assert policy.conversion_updates(converted) == {}


def test_already_converted_balance_is_not_recomputed_from_cleared_fields():
    user = {'credits_version': 2, 'credits': 37, 'slides_credits': 0}
    assert policy.conversion_updates(user) == {}
    assert user['credits'] == 37


def test_unknown_stored_credit_version_is_not_reconverted_from_empty_legacy_fields():
    with pytest.raises(ValueError):
        policy.conversion_updates({'credits_version': 3, 'credits': 37})


def test_missing_old_balances_convert_to_zero_without_a_second_signup_grant():
    updates = policy.conversion_updates({'uid': 'existing-user'})
    assert updates['credits'] == 0
    assert policy.FREE_SIGNUP_CREDITS == 12


def test_integer_strings_in_historical_fields_convert_without_losing_snapshot():
    updates = policy.conversion_updates({'lecture_credits_extended': '2', 'slides_credits': None})
    assert updates['credits'] == 16
    assert updates['legacy_credits_snapshot']['lecture_credits_extended'] == '2'
    assert updates['legacy_credits_snapshot']['slides_credits'] is None


@pytest.mark.parametrize('invalid', [-1, 1.5, True, '1.5', 'unknown'])
def test_unrecognized_legacy_values_do_not_silently_reduce_the_balance(invalid):
    user = {'slides_credits': invalid, 'lecture_credits_standard': 5}
    with pytest.raises(ValueError):
        policy.conversion_updates(user)
    assert user == {'slides_credits': invalid, 'lecture_credits_standard': 5}


@pytest.mark.parametrize(
    ('field', 'rate'),
    [
        ('lecture_credits_standard', 8), ('lecture_credits_extended', 8),
        ('slides_credits', 2), ('interview_credits_short', 10),
        ('interview_credits_medium', 10), ('interview_credits_long', 10),
    ],
)
def test_historical_refund_units_convert_at_the_original_full_rate(field, rate):
    assert policy.legacy_amount_credits(field, 1) == rate
    assert policy.legacy_amount_credits(field, 3) == 3 * rate


def test_unknown_historical_credit_type_is_rejected():
    with pytest.raises(ValueError):
        policy.legacy_amount_credits('unrecognized_field', 1)


def test_current_bundles_use_the_unified_balance_and_integer_prices():
    assert {
        key: (bundle['credits'], bundle['price_cents'], bundle['currency'])
        for key, bundle in policy.CREDIT_BUNDLES.items()
    } == {
        'credits_40': (40, 999, 'eur'),
        'credits_80': (80, 1699, 'eur'),
        'credits_200': (200, 3499, 'eur'),
    }
    assert policy.CREDIT_BUNDLES['credits_80']['badge'] == 'best_value'
    assert policy.CREDIT_BUNDLES['credits_200']['badge'] == 'semester'


@pytest.mark.parametrize(
    ('bundle_id', 'credits', 'price_cents'),
    [
        ('lecture_5', 40, 999), ('lecture_10', 80, 1699),
        ('slides_10', 20, 499), ('slides_25', 50, 999),
        ('interview_3', 30, 799), ('interview_8', 80, 1799),
    ],
)
def test_legacy_bundles_can_be_fulfilled_at_original_price_but_not_purchased(bundle_id, credits, price_cents):
    assert bundle_id not in policy.CREDIT_BUNDLES
    assert policy.bundle_for_checkout(bundle_id) is None
    bundle = policy.bundle_for_fulfillment(bundle_id)
    assert bundle['credits'] == credits
    assert bundle['price_cents'] == price_cents
    assert bundle['currency'] == 'eur'
    assert sum(policy.legacy_amount_credits(field, amount) for field, amount in bundle['legacy_credits'].items()) == credits


def test_unknown_bundle_is_not_purchasable_or_fulfillable():
    assert policy.bundle_for_checkout('unknown_bundle') is None
    assert policy.bundle_for_fulfillment('unknown_bundle') is None


def test_bundle_callers_cannot_mutate_shared_policy():
    bundle = policy.bundle_for_fulfillment('lecture_5')
    bundle['credits'] = 999
    bundle['legacy_credits']['lecture_credits_standard'] = 999
    assert policy.bundle_for_fulfillment('lecture_5')['credits'] == 40
    assert policy.bundle_for_fulfillment('lecture_5')['legacy_credits']['lecture_credits_standard'] == 5
