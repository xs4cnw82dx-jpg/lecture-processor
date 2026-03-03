from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def save_study_pack(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).save_study_pack(*args, **kwargs)


def process_lecture_notes(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).process_lecture_notes(*args, **kwargs)


def process_slides_only(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).process_slides_only(*args, **kwargs)


def process_interview_transcription(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).process_interview_transcription(*args, **kwargs)
