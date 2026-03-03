from lecture_processor.runtime.container import get_runtime


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def default_streak_data(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).default_streak_data(*args, **kwargs)


def sanitize_progress_date(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_progress_date(*args, **kwargs)


def sanitize_int(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_int(*args, **kwargs)


def sanitize_float(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_float(*args, **kwargs)


def sanitize_streak_data(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_streak_data(*args, **kwargs)


def sanitize_daily_goal_value(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_daily_goal_value(*args, **kwargs)


def sanitize_pack_id(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_pack_id(*args, **kwargs)


def sanitize_card_state_entry(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_card_state_entry(*args, **kwargs)


def sanitize_card_state_map(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_card_state_map(*args, **kwargs)


def derive_card_level_from_stats(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).derive_card_level_from_stats(*args, **kwargs)


def merge_streak_data(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).merge_streak_data(*args, **kwargs)


def merge_timezone_value(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).merge_timezone_value(*args, **kwargs)


def sanitize_timezone_name(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).sanitize_timezone_name(*args, **kwargs)


def resolve_progress_timezone(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).resolve_progress_timezone(*args, **kwargs)


def resolve_user_timezone(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).resolve_user_timezone(*args, **kwargs)


def to_timezone_now(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).to_timezone_now(*args, **kwargs)


def card_state_entry_rank(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).card_state_entry_rank(*args, **kwargs)


def merge_card_state_entries(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).merge_card_state_entries(*args, **kwargs)


def merge_card_state_maps(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).merge_card_state_maps(*args, **kwargs)


def count_due_cards_in_state(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).count_due_cards_in_state(*args, **kwargs)


def compute_study_progress_summary(*args, runtime=None, **kwargs):
    return _resolve_runtime(runtime).compute_study_progress_summary(*args, **kwargs)
