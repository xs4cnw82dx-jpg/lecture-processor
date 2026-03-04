from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def parse_requested_amount(raw_value, allowed, default, runtime=None):
    value = str(raw_value or default).strip().lower()
    return value if value in allowed else default


def parse_study_features(raw_value, runtime=None):
    value = str(raw_value or 'none').strip().lower()
    return value if value in {'none', 'flashcards', 'test', 'both'} else 'none'


def normalize_output_language_choice(raw_value, custom_value='', runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    default_key = resolved_runtime.DEFAULT_OUTPUT_LANGUAGE_KEY
    language_map = resolved_runtime.OUTPUT_LANGUAGE_MAP
    max_custom = int(getattr(resolved_runtime, 'MAX_OUTPUT_LANGUAGE_CUSTOM_LENGTH', 40) or 40)

    key = str(raw_value or default_key).strip().lower()
    custom = str(custom_value or '').strip()[:max_custom]
    if key in language_map:
        return (key, '', language_map[key])
    if key == 'other':
        if custom:
            return ('other', custom, custom)
        return (default_key, '', language_map[default_key])
    return (default_key, '', language_map[default_key])


def parse_output_language(raw_value, custom_value='', runtime=None):
    _key, _custom, resolved = normalize_output_language_choice(raw_value, custom_value, runtime=runtime)
    return resolved


def sanitize_output_language_pref_key(raw_value, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    default_key = resolved_runtime.DEFAULT_OUTPUT_LANGUAGE_KEY
    output_language_keys = resolved_runtime.OUTPUT_LANGUAGE_KEYS
    key = str(raw_value or default_key).strip().lower()
    return key if key in output_language_keys else default_key


def sanitize_output_language_pref_custom(raw_value, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    max_custom = int(getattr(resolved_runtime, 'MAX_OUTPUT_LANGUAGE_CUSTOM_LENGTH', 40) or 40)
    return str(raw_value or '').strip()[:max_custom]


def build_user_preferences_payload(user_data, runtime=None):
    key, custom, resolved = normalize_output_language_choice(
        user_data.get('preferred_output_language', _resolve_runtime(runtime).DEFAULT_OUTPUT_LANGUAGE_KEY),
        user_data.get('preferred_output_language_custom', ''),
        runtime=runtime,
    )
    return {
        'output_language': key,
        'output_language_custom': custom,
        'output_language_label': resolved,
        'onboarding_completed': bool(user_data.get('onboarding_completed', False)),
    }


def parse_interview_features(raw_value, runtime=None):
    value = str(raw_value or 'none').strip().lower()
    if value in {'none', ''}:
        return []
    if value == 'both':
        return ['summary', 'sections']
    parts = [part.strip() for part in value.split(',') if part.strip()]
    features = []
    for part in parts:
        if part in {'summary', 'sections'} and part not in features:
            features.append(part)
    return features
