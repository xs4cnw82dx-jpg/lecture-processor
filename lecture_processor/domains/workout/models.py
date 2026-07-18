from __future__ import annotations

from copy import deepcopy
from datetime import date, datetime, timedelta, timezone
from functools import lru_cache
import json
import math
from pathlib import Path
import re


MAX_EXERCISES = 24
MAX_SETS = 12
MAX_NOTES = 2000
ALLOWED_TRACKING_TYPES = {
    'weight_reps',
    'bodyweight',
    'weighted_bodyweight',
    'assisted_bodyweight',
    'duration',
}
ALLOWED_SET_TYPES = {'normal', 'warmup', 'drop', 'failure'}


@lru_cache(maxsize=1)
def load_seed() -> dict:
    seed_path = Path(__file__).with_name('seed_v1.json')
    with seed_path.open('r', encoding='utf-8') as seed_file:
        return json.load(seed_file)


def bounded_text(value, limit=200, *, fallback='') -> str:
    text = str(value or fallback).strip()
    return text[: max(0, int(limit))]


def safe_id(value, *, prefix='item') -> str:
    candidate = re.sub(r'[^a-zA-Z0-9_-]+', '-', str(value or '').strip()).strip('-_')[:96]
    return candidate or prefix


def utc_iso(now_ts=None) -> str:
    if now_ts is None:
        moment = datetime.now(timezone.utc)
    else:
        moment = datetime.fromtimestamp(float(now_ts), tz=timezone.utc)
    return moment.isoformat().replace('+00:00', 'Z')


def _number(value, default=0.0, minimum=0.0, maximum=10000.0) -> float:
    try:
        parsed = float(value)
    except (TypeError, ValueError):
        parsed = float(default)
    if not math.isfinite(parsed):
        parsed = float(default)
    return max(float(minimum), min(float(maximum), parsed))


def _integer(value, default=0, minimum=0, maximum=10000) -> int:
    return int(round(_number(value, default, minimum, maximum)))


def default_settings() -> dict:
    return {
        'timer_sound': True,
        'timer_volume': 0.75,
        'default_rest_seconds': 150,
        'previous_values_scope': 'same_routine',
        'rpe_enabled': True,
        'warmup_sets_in_statistics': False,
        'smart_superset_scrolling': True,
        'keep_awake': True,
        'live_pr_notifications': True,
        'rest_notifications': False,
        'warmup_steps': deepcopy(load_seed()['warmup_defaults']),
    }


def default_profile(uid: str) -> dict:
    seed_profile = load_seed()['profile']
    return {
        'uid': uid,
        'revision': 0,
        'setup_completed': False,
        'bodyweight_kg': seed_profile['bodyweight_kg'],
        'height_cm': seed_profile['height_cm'],
        'handle_weight_kg': seed_profile['handle_weight_per_dumbbell_kg'],
        'optional_day_enabled': seed_profile['optional_day_enabled'],
        'training_days': {'A': 1, 'B': 3, 'C': 5, 'D': 6},
        'active_cycle_id': '',
        'start_tests': [],
        'settings': default_settings(),
    }


def sanitize_profile(payload: dict, existing: dict, *, uid: str, now_ts: float) -> dict:
    source = payload if isinstance(payload, dict) else {}
    current = deepcopy(existing or default_profile(uid))
    current['uid'] = uid
    current['bodyweight_kg'] = _number(source.get('bodyweight_kg', current.get('bodyweight_kg')), 62.5, 20, 400)
    current['height_cm'] = _number(source.get('height_cm', current.get('height_cm')), 174.5, 80, 260)
    current['handle_weight_kg'] = _number(source.get('handle_weight_kg', current.get('handle_weight_kg')), 0, 0, 10)
    current['optional_day_enabled'] = bool(source.get('optional_day_enabled', current.get('optional_day_enabled', True)))
    current['setup_completed'] = bool(source.get('setup_completed', current.get('setup_completed', False)))
    days = source.get('training_days') if isinstance(source.get('training_days'), dict) else current.get('training_days', {})
    current['training_days'] = {
        'A': _integer(days.get('A', 1), 1, 1, 7),
        'B': _integer(days.get('B', 3), 3, 1, 7),
        'C': _integer(days.get('C', 5), 5, 1, 7),
        'D': _integer(days.get('D', 6), 6, 1, 7),
    }
    settings_payload = source.get('settings') if isinstance(source.get('settings'), dict) else {}
    settings = deepcopy(current.get('settings') or default_settings())
    for key in ('timer_sound', 'rpe_enabled', 'warmup_sets_in_statistics', 'smart_superset_scrolling', 'keep_awake', 'live_pr_notifications', 'rest_notifications'):
        if key in settings_payload:
            settings[key] = bool(settings_payload[key])
    settings['timer_volume'] = _number(settings_payload.get('timer_volume', settings.get('timer_volume')), .75, 0, 1)
    settings['default_rest_seconds'] = _integer(settings_payload.get('default_rest_seconds', settings.get('default_rest_seconds')), 150, 0, 900)
    scope = bounded_text(settings_payload.get('previous_values_scope', settings.get('previous_values_scope')), 24)
    settings['previous_values_scope'] = scope if scope in {'same_routine', 'any_workout'} else 'same_routine'
    warmup_steps = settings_payload.get('warmup_steps', settings.get('warmup_steps'))
    safe_steps = []
    for step in list(warmup_steps or [])[:6]:
        if not isinstance(step, dict):
            continue
        safe_steps.append({
            'percent': _integer(step.get('percent'), 50, 1, 100),
            'reps': _integer(step.get('reps'), 5, 1, 50),
        })
    settings['warmup_steps'] = safe_steps or deepcopy(load_seed()['warmup_defaults'])
    current['settings'] = settings
    current['revision'] = _integer(current.get('revision'), 0, 0, 10_000_000) + 1
    current['updated_at'] = utc_iso(now_ts)
    return current


