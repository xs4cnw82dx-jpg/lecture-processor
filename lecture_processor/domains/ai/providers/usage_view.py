"""Keep owner-facing usage responses independent of internal cost metadata."""

_PUBLIC_FIELDS = (
    'input_tokens', 'output_tokens', 'total_tokens',
    'model', 'billing_mode', 'input_modality',
)


def public_stage_usage(usage):
    """Copy established fields without changing stored records or legacy values."""
    if not isinstance(usage, dict):
        return {}
    return {
        stage: {field: record[field] for field in _PUBLIC_FIELDS if field in record}
        for stage, record in usage.items() if isinstance(record, dict)
    }
