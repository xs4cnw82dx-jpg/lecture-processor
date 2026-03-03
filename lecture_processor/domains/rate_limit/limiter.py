from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def check_rate_limit(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).check_rate_limit(*args, **kwargs)


def build_rate_limited_response(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).build_rate_limited_response(*args, **kwargs)


def normalize_rate_limit_key_part(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).normalize_rate_limit_key_part(*args, **kwargs)
