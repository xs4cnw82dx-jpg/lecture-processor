"""Credit prices, historical conversion rates, and pure billing calculations."""

from collections.abc import Mapping
from copy import deepcopy


CREDIT_SCHEME_VERSION = 2
DEFAULT_UNIFIED_CREDITS_ENABLED = False
FREE_SIGNUP_CREDITS = 12


def is_unified_enabled(runtime=None):
    return getattr(runtime, 'UNIFIED_CREDITS_ENABLED', DEFAULT_UNIFIED_CREDITS_ENABLED) is True


def uses_unified_credits(user_data, runtime=None):
    return user_data.get('credits_version') == CREDIT_SCHEME_VERSION or is_unified_enabled(runtime)

# Historical conversion rates stay independent of future action prices.
LEGACY_FIELD_RATES = {
    'lecture_credits_standard': 8,
    'lecture_credits_extended': 8,
    'slides_credits': 2,
    'interview_credits_short': 10,
    'interview_credits_medium': 10,
    'interview_credits_long': 10,
}

ACTION_COSTS = {
    'lecture_notes': {'category': 'lecture', 'instant': 8, 'overnight': 4},
    'slides_extraction': {'category': 'slides', 'instant': 2, 'overnight': 1},
    'interview_transcription': {'category': 'interview', 'instant': 10, 'overnight': 5},
    'interview_extra': {'category': 'slides', 'instant': 2, 'overnight': 1},
    'text_combine': {'category': 'lecture', 'instant': 8, 'overnight': 4},
    'audio_transcription': {'category': 'interview', 'instant': 10, 'overnight': 5},
    'tools_extraction': {'category': 'slides', 'instant': 2, 'overnight': None},
    'tools_transcription': {'category': 'interview', 'instant': 10, 'overnight': None},
    'voice_note': {'category': 'interview', 'instant': 10, 'overnight': None},
    'regenerate_study_tools': {'category': 'slides', 'instant': 2, 'overnight': None},
    'interview_coding': {'category': 'slides', 'instant': 2, 'overnight': None},
}

CREDIT_BUNDLES = {
    'credits_40': {
        'name': '40 credits', 'description': '40 credits for your study tools',
        'credits': 40, 'price_cents': 999, 'currency': 'eur', 'badge': '',
    },
    'credits_80': {
        'name': '80 credits', 'description': '80 credits for your study tools',
        'credits': 80, 'price_cents': 1699, 'currency': 'eur', 'badge': 'best_value',
    },
    'credits_200': {
        'name': '200 credits', 'description': '200 credits for a semester of study',
        'credits': 200, 'price_cents': 3499, 'currency': 'eur', 'badge': 'semester',
    },
}

LEGACY_CHECKOUT_BUNDLES = {
    'lecture_5': {
        'name': 'Lecture Notes — 5 Pack',
        'description': '5 standard lecture credits',
        'credits': {'lecture_credits_standard': 5},
        'price_cents': 999, 'currency': 'eur',
    },
    'lecture_10': {
        'name': 'Lecture Notes — 10 Pack',
        'description': '10 standard lecture credits (best value)',
        'credits': {'lecture_credits_standard': 10},
        'price_cents': 1699, 'currency': 'eur',
    },
    'slides_10': {
        'name': 'Slides Extraction — 10 Pack',
        'description': '10 slides extraction credits',
        'credits': {'slides_credits': 10},
        'price_cents': 499, 'currency': 'eur',
    },
    'slides_25': {
        'name': 'Slides Extraction — 25 Pack',
        'description': '25 slides extraction credits (best value)',
        'credits': {'slides_credits': 25},
        'price_cents': 999, 'currency': 'eur',
    },
    'interview_3': {
        'name': 'Interview Transcription — 3 Pack',
        'description': '3 interview transcription credits',
        'credits': {'interview_credits_short': 3},
        'price_cents': 799, 'currency': 'eur',
    },
    'interview_8': {
        'name': 'Interview Transcription — 8 Pack',
        'description': '8 interview transcription credits (best value)',
        'credits': {'interview_credits_short': 8},
        'price_cents': 1799, 'currency': 'eur',
    },
}

