from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def save_purchase_record(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).save_purchase_record(*args, **kwargs)


def purchase_record_exists_for_session(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).purchase_record_exists_for_session(*args, **kwargs)


def process_checkout_session_credits(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).process_checkout_session_credits(*args, **kwargs)
