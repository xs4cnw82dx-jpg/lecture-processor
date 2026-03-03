from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def recover_stale_runtime_jobs(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).recover_stale_runtime_jobs(*args, **kwargs)


def acquire_runtime_job_recovery_lease(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).acquire_runtime_job_recovery_lease(*args, **kwargs)


def run_startup_recovery_once(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).run_startup_recovery_once(*args, **kwargs)