def sanitize_exercise(payload: dict, *, uid: str, existing=None, now_ts: float) -> tuple[dict | None, str]:
    source = payload if isinstance(payload, dict) else {}
    current = deepcopy(existing or {})
    name = bounded_text(source.get('name', current.get('name')), 100)
    if not name:
        return None, 'Exercise name is required.'
    tracking_type = bounded_text(source.get('tracking_type', current.get('tracking_type', 'weight_reps')), 32)
    if tracking_type not in ALLOWED_TRACKING_TYPES:
        return None, 'Invalid exercise tracking type.'
    exercise_id = safe_id(source.get('id', current.get('id')), prefix=f'exercise-{int(now_ts * 1000)}')
    load_type = bounded_text(source.get('load_type', current.get('load_type', 'Custom')), 40)
    safe = {
        'id': exercise_id,
        'uid': uid,
        'name': name,
        'tracking_type': tracking_type,
        'load_type': load_type,
        'equipment': bounded_text(source.get('equipment', current.get('equipment')), 120),
        'muscle_group': bounded_text(source.get('muscle_group', current.get('muscle_group')), 80),
        'notes': bounded_text(source.get('notes', current.get('notes')), MAX_NOTES),
        'default_rest_seconds': _integer(source.get('default_rest_seconds', current.get('default_rest_seconds', 150)), 150, 0, 900),
        'bodyweight_contributes': bool(source.get('bodyweight_contributes', current.get('bodyweight_contributes', False))),
        'pair_multiplier': 2 if _integer(source.get('pair_multiplier', current.get('pair_multiplier', 1)), 1, 1, 2) == 2 else 1,
        'seeded': bool(current.get('seeded', False)),
        'archived': bool(source.get('archived', current.get('archived', False))),
        'revision': _integer(current.get('revision'), 0, 0, 10_000_000) + 1,
        'updated_at': utc_iso(now_ts),
    }
    return safe, ''


def _sanitize_routine_exercise(item: dict, index: int) -> dict | None:
    if not isinstance(item, dict):
        return None
    exercise_id = safe_id(item.get('exercise_id'), prefix='')
    if not exercise_id:
        return None
    rep_min = _integer(item.get('rep_min'), 1, 0, 1000)
    rep_max = _integer(item.get('rep_max'), max(rep_min, 1), rep_min, 1000)
    return {
        'exercise_id': exercise_id,
        'order': index + 1,
        'sets': _integer(item.get('sets'), 3, 1, MAX_SETS),
        'rep_min': rep_min,
        'rep_max': rep_max,
        'start_kg': _number(item.get('start_kg'), 0, 0, 500),
        'rest_seconds': _integer(item.get('rest_seconds'), 150, 0, 900),
        'rest_range': bounded_text(item.get('rest_range'), 24),
        'load_type': bounded_text(item.get('load_type'), 40),
        'early_rpe': _number(item.get('early_rpe'), 8, 0, 10),
        'last_rpe': _number(item.get('last_rpe'), 9, 0, 10),
        'technique': bounded_text(item.get('technique'), 500),
        'cues': bounded_text(item.get('cues'), 1000),
        'superset_id': safe_id(item.get('superset_id'), prefix='') if item.get('superset_id') else '',
    }


