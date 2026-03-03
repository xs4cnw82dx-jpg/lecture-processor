from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def load_email_allowlist_config(path, runtime=None):
    return _resolve_runtime(runtime).load_email_allowlist_config(path)


def is_email_allowed(email, runtime=None):
    return _resolve_runtime(runtime).is_email_allowed(email)
