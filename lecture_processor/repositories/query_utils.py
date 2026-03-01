"""Shared Firestore query helpers.

Uses keyword-based filters to avoid positional-argument warnings in newer
Firestore SDK versions. Falls back to positional style for simple test doubles
that do not support keyword filters.
"""

from google.cloud.firestore_v1.base_query import FieldFilter


def apply_where(query, field_path, op_string, value):
    try:
        return query.where(filter=FieldFilter(field_path, op_string, value))
    except TypeError:
        return query.where(field_path, op_string, value)