def sanitize_routine(payload: dict, *, uid: str, existing=None, now_ts: float) -> tuple[dict | None, str]:
    source = payload if isinstance(payload, dict) else {}
    current = deepcopy(existing or {})
    name = bounded_text(source.get('name', current.get('name')), 100)
    if not name:
        return None, 'Routine name is required.'
    raw_exercises = source.get('exercises', current.get('exercises', []))
    if not isinstance(raw_exercises, list) or not raw_exercises:
        return None, 'Add at least one exercise.'
    exercises = []
    for index, item in enumerate(raw_exercises[:MAX_EXERCISES]):
        safe_item = _sanitize_routine_exercise(item, index)
        if safe_item:
            exercises.append(safe_item)
    if not exercises:
        return None, 'Add at least one valid exercise.'
    routine_id = safe_id(source.get('id', current.get('id')), prefix=f'routine-{int(now_ts * 1000)}')
    return {
        'id': routine_id,
        'uid': uid,
        'name': name,
        'focus': bounded_text(source.get('focus', current.get('focus')), 160),
        'block': _integer(source.get('block', current.get('block')), 0, 0, 2),
        'day': bounded_text(source.get('day', current.get('day')), 1).upper(),
        'optional': bool(source.get('optional', current.get('optional', False))),
        'seeded': bool(current.get('seeded', False)),
        'archived': bool(source.get('archived', current.get('archived', False))),
        'exercises': exercises,
        'revision': _integer(current.get('revision'), 0, 0, 10_000_000) + 1,
        'updated_at': utc_iso(now_ts),
    }, ''


def baseline_routines(uid: str) -> list[dict]:
    routines = []
    for template in load_seed()['templates']:
        item = deepcopy(template)
        item.update({'uid': uid, 'revision': 0, 'archived': False})
        routines.append(item)
    return routines


def merged_exercises(uid: str, custom_records: list[dict]) -> list[dict]:
    records = {}
    for seed_exercise in load_seed()['exercises']:
        item = deepcopy(seed_exercise)
        item.update({'uid': uid, 'revision': 0, 'archived': False, 'notes': ''})
        records[item['id']] = item
    for record in custom_records or []:
        if isinstance(record, dict) and record.get('id'):
            records[str(record['id'])] = deepcopy(record)
    return sorted(records.values(), key=lambda item: (bool(item.get('archived')), str(item.get('name', '')).lower()))


def merged_routines(uid: str, custom_records: list[dict]) -> list[dict]:
    records = {item['id']: item for item in baseline_routines(uid)}
    for record in custom_records or []:
        if isinstance(record, dict) and record.get('id'):
            records[str(record['id'])] = deepcopy(record)
    return sorted(records.values(), key=lambda item: (bool(item.get('archived')), int(item.get('block', 9) or 9), str(item.get('day', 'Z')), str(item.get('name', '')).lower()))


def normalize_start_monday(value) -> date:
    try:
        parsed = date.fromisoformat(str(value or ''))
    except ValueError:
        parsed = date.today()
    return parsed - timedelta(days=parsed.weekday())


def prescriptions_for(week: int, day: str) -> list[dict]:
    return [deepcopy(item) for item in load_seed()['prescriptions'] if int(item['week']) == int(week) and item['day'] == day]


def build_cycle(uid: str, cycle_id: str, start_monday, *, now_ts: float, routines: list[dict] | None = None, training_days: dict | None = None) -> tuple[dict, list[dict]]:
    start = normalize_start_monday(start_monday)
    routine_map = {(int(item.get('block', 0)), str(item.get('day', ''))): item for item in (routines or []) if not item.get('archived')}
    cycle = {
        'id': cycle_id,
        'uid': uid,
        'name': f"10-week cycle · {start.isoformat()}",
        'start_monday': start.isoformat(),
        'end_date': (start + timedelta(days=69)).isoformat(),
        'status': 'active',
        'seed_id': load_seed()['seed_id'],
        'source_sha256': load_seed()['source']['sha256'],
        'revision': 1,
        'created_at': utc_iso(now_ts),
        'updated_at': utc_iso(now_ts),
    }
    selected_days = training_days if isinstance(training_days, dict) else {'A': 1, 'B': 3, 'C': 5, 'D': 6}
    offsets = {day_code: _integer(selected_days.get(day_code), fallback, 1, 7) - 1 for day_code, fallback in {'A': 1, 'B': 3, 'C': 5, 'D': 6}.items()}
    occurrences = []
    for week in range(1, 11):
        block = 1 if week <= 5 else 2
        phase = 'Build' if week <= 4 else ('Semi-deload' if week == 5 else 'Novelty')
        for day_code in ('A', 'B', 'C', 'D'):
            occurrence_id = f'{cycle_id}-w{week}-{day_code.lower()}'
            weekly_rows = prescriptions_for(week, day_code)
            routine = routine_map.get((block, day_code))
            if routine:
                weekly_by_id = {item['exercise_id']: item for item in weekly_rows}
                edited_rows = []
                for index, edited in enumerate(routine.get('exercises', [])):
                    weekly_row = deepcopy(weekly_by_id.get(edited.get('exercise_id'), {
                        'id': f'w{week}-{day_code.lower()}-custom-{index + 1}',
                        'week': week,
                        'phase': phase,
                        'day': day_code,
                        'focus': routine.get('focus', ''),
                        'exercise_id': edited.get('exercise_id'),
                        'exercise_name': edited.get('exercise_id'),
                        'muscle_group': '',
                        'source_exercise': '',
                        'load_type': edited.get('load_type', 'Custom'),
                        'start_kg': edited.get('start_kg', 0),
                        'early_rpe': edited.get('early_rpe', 8),
                        'last_rpe': edited.get('last_rpe', 9),
                        'source': 'Custom routine edit',
                    }))
                    for key in ('sets', 'rep_min', 'rep_max', 'start_kg', 'load_type', 'rest_seconds', 'rest_range', 'technique', 'cues', 'superset_id'):
                        if key in edited:
                            weekly_row[key] = deepcopy(edited[key])
                    weekly_row['order'] = index + 1
                    edited_rows.append(weekly_row)
                weekly_rows = edited_rows
            occurrences.append({
                'id': occurrence_id,
                'uid': uid,
                'cycle_id': cycle_id,
                'week': week,
                'block': block,
                'phase': phase,
                'day': day_code,
                'date': (start + timedelta(days=(week - 1) * 7 + offsets[day_code])).isoformat(),
                'name': f"{day_code} · {weekly_rows[0]['focus'] if weekly_rows else 'Workout'}",
                'focus': weekly_rows[0]['focus'] if weekly_rows else '',
                'optional': day_code == 'D',
                'status': 'planned',
                'session_id': '',
                'revision': 1,
                'exercises': weekly_rows,
                'created_at': utc_iso(now_ts),
                'updated_at': utc_iso(now_ts),
            })
    return cycle, occurrences


