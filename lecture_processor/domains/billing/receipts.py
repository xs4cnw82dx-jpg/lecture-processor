from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def normalize_credit_ledger(credit_map, runtime=None):
    normalized = {}
    if not isinstance(credit_map, dict):
        return normalized
    for credit_type, raw_amount in credit_map.items():
        key = str(credit_type or '').strip()
        if not key:
            continue
        try:
            amount = int(raw_amount)
        except Exception:
            continue
        if amount > 0:
            normalized[key] = amount
    return normalized


def initialize_billing_receipt(charged_map=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    return {
        'charged': normalize_credit_ledger(charged_map or {}, runtime=resolved_runtime),
        'refunded': {},
        'updated_at': resolved_runtime.time.time(),
    }


def ensure_job_billing_receipt(job_data, charged_map=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    receipt = job_data.get('billing_receipt')
    if not isinstance(receipt, dict):
        receipt = initialize_billing_receipt(charged_map or {}, runtime=resolved_runtime)
        job_data['billing_receipt'] = receipt
        return receipt

    charged = receipt.get('charged', {})
    if not isinstance(charged, dict):
        charged = {}
    for credit_type, amount in normalize_credit_ledger(charged_map or {}, runtime=resolved_runtime).items():
        charged[credit_type] = max(int(charged.get(credit_type, 0) or 0), amount)
    receipt['charged'] = charged

    if not isinstance(receipt.get('refunded'), dict):
        receipt['refunded'] = {}
    receipt['updated_at'] = resolved_runtime.time.time()
    return receipt


def add_job_credit_refund(job_data, credit_type, amount=1, runtime=None):
    if not credit_type:
        return
    try:
        amount_int = int(amount)
    except Exception:
        return
    if amount_int <= 0:
        return
    resolved_runtime = _resolve_runtime(runtime)
    receipt = ensure_job_billing_receipt(job_data, runtime=resolved_runtime)
    refunded = receipt.setdefault('refunded', {})
    refunded[credit_type] = int(refunded.get(credit_type, 0) or 0) + amount_int
    receipt['updated_at'] = resolved_runtime.time.time()


def get_billing_receipt_snapshot(job_data, runtime=None):
    receipt = job_data.get('billing_receipt')
    if not isinstance(receipt, dict):
        return {'charged': {}, 'refunded': {}}
    snapshot = {
        'charged': normalize_credit_ledger(receipt.get('charged', {}), runtime=runtime),
        'refunded': normalize_credit_ledger(receipt.get('refunded', {}), runtime=runtime),
    }
    updated_at = receipt.get('updated_at')
    if updated_at:
        snapshot['updated_at'] = updated_at
    return snapshot
