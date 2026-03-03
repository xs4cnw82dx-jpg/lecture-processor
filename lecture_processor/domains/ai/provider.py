from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _build_thinking_config(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime)._build_thinking_config(*args, **kwargs)


def get_provider_status_code(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_provider_status_code(*args, **kwargs)


def classify_provider_error_code(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).classify_provider_error_code(*args, **kwargs)


def is_transient_provider_error(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).is_transient_provider_error(*args, **kwargs)


def run_with_provider_retry(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).run_with_provider_retry(*args, **kwargs)


def extract_token_usage(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).extract_token_usage(*args, **kwargs)


class TokenAccumulator:
    def __new__(cls, *args, runtime=None, **kwargs):
        runtime_obj = _resolve_runtime(runtime)
        target_cls = runtime_obj.TokenAccumulator
        return target_cls(*args, **kwargs)


def generate_with_policy(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).generate_with_policy(*args, **kwargs)


def generate_with_optional_thinking(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).generate_with_optional_thinking(*args, **kwargs)