def next_available_load(current_kg: float, load_type: str) -> float:
    seed = load_seed()
    loads = seed['available_loads']['backpack_kg'] if load_type == 'Backpack/BW' else seed['available_loads']['dumbbell_per_hand_kg']
    current = _number(current_kg, 0, 0, 500)
    for load in loads:
        if float(load) > current + .001:
            return float(load)
    return current


def previous_available_load(current_kg: float, load_type: str) -> float:
    seed = load_seed()
    loads = seed['available_loads']['backpack_kg'] if load_type == 'Backpack/BW' else seed['available_loads']['dumbbell_per_hand_kg']
    current = _number(current_kg, 0, 0, 500)
    candidates = [float(load) for load in loads if float(load) < current - .001]
    return candidates[-1] if candidates else current


def start_test_advice(*, test_kg: float, test_reps, rep_min: int, rep_max: int, load_type: str) -> dict:
    if test_reps in (None, ''):
        return {'advice': 'Invullen na eerste test', 'suggested_start_kg': _number(test_kg)}
    reps = _integer(test_reps, 0, 0, 1000)
    current = _number(test_kg, 0, 0, 500)
    if reps < int(rep_min):
        return {'advice': 'Lichter starten', 'suggested_start_kg': previous_available_load(current, load_type)}
    if reps > int(rep_max) + 5:
        return {'advice': 'Load capped: zwaardere variant/tempo/partials', 'suggested_start_kg': next_available_load(current, load_type)}
    if reps > int(rep_max):
        return {'advice': 'Volgende beschikbare load', 'suggested_start_kg': next_available_load(current, load_type)}
    return {'advice': 'Goed startgewicht', 'suggested_start_kg': current}


def warmup_sets(target_kg: float, load_type: str, steps=None) -> list[dict]:
    seed = load_seed()
    loads = seed['available_loads']['backpack_kg'] if load_type == 'Backpack/BW' else seed['available_loads']['dumbbell_per_hand_kg']
    target = _number(target_kg, 0, 0, 500)
    result = []
    for item in list(steps or seed['warmup_defaults'])[:6]:
        percent = _integer(item.get('percent'), 50, 1, 100)
        desired = target * percent / 100
        candidates = [float(load) for load in loads if float(load) <= desired + .0001]
        result.append({'percent': percent, 'reps': _integer(item.get('reps'), 5, 1, 50), 'kg': candidates[-1] if candidates else 0})
    return result


def _safe_set(item: dict, index: int) -> dict:
    source = item if isinstance(item, dict) else {}
    set_type = bounded_text(source.get('type', 'normal'), 16).lower()
    if set_type not in ALLOWED_SET_TYPES:
        set_type = 'normal'
    return {
        'id': safe_id(source.get('id'), prefix=f'set-{index + 1}'),
        'type': set_type,
        'kg': _number(source.get('kg'), 0, 0, 500),
        'reps': _integer(source.get('reps'), 0, 0, 1000),
        'rpe': _number(source.get('rpe'), 0, 0, 10),
        'duration_seconds': _integer(source.get('duration_seconds'), 0, 0, 86_400),
        'completed': bool(source.get('completed', False)),
        'completed_at': bounded_text(source.get('completed_at'), 40),
    }


