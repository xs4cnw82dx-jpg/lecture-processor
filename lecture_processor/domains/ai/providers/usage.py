"""Validation shared by provider usage recording and cost reporting."""
import math


def finite_cost_usd(value):
    """Return a usable reported amount, preserving zero and rejecting bad data."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return None
    try:
        amount = float(value)
    except (OverflowError, ValueError):
        return None
    return amount if math.isfinite(amount) and amount >= 0 else None


def combine_cost_sources(sources):
    values = set(sources)
    return next(iter(values)) if len(values) == 1 else 'mixed'
