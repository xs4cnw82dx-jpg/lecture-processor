from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def has_sufficient_upload_disk_space(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).has_sufficient_upload_disk_space(*args, **kwargs)


def reserve_daily_upload_bytes(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).reserve_daily_upload_bytes(*args, **kwargs)