def _safe_session_exercise(item: dict, index: int) -> dict | None:
    if not isinstance(item, dict):
        return None
    exercise_id = safe_id(item.get('exercise_id'), prefix='')
    if not exercise_id:
        return None
    raw_sets = item.get('sets') if isinstance(item.get('sets'), list) else []
    sets = [_safe_set(set_item, set_index) for set_index, set_item in enumerate(raw_sets[:MAX_SETS])]
    return {
        'exercise_id': exercise_id,
        'exercise_name': bounded_text(item.get('exercise_name'), 100),
        'order': index + 1,
        'tracking_type': bounded_text(item.get('tracking_type', 'weight_reps'), 32),
        'load_type': bounded_text(item.get('load_type'), 40),
        'muscle_group': bounded_text(item.get('muscle_group'), 80),
        'pair_multiplier': 2 if _integer(item.get('pair_multiplier'), 1, 1, 2) == 2 else 1,
        'bodyweight_contributes': bool(item.get('bodyweight_contributes', False)),
        'target_sets': _integer(item.get('target_sets'), len(sets) or 3, 1, MAX_SETS),
        'rep_min': _integer(item.get('rep_min'), 1, 0, 1000),
        'rep_max': _integer(item.get('rep_max'), 1, 0, 1000),
        'early_rpe': _number(item.get('early_rpe'), 8, 0, 10),
        'last_rpe': _number(item.get('last_rpe'), 9, 0, 10),
        'rest_seconds': _integer(item.get('rest_seconds'), 150, 0, 900),
        'rest_range': bounded_text(item.get('rest_range'), 24),
        'technique': bounded_text(item.get('technique'), 500),
        'cues': bounded_text(item.get('cues'), 1000),
        'notes': bounded_text(item.get('notes'), MAX_NOTES),
        'superset_id': safe_id(item.get('superset_id'), prefix='') if item.get('superset_id') else '',
        'sets': sets,
    }


def create_session_snapshot(uid: str, session_id: str, *, occurrence=None, routine=None, exercises_by_id=None, bodyweight_kg=0, now_ts: float) -> dict:
    source = occurrence or routine or {}
    exercises_lookup = exercises_by_id or {}
    session_exercises = []
    for index, prescribed in enumerate(source.get('exercises', [])[:MAX_EXERCISES]):
        exercise = exercises_lookup.get(prescribed.get('exercise_id'), {})
        target_sets = _integer(prescribed.get('sets'), 3, 1, MAX_SETS)
        sets = []
        for set_index in range(target_sets):
            target_rpe = prescribed.get('last_rpe') if set_index == target_sets - 1 else prescribed.get('early_rpe')
            sets.append({
                'id': f'set-{set_index + 1}',
                'type': 'normal',
                'kg': _number(prescribed.get('start_kg'), 0, 0, 500),
                'reps': 0,
                'rpe': _number(target_rpe, 0, 0, 10),
                'duration_seconds': 0,
                'completed': False,
                'completed_at': '',
            })
        session_exercises.append({
            'exercise_id': prescribed.get('exercise_id'),
            'exercise_name': exercise.get('name') or prescribed.get('exercise_name') or prescribed.get('exercise_id'),
            'order': index + 1,
            'tracking_type': exercise.get('tracking_type', 'weight_reps'),
            'load_type': exercise.get('load_type') or prescribed.get('load_type', ''),
            'muscle_group': exercise.get('muscle_group') or prescribed.get('muscle_group', ''),
            'pair_multiplier': exercise.get('pair_multiplier', 1),
            'bodyweight_contributes': exercise.get('bodyweight_contributes', False),
            'target_sets': target_sets,
            'rep_min': _integer(prescribed.get('rep_min'), 1, 0, 1000),
            'rep_max': _integer(prescribed.get('rep_max'), 1, 0, 1000),
            'early_rpe': _number(prescribed.get('early_rpe'), 8, 0, 10),
            'last_rpe': _number(prescribed.get('last_rpe'), 9, 0, 10),
            'rest_seconds': _integer(prescribed.get('rest_seconds'), 150, 0, 900),
            'rest_range': bounded_text(prescribed.get('rest_range'), 24),
            'technique': bounded_text(prescribed.get('technique'), 500),
            'cues': bounded_text(prescribed.get('cues'), 1000),
            'notes': '',
            'superset_id': bounded_text(prescribed.get('superset_id'), 96),
            'sets': sets,
        })
    return {
        'id': session_id,
        'uid': uid,
        'occurrence_id': source.get('id', '') if occurrence else '',
        'routine_id': source.get('id', '') if routine else '',
        'cycle_id': source.get('cycle_id', ''),
        'week': _integer(source.get('week'), 0, 0, 10),
        'phase': bounded_text(source.get('phase'), 40),
        'day': bounded_text(source.get('day'), 1).upper(),
        'name': bounded_text(source.get('name', 'Empty Workout'), 100),
        'date': bounded_text(source.get('date', date.today().isoformat()), 10),
        'optional': bool(source.get('optional', False)),
        'status': 'active',
        'revision': 1,
        'bodyweight_kg': _number(bodyweight_kg, 0, 0, 400),
        'elapsed_seconds': 0,
        'started_at': utc_iso(now_ts),
        'updated_at': utc_iso(now_ts),
        'finished_at': '',
        'notes': '',
        'exercises': session_exercises,
    }


