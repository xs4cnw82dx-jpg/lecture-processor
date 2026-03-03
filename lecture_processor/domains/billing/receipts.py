from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def normalize_credit_ledger(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).normalize_credit_ledger(*args, **kwargs)


def initialize_billing_receipt(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).initialize_billing_receipt(*args, **kwargs)


def ensure_job_billing_receipt(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).ensure_job_billing_receipt(*args, **kwargs)


def add_job_credit_refund(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).add_job_credit_refund(*args, **kwargs)


def get_billing_receipt_snapshot(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_billing_receipt_snapshot(*args, **kwargs)
