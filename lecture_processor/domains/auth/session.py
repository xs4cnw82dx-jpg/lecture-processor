from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _extract_bearer_token(req, runtime=None):
    return _resolve_runtime(runtime)._extract_bearer_token(req)


def verify_admin_session_cookie(req, runtime=None):
    return _resolve_runtime(runtime).verify_admin_session_cookie(req)