def sanitize_session_update(payload: dict, existing: dict, *, now_ts: float) -> tuple[dict | None, str]:
    if not isinstance(payload, dict):
        return None, 'Invalid session payload.'
    current = deepcopy(existing or {})
    raw_exercises = payload.get('exercises', current.get('exercises'))
    if not isinstance(raw_exercises, list):
        return None, 'Exercises must be a list.'
    exercises = []
    for index, item in enumerate(raw_exercises[:MAX_EXERCISES]):
        safe_item = _safe_session_exercise(item, index)
        if safe_item:
            exercises.append(safe_item)
    if not exercises and raw_exercises:
        return None, 'No valid exercises supplied.'
    current['name'] = bounded_text(payload.get('name', current.get('name')), 100, fallback='Workout')
    current['notes'] = bounded_text(payload.get('notes', current.get('notes')), MAX_NOTES)
    current['elapsed_seconds'] = _integer(payload.get('elapsed_seconds', current.get('elapsed_seconds')), 0, 0, 172_800)
    current['status'] = bounded_text(payload.get('status', current.get('status', 'active')), 16)
    if current['status'] not in {'active', 'paused', 'completed', 'discarded'}:
        current['status'] = 'active'
    current['exercises'] = exercises
    current['revision'] = _integer(current.get('revision'), 0, 0, 10_000_000) + 1
    current['updated_at'] = utc_iso(now_ts)
    return current, ''


def progression_for_exercise(exercise: dict, *, phase: str) -> dict:
    completed = [item for item in exercise.get('sets', []) if item.get('completed') and item.get('type') != 'warmup']
    if not completed:
        return {'sets_done': 0, 'min_reps': None, 'last_rpe': None, 'best_load': None, 'next_action': 'Nog invullen', 'suggested_next_kg': None, 'flag': ''}
    target_sets = _integer(exercise.get('target_sets'), len(completed), 1, MAX_SETS)
    min_reps = min(_integer(item.get('reps'), 0, 0, 1000) for item in completed)
    last_rpe = _number(completed[min(len(completed), target_sets) - 1].get('rpe'), 0, 0, 10)
    best_load = max(_number(item.get('kg'), 0, 0, 500) for item in completed)
    rep_min = _integer(exercise.get('rep_min'), 0, 0, 1000)
    rep_max = _integer(exercise.get('rep_max'), rep_min, rep_min, 1000)
    target_last_rpe = _number(exercise.get('last_rpe'), 9, 0, 10)
    if phase == 'Semi-deload':
        action = 'Deload: techniek + herstel'
    elif len(completed) < target_sets:
        action = 'Sets missen'
    elif min_reps >= rep_max and last_rpe >= target_last_rpe - .5 and last_rpe <= 10:
        action = 'Verhoog load volgende keer'
    elif min_reps >= rep_max and last_rpe < target_last_rpe - .5:
        action = 'Verhoog effort/tempo of load'
    elif min_reps < rep_min:
        action = 'Te zwaar: verlaag load of mik op min reps'
    else:
        action = 'Zelfde load: voeg reps toe'
    suggested = next_available_load(best_load, exercise.get('load_type', '')) if action == 'Verhoog load volgende keer' else best_load
    if last_rpe > 10:
        flag = 'Check RPE'
    elif len(completed) >= target_sets and min_reps < rep_min:
        flag = 'Load omlaag'
    elif action == 'Verhoog load volgende keer':
        flag = 'Groen'
    else:
        flag = 'Progressie via reps'
    return {
        'sets_done': len(completed),
        'min_reps': min_reps,
        'last_rpe': last_rpe,
        'best_load': best_load,
        'next_action': action,
        'suggested_next_kg': suggested,
        'flag': flag,
    }


