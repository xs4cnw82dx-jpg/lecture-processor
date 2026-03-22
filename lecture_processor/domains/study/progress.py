import re
from datetime import datetime, timedelta, timezone

from lecture_processor.runtime.container import get_runtime

try:
    from zoneinfo import ZoneInfo
except Exception:
    ZoneInfo = None


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _progress_date_re(runtime):
    resolved_runtime = _resolve_runtime(runtime)
    return getattr(resolved_runtime, 'PROGRESS_DATE_RE', re.compile('^\\d{4}-\\d{2}-\\d{2}$'))


def _max_progress_cards_per_pack(runtime):
    resolved_runtime = _resolve_runtime(runtime)
    return int(getattr(resolved_runtime, 'MAX_PROGRESS_CARDS_PER_PACK', 2500) or 2500)


def _max_notes_highlight_ranges(runtime):
    resolved_runtime = _resolve_runtime(runtime)
    return int(getattr(resolved_runtime, 'MAX_NOTES_HIGHLIGHT_RANGES', 2000) or 2000)


def _max_notes_highlight_offset(runtime):
    resolved_runtime = _resolve_runtime(runtime)
    return int(getattr(resolved_runtime, 'MAX_NOTES_HIGHLIGHT_OFFSET', 1000000) or 1000000)


def _max_notes_highlight_base_key_length(runtime):
    resolved_runtime = _resolve_runtime(runtime)
    return int(getattr(resolved_runtime, 'MAX_NOTES_HIGHLIGHT_BASE_KEY_LENGTH', 240) or 240)


def _notes_highlight_colors(runtime):
    resolved_runtime = _resolve_runtime(runtime)
    raw_colors = getattr(resolved_runtime, 'NOTES_HIGHLIGHT_COLORS', ('yellow', 'green', 'blue', 'pink'))
    if not isinstance(raw_colors, (list, tuple, set)):
        return {'yellow', 'green', 'blue', 'pink'}
    cleaned = set()
    for value in raw_colors:
        color = str(value or '').strip().lower()
        if color:
            cleaned.add(color)
    return cleaned or {'yellow', 'green', 'blue', 'pink'}


def default_streak_data(runtime=None):
    _ = runtime
    return {
        'last_study_date': '',
        'current_streak': 0,
        'daily_progress_date': '',
        'daily_progress_count': 0,
    }


def sanitize_progress_date(value, runtime=None):
    text = str(value or '').strip()
    return text if _progress_date_re(runtime).match(text) else ''


def sanitize_int(value, default=0, min_value=0, max_value=10000000, runtime=None):
    _ = runtime
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    if parsed < min_value:
        return min_value
    if parsed > max_value:
        return max_value
    return parsed


def sanitize_float(value, default=0.0, min_value=0.0, max_value=10000000.0, runtime=None):
    _ = runtime
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        return default
    if parsed < min_value:
        return min_value
    if parsed > max_value:
        return max_value
    return parsed


