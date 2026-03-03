from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def parse_requested_amount(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).parse_requested_amount(*args, **kwargs)


def parse_study_features(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).parse_study_features(*args, **kwargs)


def normalize_output_language_choice(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).normalize_output_language_choice(*args, **kwargs)


def parse_output_language(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).parse_output_language(*args, **kwargs)


def sanitize_output_language_pref_key(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_output_language_pref_key(*args, **kwargs)


def sanitize_output_language_pref_custom(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_output_language_pref_custom(*args, **kwargs)


def build_user_preferences_payload(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).build_user_preferences_payload(*args, **kwargs)


def parse_interview_features(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).parse_interview_features(*args, **kwargs)