def set_volume(exercise: dict, set_item: dict, bodyweight_kg: float, *, include_warmups=False) -> float:
    if not set_item.get('completed') or (set_item.get('type') == 'warmup' and not include_warmups):
        return 0.0
    reps = _integer(set_item.get('reps'), 0, 0, 1000)
    kg = _number(set_item.get('kg'), 0, 0, 500)
    tracking_type = exercise.get('tracking_type', 'weight_reps')
    bodyweight = _number(bodyweight_kg, 0, 0, 400)
    if tracking_type == 'duration':
        return 0.0
    if tracking_type == 'bodyweight':
        return bodyweight * reps
    if tracking_type == 'weighted_bodyweight' and exercise.get('bodyweight_contributes'):
        return (bodyweight + kg) * reps
    if tracking_type == 'assisted_bodyweight':
        return max(0, bodyweight - kg) * reps
    return kg * _integer(exercise.get('pair_multiplier'), 1, 1, 2) * reps


def epley_1rm(kg: float, reps: int) -> float:
    safe_kg = _number(kg, 0, 0, 500)
    safe_reps = _integer(reps, 0, 0, 1000)
    if safe_reps <= 0:
        return 0.0
    if safe_reps == 1:
        return safe_kg
    return safe_kg * (1 + safe_reps / 30)


def calculate_session(session: dict, *, include_warmups=False) -> dict:
    calculated = deepcopy(session)
    bodyweight = _number(calculated.get('bodyweight_kg'), 0, 0, 400)
    total_volume = 0.0
    completed_sets = 0
    for exercise in calculated.get('exercises', []):
        exercise['progression'] = progression_for_exercise(exercise, phase=calculated.get('phase', ''))
        exercise_volume = 0.0
        for set_item in exercise.get('sets', []):
            if set_item.get('completed') and (include_warmups or set_item.get('type') != 'warmup'):
                completed_sets += 1
            exercise_volume += set_volume(exercise, set_item, bodyweight, include_warmups=include_warmups)
        exercise['volume_kg'] = round(exercise_volume, 2)
        total_volume += exercise_volume
    calculated['completed_sets'] = completed_sets
    calculated['volume_kg'] = round(total_volume, 2)
    return calculated


def previous_values(sessions: list[dict], *, reference: dict | None = None, scope='any_workout') -> dict:
    values = {}
    ordered = sorted((item for item in sessions if item.get('status') == 'completed'), key=lambda item: str(item.get('finished_at', '')), reverse=True)
    if scope == 'same_routine' and reference:
        reference_routine = str(reference.get('routine_id', '') or '')
        reference_day = str(reference.get('day', '') or '')
        if reference_routine:
            ordered = [item for item in ordered if str(item.get('routine_id', '') or '') == reference_routine]
        elif reference_day:
            ordered = [item for item in ordered if str(item.get('day', '') or '') == reference_day]
    for session in ordered:
        for exercise in session.get('exercises', []):
            exercise_id = exercise.get('exercise_id')
            if exercise_id and exercise_id not in values:
                values[exercise_id] = [
                    {'kg': item.get('kg', 0), 'reps': item.get('reps', 0), 'rpe': item.get('rpe', 0), 'type': item.get('type', 'normal')}
                    for item in exercise.get('sets', []) if item.get('completed')
                ]
    return values


