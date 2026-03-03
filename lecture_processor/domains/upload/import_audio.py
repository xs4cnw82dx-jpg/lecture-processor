from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def validate_video_import_url(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).validate_video_import_url(*args, **kwargs)


def cleanup_expired_audio_import_tokens(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).cleanup_expired_audio_import_tokens(*args, **kwargs)


def register_audio_import_token(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).register_audio_import_token(*args, **kwargs)


def get_audio_import_token_path(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_audio_import_token_path(*args, **kwargs)


def release_audio_import_token(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).release_audio_import_token(*args, **kwargs)
