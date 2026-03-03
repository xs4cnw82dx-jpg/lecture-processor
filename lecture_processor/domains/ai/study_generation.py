from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def generate_study_materials(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).generate_study_materials(*args, **kwargs)


def generate_interview_enhancements(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).generate_interview_enhancements(*args, **kwargs)
