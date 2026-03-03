from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def parse_audio_markers_from_notes(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).parse_audio_markers_from_notes(*args, **kwargs)


def format_transcript_with_timestamps(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).format_transcript_with_timestamps(*args, **kwargs)


def ensure_study_audio_root(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).ensure_study_audio_root(*args, **kwargs)


def normalize_audio_storage_key(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).normalize_audio_storage_key(*args, **kwargs)


def resolve_audio_storage_path_from_key(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).resolve_audio_storage_path_from_key(*args, **kwargs)


def infer_audio_storage_key_from_path(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).infer_audio_storage_key_from_path(*args, **kwargs)


def get_audio_storage_key_from_pack(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_audio_storage_key_from_pack(*args, **kwargs)


def get_audio_storage_path_from_pack(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).get_audio_storage_path_from_pack(*args, **kwargs)


def ensure_pack_audio_storage_key(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).ensure_pack_audio_storage_key(*args, **kwargs)


def remove_pack_audio_file(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).remove_pack_audio_file(*args, **kwargs)


def persist_audio_for_study_pack(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).persist_audio_for_study_pack(*args, **kwargs)