def build_statistics(sessions: list[dict], occurrences: list[dict], bodyweight_entries: list[dict], *, include_warmups=False) -> dict:
    completed = [calculate_session(item, include_warmups=include_warmups) for item in sessions if item.get('status') == 'completed']
    completed.sort(key=lambda item: str(item.get('finished_at', '')))
    required_occurrences = [item for item in occurrences if not item.get('optional') and item.get('date', '') <= date.today().isoformat()]
    required_occurrence_ids = {str(item.get('id', '') or '') for item in required_occurrences}
    completed_required = [item for item in completed if str(item.get('occurrence_id', '') or '') in required_occurrence_ids]
    weekly = {}
    exercise_history = {}
    records = {}
    for session in completed:
        week_key = str(session.get('week') or 0)
        bucket = weekly.setdefault(week_key, {'target_sets': 0, 'completed_sets': 0, 'volume_kg': 0, 'duration_seconds': 0, 'muscles': {}})
        bucket['completed_sets'] += session.get('completed_sets', 0)
        bucket['volume_kg'] += session.get('volume_kg', 0)
        bucket['duration_seconds'] += _integer(session.get('elapsed_seconds'), 0, 0, 172_800)
        for exercise in session.get('exercises', []):
            bucket['target_sets'] += _integer(exercise.get('target_sets'), 0, 0, MAX_SETS)
            muscle = exercise.get('muscle_group') or 'Other'
            muscle_sets = sum(1 for item in exercise.get('sets', []) if item.get('completed') and item.get('type') != 'warmup')
            bucket['muscles'][muscle] = bucket['muscles'].get(muscle, 0) + muscle_sets
            completed_sets = [item for item in exercise.get('sets', []) if item.get('completed') and item.get('type') != 'warmup']
            if not completed_sets:
                continue
            exercise_id = exercise.get('exercise_id')
            best_weight = max(_number(item.get('kg'), 0, 0, 500) for item in completed_sets)
            best_reps = max(_integer(item.get('reps'), 0, 0, 1000) for item in completed_sets)
            best_1rm = max(epley_1rm(item.get('kg'), item.get('reps')) for item in completed_sets)
            history = exercise_history.setdefault(exercise_id, [])
            history.append({'date': session.get('date'), 'name': exercise.get('exercise_name'), 'best_weight': best_weight, 'best_reps': best_reps, 'estimated_1rm': round(best_1rm, 2), 'volume_kg': exercise.get('volume_kg', 0)})
            record = records.setdefault(exercise_id, {'name': exercise.get('exercise_name'), 'heaviest_kg': 0, 'most_reps': 0, 'estimated_1rm': 0, 'set_volume_kg': 0, 'duration_seconds': 0})
            record['heaviest_kg'] = max(record['heaviest_kg'], best_weight)
            record['most_reps'] = max(record['most_reps'], best_reps)
            record['estimated_1rm'] = round(max(record['estimated_1rm'], best_1rm), 2)
            record['set_volume_kg'] = round(max(record['set_volume_kg'], max((set_volume(exercise, item, session.get('bodyweight_kg', 0)) for item in completed_sets), default=0)), 2)
            record['duration_seconds'] = max(record['duration_seconds'], max((_integer(item.get('duration_seconds'), 0, 0, 86_400) for item in completed_sets), default=0))
    target_by_week = {}
    for occurrence in occurrences:
        week_key = str(occurrence.get('week') or 0)
        if week_key not in target_by_week:
            target_by_week[week_key] = 0
        if not occurrence.get('optional'):
            target_by_week[week_key] += sum(_integer(item.get('sets'), 0, 0, MAX_SETS) for item in occurrence.get('exercises', []))
    for week_key, target in target_by_week.items():
        weekly.setdefault(week_key, {'target_sets': target, 'completed_sets': 0, 'volume_kg': 0, 'duration_seconds': 0, 'muscles': {}})
        weekly[week_key]['target_sets'] = target
    return {
        'summary': {
            'completed_workouts': len(completed),
            'optional_d_completed': sum(1 for item in completed if item.get('optional')),
            'adherence_percent': round((len(completed_required) / len(required_occurrences) * 100), 1) if required_occurrences else 0,
            'total_volume_kg': round(sum(item.get('volume_kg', 0) for item in completed), 2),
            'total_duration_seconds': sum(_integer(item.get('elapsed_seconds'), 0, 0, 172_800) for item in completed),
        },
        'weekly': weekly,
        'exercise_history': exercise_history,
        'records': records,
        'bodyweight': sorted(bodyweight_entries, key=lambda item: str(item.get('date', ''))),
        'muscle_targets': deepcopy(load_seed()['muscle_targets']),
    }


def routine_share_snapshot(routine: dict, exercise_lookup: dict) -> dict:
    exercises = []
    for item in routine.get('exercises', []):
        exercise = exercise_lookup.get(item.get('exercise_id'), {})
        exercises.append({
            'name': exercise.get('name') or item.get('exercise_name') or item.get('exercise_id'),
            'muscle_group': exercise.get('muscle_group', ''),
            'sets': item.get('sets'),
            'rep_min': item.get('rep_min'),
            'rep_max': item.get('rep_max'),
            'rest_seconds': item.get('rest_seconds'),
            'rest_range': item.get('rest_range'),
            'technique': item.get('technique', ''),
            'cues': item.get('cues', ''),
        })
    return {'kind': 'routine', 'name': routine.get('name', 'Workout routine'), 'focus': routine.get('focus', ''), 'exercises': exercises}


def session_share_snapshot(session: dict) -> dict:
    calculated = calculate_session(session)
    exercises = []
    for exercise in calculated.get('exercises', []):
        exercises.append({
            'name': exercise.get('exercise_name'),
            'muscle_group': exercise.get('muscle_group', ''),
            'sets': [
                {
                    'type': item.get('type'),
                    'kg': item.get('kg'),
                    'reps': item.get('reps'),
                    'rpe': item.get('rpe'),
                    'duration_seconds': item.get('duration_seconds'),
                }
                for item in exercise.get('sets', []) if item.get('completed')
            ],
        })
    return {
        'kind': 'workout',
        'name': calculated.get('name', 'Completed workout'),
        'date': calculated.get('date', ''),
        'duration_seconds': calculated.get('elapsed_seconds', 0),
        'volume_kg': calculated.get('volume_kg', 0),
        'completed_sets': calculated.get('completed_sets', 0),
        'exercises': exercises,
    }
