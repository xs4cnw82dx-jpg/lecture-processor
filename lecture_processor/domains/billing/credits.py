from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def grant_credits_to_user(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).grant_credits_to_user(*args, **kwargs)


def deduct_credit(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).deduct_credit(*args, **kwargs)


def deduct_interview_credit(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).deduct_interview_credit(*args, **kwargs)


def refund_credit(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).refund_credit(*args, **kwargs)


def deduct_slides_credits(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).deduct_slides_credits(*args, **kwargs)


def refund_slides_credits(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).refund_slides_credits(*args, **kwargs)
