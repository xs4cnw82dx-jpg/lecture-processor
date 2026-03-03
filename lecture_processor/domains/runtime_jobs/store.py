from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _runtime_job_storage_enabled(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime)._runtime_job_storage_enabled(*args, **kwargs)


def _runtime_job_sanitize_value(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime)._runtime_job_sanitize_value(*args, **kwargs)


def _build_runtime_job_payload(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime)._build_runtime_job_payload(*args, **kwargs)


def persist_runtime_job_snapshot(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).persist_runtime_job_snapshot(*args, **kwargs)


def load_runtime_job_snapshot(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).load_runtime_job_snapshot(*args, **kwargs)


def delete_runtime_job_snapshot(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).delete_runtime_job_snapshot(*args, **kwargs)


def update_job_fields(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).update_job_fields(*args, **kwargs)


def get_job_snapshot(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_job_snapshot(*args, **kwargs)


def mutate_job(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).mutate_job(*args, **kwargs)


def set_job(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).set_job(*args, **kwargs)


def delete_job(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).delete_job(*args, **kwargs)