def sanitize_streak_data(payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    base = default_streak_data(runtime=resolved_runtime)
    if not isinstance(payload, dict):
        return base

    base['last_study_date'] = sanitize_progress_date(
        payload.get('last_study_date', ''),
        runtime=resolved_runtime,
    )
    base['current_streak'] = sanitize_int(
        payload.get('current_streak', 0),
        default=0,
        min_value=0,
        max_value=36500,
        runtime=resolved_runtime,
    )
    base['daily_progress_date'] = sanitize_progress_date(
        payload.get('daily_progress_date', ''),
        runtime=resolved_runtime,
    )
    base['daily_progress_count'] = sanitize_int(
        payload.get('daily_progress_count', 0),
        default=0,
        min_value=0,
        max_value=100000,
        runtime=resolved_runtime,
    )
    return base


def sanitize_daily_goal_value(value, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    parsed = sanitize_int(
        value,
        default=-1,
        min_value=-1,
        max_value=500,
        runtime=resolved_runtime,
    )
    if parsed < 1:
        return None
    return parsed


def sanitize_daily_card_goal_value(value, runtime=None):
    return sanitize_daily_goal_value(value, runtime=runtime)


def sanitize_pack_id(value, runtime=None):
    _ = runtime
    pack_id = str(value or '').strip()
    if not pack_id or len(pack_id) > 160:
        return ''
    return pack_id


def sanitize_review_action(value, runtime=None):
    _ = runtime
    action = str(value or '').strip().lower()
    if action in {'retry', 'hard', 'good', 'easy'}:
        return action
    return ''


def card_entry_has_interaction(payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    entry = payload or {}
    return (
        sanitize_int(entry.get('seen', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime) > 0 or
        sanitize_int(entry.get('correct', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime) > 0 or
        sanitize_int(entry.get('wrong', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime) > 0 or
        sanitize_int(entry.get('flip_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime) > 0 or
        sanitize_int(entry.get('write_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime) > 0 or
        bool(sanitize_progress_date(entry.get('last_review_date', ''), runtime=resolved_runtime)) or
        bool(sanitize_review_action(entry.get('last_action', ''), runtime=resolved_runtime))
    )


def sanitize_card_state_entry(payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not isinstance(payload, dict):
        return None

    seen = sanitize_int(payload.get('seen', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime)
    correct = sanitize_int(payload.get('correct', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime)
    wrong = sanitize_int(payload.get('wrong', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime)
    interval_days = sanitize_int(payload.get('interval_days', 0), default=0, min_value=0, max_value=3650, runtime=resolved_runtime)
    max_interval_days = sanitize_int(
        payload.get('max_interval_days', interval_days),
        default=interval_days,
        min_value=0,
        max_value=3650,
        runtime=resolved_runtime,
    )
    flip_count = sanitize_int(payload.get('flip_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime)
    write_count = sanitize_int(payload.get('write_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime)

    level = str(payload.get('level', '')).strip().lower()
    if level not in {'new', 'familiar', 'mastered'}:
        if interval_days >= 14:
            level = 'mastered'
        elif card_entry_has_interaction(
            {
                'seen': seen,
                'correct': correct,
                'wrong': wrong,
                'flip_count': flip_count,
                'write_count': write_count,
                'last_review_date': payload.get('last_review_date', ''),
                'last_action': payload.get('last_action', ''),
            },
            runtime=resolved_runtime,
        ):
            level = 'familiar'
        else:
            level = 'new'

    difficulty = str(payload.get('difficulty', 'medium')).strip().lower()
    if difficulty not in {'easy', 'medium', 'hard'}:
        difficulty = 'medium'

    last_action = sanitize_review_action(payload.get('last_action', ''), runtime=resolved_runtime)

    return {
        'seen': seen,
        'correct': correct,
        'wrong': wrong,
        'level': level,
        'interval_days': interval_days,
        'max_interval_days': max(interval_days, max_interval_days),
        'next_review_date': sanitize_progress_date(payload.get('next_review_date', ''), runtime=resolved_runtime),
        'last_review_date': sanitize_progress_date(payload.get('last_review_date', ''), runtime=resolved_runtime),
        'difficulty': difficulty,
        'last_action': last_action,
        'flip_count': flip_count,
        'write_count': write_count,
    }


def sanitize_card_state_map(payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not isinstance(payload, dict):
        return {}

    cleaned = {}
    max_cards = _max_progress_cards_per_pack(resolved_runtime)
    for raw_card_id, raw_entry in payload.items():
        card_id = str(raw_card_id or '').strip()
        if not card_id or len(card_id) > 64:
            continue
        if not re.match('^(fc|q)_\\d{1,6}$', card_id):
            continue
        entry = sanitize_card_state_entry(raw_entry, runtime=resolved_runtime)
        if entry is None:
            continue
        cleaned[card_id] = entry
        if len(cleaned) >= max_cards:
            break
    return cleaned


def sanitize_notes_highlight_range(payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not isinstance(payload, dict):
        return None

    color = str(payload.get('color', '')).strip().lower()
    if color not in _notes_highlight_colors(resolved_runtime):
        return None

    try:
        start = int(payload.get('start'))
        end = int(payload.get('end'))
    except (TypeError, ValueError):
        return None

    max_offset = _max_notes_highlight_offset(resolved_runtime)
    if start < 0 or end <= start or start > max_offset or end > max_offset:
        return None

    return {
        'start': start,
        'end': end,
        'color': color,
    }


def sanitize_notes_highlights_payload(payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not isinstance(payload, dict):
        return None

    base_key = str(payload.get('base_key', '')).strip()[:_max_notes_highlight_base_key_length(resolved_runtime)]
    if not base_key:
        return None

    raw_ranges = payload.get('ranges')
    if not isinstance(raw_ranges, list):
        return None
    if len(raw_ranges) > _max_notes_highlight_ranges(resolved_runtime):
        return None

    ranges = []
    for raw_range in raw_ranges:
        cleaned_range = sanitize_notes_highlight_range(raw_range, runtime=resolved_runtime)
        if cleaned_range is None:
            return None
        ranges.append(cleaned_range)

    updated_at = sanitize_float(
        payload.get('updated_at', 0),
        default=0.0,
        min_value=0.0,
        max_value=99999999999.0,
        runtime=resolved_runtime,
    )

    return {
        'base_key': base_key,
        'ranges': ranges,
        'updated_at': updated_at,
    }


def derive_card_level_from_stats(seen, interval_days, flip_count=0, write_count=0, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if interval_days >= 14:
        return 'mastered'
    if card_entry_has_interaction(
        {
            'seen': seen,
            'flip_count': flip_count,
            'write_count': write_count,
        },
        runtime=resolved_runtime,
    ):
        return 'familiar'
    return 'new'


def merge_streak_data(server_payload, incoming_payload, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    server = sanitize_streak_data(server_payload, runtime=resolved_runtime)
    incoming = sanitize_streak_data(incoming_payload, runtime=resolved_runtime)

    merged_last_study_date = max(
        server.get('last_study_date', ''),
        incoming.get('last_study_date', ''),
    )
    if merged_last_study_date == server.get('last_study_date', '') and merged_last_study_date != incoming.get('last_study_date', ''):
        merged_current_streak = sanitize_int(
            server.get('current_streak', 0),
            default=0,
            min_value=0,
            max_value=36500,
            runtime=resolved_runtime,
        )
    elif merged_last_study_date == incoming.get('last_study_date', '') and merged_last_study_date != server.get('last_study_date', ''):
        merged_current_streak = sanitize_int(
            incoming.get('current_streak', 0),
            default=0,
            min_value=0,
            max_value=36500,
            runtime=resolved_runtime,
        )
    else:
        merged_current_streak = max(
            sanitize_int(server.get('current_streak', 0), default=0, min_value=0, max_value=36500, runtime=resolved_runtime),
            sanitize_int(incoming.get('current_streak', 0), default=0, min_value=0, max_value=36500, runtime=resolved_runtime),
        )

    merged_daily_progress_date = max(
        server.get('daily_progress_date', ''),
        incoming.get('daily_progress_date', ''),
    )
    if merged_daily_progress_date == server.get('daily_progress_date', '') and merged_daily_progress_date != incoming.get('daily_progress_date', ''):
        merged_daily_progress_count = sanitize_int(
            server.get('daily_progress_count', 0),
            default=0,
            min_value=0,
            max_value=100000,
            runtime=resolved_runtime,
        )
    elif merged_daily_progress_date == incoming.get('daily_progress_date', '') and merged_daily_progress_date != server.get('daily_progress_date', ''):
        merged_daily_progress_count = sanitize_int(
            incoming.get('daily_progress_count', 0),
            default=0,
            min_value=0,
            max_value=100000,
            runtime=resolved_runtime,
        )
    else:
        merged_daily_progress_count = max(
            sanitize_int(server.get('daily_progress_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime),
            sanitize_int(incoming.get('daily_progress_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime),
        )

    if not merged_daily_progress_date:
        merged_daily_progress_count = 0

    return sanitize_streak_data(
        {
            'last_study_date': merged_last_study_date,
            'current_streak': merged_current_streak,
            'daily_progress_date': merged_daily_progress_date,
            'daily_progress_count': merged_daily_progress_count,
        },
        runtime=resolved_runtime,
    )


def merge_timezone_value(server_timezone, incoming_timezone, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    server_value = sanitize_timezone_name(server_timezone, runtime=resolved_runtime)
    incoming_value = sanitize_timezone_name(incoming_timezone, runtime=resolved_runtime)
    return incoming_value or server_value


def sanitize_timezone_name(value, runtime=None):
    _ = runtime
    timezone_name = str(value or '').strip()[:80]
    if not timezone_name:
        return ''
    if ZoneInfo:
        try:
            ZoneInfo(timezone_name)
            return timezone_name
        except Exception:
            return ''
    return timezone_name


def resolve_progress_timezone(progress_data, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    timezone_name = sanitize_timezone_name((progress_data or {}).get('timezone', ''), runtime=resolved_runtime)
    if timezone_name and ZoneInfo:
        try:
            return (ZoneInfo(timezone_name), timezone_name)
        except Exception:
            pass
    return (timezone.utc, 'UTC')


def resolve_user_timezone(uid, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    safe_uid = str(uid or '').strip()
    if not safe_uid or not getattr(resolved_runtime, 'db', None):
        return (timezone.utc, 'UTC')

    try:
        progress_doc = resolved_runtime.study_repo.study_progress_doc_ref(resolved_runtime.db, safe_uid).get()
        progress_data = progress_doc.to_dict() if progress_doc.exists else {}
        return resolve_progress_timezone(progress_data, runtime=resolved_runtime)
    except Exception:
        return (timezone.utc, 'UTC')


def to_timezone_now(base_now, tzinfo, runtime=None):
    _ = runtime
    base = base_now
    if base is None:
        return datetime.now(tzinfo)
    if base.tzinfo is None:
        base = base.replace(tzinfo=timezone.utc)
    return base.astimezone(tzinfo)


def card_state_entry_rank(entry, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    if not isinstance(entry, dict):
        return ('', 0, 0, 0, 0, '')
    return (
        sanitize_progress_date(entry.get('last_review_date', ''), runtime=resolved_runtime),
        sanitize_int(entry.get('seen', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime),
        sanitize_int(entry.get('correct', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime),
        sanitize_int(entry.get('wrong', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime),
        sanitize_int(entry.get('interval_days', 0), default=0, min_value=0, max_value=3650, runtime=resolved_runtime),
        sanitize_progress_date(entry.get('next_review_date', ''), runtime=resolved_runtime),
    )


def merge_card_state_entries(server_entry, incoming_entry, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    cleaned_server = sanitize_card_state_entry(server_entry, runtime=resolved_runtime)
    cleaned_incoming = sanitize_card_state_entry(incoming_entry, runtime=resolved_runtime)
    if cleaned_server is None:
        return cleaned_incoming
    if cleaned_incoming is None:
        return cleaned_server

    server_last = sanitize_progress_date(cleaned_server.get('last_review_date', ''), runtime=resolved_runtime)
    incoming_last = sanitize_progress_date(cleaned_incoming.get('last_review_date', ''), runtime=resolved_runtime)
    merged_last = max(server_last, incoming_last)

    if merged_last == server_last and merged_last != incoming_last:
        source_for_schedule = cleaned_server
    elif merged_last == incoming_last and merged_last != server_last:
        source_for_schedule = cleaned_incoming
    else:
        source_for_schedule = (
            cleaned_server
            if card_state_entry_rank(cleaned_server, runtime=resolved_runtime)
            >= card_state_entry_rank(cleaned_incoming, runtime=resolved_runtime)
            else cleaned_incoming
        )

    merged_seen = max(cleaned_server.get('seen', 0), cleaned_incoming.get('seen', 0))
    merged_correct = max(cleaned_server.get('correct', 0), cleaned_incoming.get('correct', 0))
    merged_wrong = max(cleaned_server.get('wrong', 0), cleaned_incoming.get('wrong', 0))

    minimum_seen = merged_correct + merged_wrong
    if merged_seen < minimum_seen:
        merged_seen = minimum_seen

    merged_interval_days = sanitize_int(
        source_for_schedule.get('interval_days', 0),
        default=0,
        min_value=0,
        max_value=3650,
        runtime=resolved_runtime,
    )
    merged_max_interval_days = max(
        sanitize_int(cleaned_server.get('max_interval_days', 0), default=0, min_value=0, max_value=3650, runtime=resolved_runtime),
        sanitize_int(cleaned_incoming.get('max_interval_days', 0), default=0, min_value=0, max_value=3650, runtime=resolved_runtime),
        merged_interval_days,
    )
    merged_next_review_date = sanitize_progress_date(source_for_schedule.get('next_review_date', ''), runtime=resolved_runtime)
    if not merged_next_review_date:
        merged_next_review_date = max(
            sanitize_progress_date(cleaned_server.get('next_review_date', ''), runtime=resolved_runtime),
            sanitize_progress_date(cleaned_incoming.get('next_review_date', ''), runtime=resolved_runtime),
        )

    merged_difficulty = str(source_for_schedule.get('difficulty', 'medium')).strip().lower()
    if merged_difficulty not in {'easy', 'medium', 'hard'}:
        merged_difficulty = 'medium'
    merged_last_action = sanitize_review_action(source_for_schedule.get('last_action', ''), runtime=resolved_runtime)
    merged_flip_count = max(
        sanitize_int(cleaned_server.get('flip_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime),
        sanitize_int(cleaned_incoming.get('flip_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime),
    )
    merged_write_count = max(
        sanitize_int(cleaned_server.get('write_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime),
        sanitize_int(cleaned_incoming.get('write_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime),
    )

    merged_entry = {
        'seen': merged_seen,
        'correct': merged_correct,
        'wrong': merged_wrong,
        'interval_days': merged_interval_days,
        'max_interval_days': merged_max_interval_days,
        'last_review_date': merged_last,
        'next_review_date': merged_next_review_date,
        'difficulty': merged_difficulty,
        'last_action': merged_last_action,
        'flip_count': merged_flip_count,
        'write_count': merged_write_count,
        'level': derive_card_level_from_stats(
            merged_seen,
            merged_interval_days,
            merged_flip_count,
            merged_write_count,
            runtime=resolved_runtime,
        ),
    }
    return sanitize_card_state_entry(merged_entry, runtime=resolved_runtime)


def merge_card_state_maps(server_state, incoming_state, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    cleaned_server = sanitize_card_state_map(server_state, runtime=resolved_runtime)
    cleaned_incoming = sanitize_card_state_map(incoming_state, runtime=resolved_runtime)
    merged = {}
    max_cards = _max_progress_cards_per_pack(resolved_runtime)

    for card_id in sorted(set(cleaned_server.keys()) | set(cleaned_incoming.keys())):
        merged_entry = merge_card_state_entries(
            cleaned_server.get(card_id),
            cleaned_incoming.get(card_id),
            runtime=resolved_runtime,
        )
        if merged_entry is None:
            continue
        merged[card_id] = merged_entry
        if len(merged) >= max_cards:
            break
    return merged


def count_due_cards_in_state(state, today_local, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    due = 0
    for card_id, entry in (state or {}).items():
        if not str(card_id).startswith('fc_'):
            continue
        if not card_entry_has_interaction(entry, runtime=resolved_runtime):
            continue
        next_date = str((entry or {}).get('next_review_date', '') or '').strip()
        if not next_date or next_date <= today_local:
            due += 1
    return due


def compute_study_progress_summary(progress_data, card_state_maps, base_now=None, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    progress = progress_data or {}
    streak_data = sanitize_streak_data(progress.get('streak_data', {}), runtime=resolved_runtime)

    daily_goal = sanitize_daily_goal_value(progress.get('daily_goal'), runtime=resolved_runtime)
    if daily_goal is None:
        daily_goal = 20

    tzinfo, _timezone_name = resolve_progress_timezone(progress, runtime=resolved_runtime)
    now_local = to_timezone_now(base_now, tzinfo, runtime=resolved_runtime)
    today_local = now_local.strftime('%Y-%m-%d')
    yesterday_local = (now_local - timedelta(days=1)).strftime('%Y-%m-%d')

    current_streak = 0
    if streak_data.get('last_study_date') in {today_local, yesterday_local}:
        current_streak = sanitize_int(streak_data.get('current_streak', 0), default=0, min_value=0, max_value=36500, runtime=resolved_runtime)

    today_progress = 0
    if streak_data.get('daily_progress_date') == today_local:
        today_progress = sanitize_int(streak_data.get('daily_progress_count', 0), default=0, min_value=0, max_value=100000, runtime=resolved_runtime)

    due_today = 0
    for raw_state in card_state_maps or []:
        due_today += count_due_cards_in_state(sanitize_card_state_map(raw_state, runtime=resolved_runtime), today_local, runtime=resolved_runtime)

    return {
        'daily_goal': daily_goal,
        'current_streak': current_streak,
        'today_progress': today_progress,
        'due_today': due_today,
    }