# These converted descriptors validate old sessions after activation.
LEGACY_CREDIT_BUNDLES = {
    key: {
        **deepcopy(bundle),
        'legacy_credits': deepcopy(bundle['credits']),
        'credits': sum(LEGACY_FIELD_RATES[field] * amount for field, amount in bundle['credits'].items()),
    }
    for key, bundle in LEGACY_CHECKOUT_BUNDLES.items()
}


def _units(value):
    if type(value) is not int or value < 0:
        raise ValueError('Credit units must be a nonnegative integer.')
    return value


def _legacy_units(value):
    if value is None:
        return 0
    if isinstance(value, str) and value.strip().isascii() and value.strip().isdecimal():
        value = int(value.strip())
    return _units(value)


def action_cost(action, *, units=1, overnight=False):
    """Return an integer charge; actions without a batch variant stay instant."""
    cost = ACTION_COSTS.get(action)
    if cost is None:
        raise ValueError('Unknown credit action.')
    rate = cost['overnight'] if overnight and cost['overnight'] is not None else cost['instant']
    return _units(units) * rate


def quote_components(components, *, overnight=False, unlimited=None):
    """Snapshot component prices and category-specific exemptions for a charge."""
    if not isinstance(components, Mapping):
        raise ValueError('Charge components must be a mapping.')
    exemptions = unlimited if isinstance(unlimited, Mapping) else {}
    quoted = {}
    for key, component in components.items():
        if not isinstance(key, str) or not key or not isinstance(component, Mapping):
            raise ValueError('Invalid charge component.')
        action = component.get('action')
        units = _units(component.get('units', 1))
        unit_cost = action_cost(action, overnight=overnight)
        category = ACTION_COSTS[action]['category']
        exempt = exemptions.get(category) is True
        amount = units * unit_cost
        quoted[key] = {
            'action': action, 'category': category, 'units': units, 'unit_cost': unit_cost,
            'quoted_credits': amount, 'charged_credits': 0 if exempt else amount,
            'unlimited': exempt,
        }
    return {
        'credit_scheme': CREDIT_SCHEME_VERSION,
        'quoted_credits': sum(component['quoted_credits'] for component in quoted.values()),
        'charged_credits': sum(component['charged_credits'] for component in quoted.values()),
        'components': quoted,
    }


def legacy_amount_credits(credit_field, amount):
    """Convert old units without applying an overnight discount a second time."""
    rate = LEGACY_FIELD_RATES.get(credit_field)
    if rate is None:
        raise ValueError('Unknown historical credit type.')
    return _units(amount) * rate


def conversion_updates(user_data):
    """Prepare lazy conversion; callers commit these fields in their transaction."""
    if not isinstance(user_data, Mapping):
        raise ValueError('User credit data must be a mapping.')
    version = user_data.get('credits_version')
    if version is not None and (type(version) is not int or version not in {0, 1, CREDIT_SCHEME_VERSION}):
        raise ValueError('Unknown stored credit version.')
    if user_data.get('credits_version') == CREDIT_SCHEME_VERSION:
        return {}
    snapshot = {field: user_data.get(field, 0) for field in LEGACY_FIELD_RATES}
    total = sum(legacy_amount_credits(field, _legacy_units(value)) for field, value in snapshot.items())
    return {
        **dict.fromkeys(LEGACY_FIELD_RATES, 0),
        'credits': total,
        'credits_version': CREDIT_SCHEME_VERSION,
        'legacy_credits_snapshot': snapshot,
    }


def bundle_for_checkout(bundle_id):
    """Return only a currently purchasable unified-credit bundle."""
    return deepcopy(CREDIT_BUNDLES.get(bundle_id))


def bundle_for_fulfillment(bundle_id):
    """Return current or historical terms for an already-created checkout."""
    return deepcopy(CREDIT_BUNDLES.get(bundle_id) or LEGACY_CREDIT_BUNDLES.get(bundle_id))
