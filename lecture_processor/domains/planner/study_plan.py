"""Pure validation and deterministic scheduling helpers for Study Plan v2."""

from __future__ import annotations

import math
import re
from datetime import date, datetime, time as datetime_time, timedelta, timezone

try:
    from zoneinfo import ZoneInfo
except Exception:  # pragma: no cover - Python without zoneinfo is unsupported in production
    ZoneInfo = None


ID_RE = re.compile(r'^[A-Za-z0-9_-]{4,120}$')
DATE_RE = re.compile(r'^\d{4}-\d{2}-\d{2}$')
TIME_RE = re.compile(r'^([01]\d|2[0-3]):([0-5]\d)$')
ACTIVE_GOAL_STATUSES = {'active', 'completed', 'archived'}
SESSION_STATUSES = {'planned', 'completed', 'skipped', 'cancelled'}
SESSION_ORIGINS = {'automatic', 'manual', 'legacy'}
DEFAULT_SESSION_MINUTES = 45
DEFAULT_AVAILABILITY = []


def sanitize_id(value):
    safe = str(value or '').strip()
    return safe if ID_RE.match(safe) else ''


def sanitize_date(value):
    safe = str(value or '').strip()
    if not DATE_RE.match(safe):
        return ''
    try:
        date.fromisoformat(safe)
    except ValueError:
        return ''
    return safe


def sanitize_timezone(value):
    safe = str(value or '').strip()[:80]
    if not safe:
        return 'UTC'
    if ZoneInfo is None:
        return safe
    try:
        ZoneInfo(safe)
        return safe
    except Exception:
        return 'UTC'


def _bounded_int(value, default=0, minimum=0, maximum=100000):
    try:
        parsed = int(value)
    except (TypeError, ValueError):
        return default
    return max(minimum, min(maximum, parsed))


def sanitize_availability(value):
    cleaned = []
    seen = set()
    source = value if isinstance(value, list) else DEFAULT_AVAILABILITY
    for raw in source[:28]:
        if not isinstance(raw, dict):
            continue
        weekday = _bounded_int(raw.get('weekday'), default=-1, minimum=-1, maximum=6)
        start = str(raw.get('start', '') or '').strip()
        end = str(raw.get('end', '') or '').strip()
        if weekday < 0 or not TIME_RE.match(start) or not TIME_RE.match(end) or end <= start:
            continue
        key = (weekday, start, end)
        if key in seen:
            continue
        seen.add(key)
        cleaned.append({'weekday': weekday, 'start': start, 'end': end})
    return sorted(cleaned, key=lambda item: (item['weekday'], item['start'], item['end']))


def sanitize_preferences(payload, existing=None):
    source = payload if isinstance(payload, dict) else {}
    current = existing if isinstance(existing, dict) else {}
    availability_source = source.get('availability') if 'availability' in source else current.get('availability', DEFAULT_AVAILABILITY)
    preset = str(source.get('availability_preset', current.get('availability_preset', 'custom')) or 'custom')
    daily_start = str(source.get('daily_start', current.get('daily_start', '17:00')))
    return {
        'timezone': sanitize_timezone(source.get('timezone', current.get('timezone', 'UTC'))),
        'availability': sanitize_availability(availability_source),
        'cadence': 'daily' if source.get('cadence', current.get('cadence')) == 'daily' else 'workload',
        'availability_preset': preset if preset in {'daily', 'balanced', 'weekday-evenings', 'custom'} else 'custom',
        'daily_start': daily_start if TIME_RE.match(daily_start) else '17:00',
        'default_session_minutes': _bounded_int(
            source.get('default_session_minutes', current.get('default_session_minutes', DEFAULT_SESSION_MINUTES)),
            default=DEFAULT_SESSION_MINUTES,
            minimum=15,
            maximum=180,
        ),
        'reminder_offset_minutes': _bounded_int(
            source.get('reminder_offset_minutes', current.get('reminder_offset_minutes', 30)),
            default=30,
            minimum=0,
            maximum=1440,
        ),
    }


def sanitize_pack_ids(value):
    cleaned = []
    seen = set()
    for raw in value if isinstance(value, list) else []:
        safe = sanitize_id(raw)
        if safe and safe not in seen:
            seen.add(safe)
            cleaned.append(safe)
        if len(cleaned) >= 100:
            break
    return cleaned


def sanitize_goal(payload, *, goal_id='', existing=None, now_ts=0.0):
    source = payload if isinstance(payload, dict) else {}
    current = existing if isinstance(existing, dict) else {}
    safe_id = sanitize_id(goal_id or source.get('goal_id') or current.get('goal_id'))
    title = ' '.join(str(source.get('title', current.get('title', '')) or '').split()).strip()[:120]
    exam_date = sanitize_date(source.get('exam_date', current.get('exam_date', '')))
    pack_ids = sanitize_pack_ids(source.get('pack_ids', current.get('pack_ids', [])))
    status = str(source.get('status', current.get('status', 'active')) or '').strip().lower()
    if status not in ACTIVE_GOAL_STATUSES:
        status = 'active'
    if not safe_id:
        return None, 'Goal id is invalid.'
    if not title:
        return None, 'Goal title is required.'
    if not exam_date:
        return None, 'Choose a valid exam date.'
    if not pack_ids:
        return None, 'Select at least one study pack.'
    created_at = float(current.get('created_at', now_ts) or now_ts)
    return {
        'goal_id': safe_id,
        'title': title,
        'exam_date': exam_date,
        'pack_ids': pack_ids,
        'status': status,
        'notes_minutes_by_pack': sanitize_notes_minutes(source.get('notes_minutes_by_pack', current.get('notes_minutes_by_pack', {})), pack_ids),
        'schedule_preferences': sanitize_preferences(source.get('schedule_preferences', current.get('schedule_preferences', {}))) if source.get('schedule_preferences', current.get('schedule_preferences')) else {},
        'revision': _bounded_int(current.get('revision', 0), maximum=1000000000),
        'created_at': created_at,
        'updated_at': float(now_ts or created_at),
    }, ''


def sanitize_notes_minutes(value, pack_ids):
    source = value if isinstance(value, dict) else {}
    allowed = set(pack_ids or [])
    return {
        pack_id: _bounded_int(source.get(pack_id), default=45, minimum=15, maximum=5000)
        for pack_id in allowed
        if pack_id in source
    }


def normalize_session(payload, *, existing=None, now_ts=0.0):
    source = payload if isinstance(payload, dict) else {}
    current = existing if isinstance(existing, dict) else {}
    safe_id = sanitize_id(source.get('id', current.get('id', '')))
    if not safe_id:
        return None, 'Session id is invalid.'
    session_date = sanitize_date(source.get('date', current.get('date', '')))
    start_time = str(source.get('time', current.get('time', '19:00')) or '').strip()
    if not TIME_RE.match(start_time):
        return None, 'Session time must use HH:MM.'
    if not session_date:
        return None, 'Session date must use YYYY-MM-DD.'
    duration = _bounded_int(source.get('duration', current.get('duration', DEFAULT_SESSION_MINUTES)), default=DEFAULT_SESSION_MINUTES, minimum=5, maximum=360)
    status = str(source.get('status', current.get('status', 'planned')) or '').strip().lower()
    if status not in SESSION_STATUSES:
        status = 'planned'
    origin = str(source.get('origin', current.get('origin', 'manual')) or '').strip().lower()
    if origin not in SESSION_ORIGINS:
        origin = 'legacy'
    planned = source.get('planned_outcomes', current.get('planned_outcomes', {}))
    planned = planned if isinstance(planned, dict) else {}
    return {
        'id': safe_id,
        'title': ' '.join(str(source.get('title', current.get('title', 'Study session')) or '').split()).strip()[:160] or 'Study session',
        'date': session_date,
        'time': start_time,
        'duration': duration,
        'notes': str(source.get('notes', current.get('notes', '')) or '').strip()[:2000],
        'goal_id': sanitize_id(source.get('goal_id', current.get('goal_id', ''))),
        'pack_id': sanitize_id(source.get('pack_id', current.get('pack_id', ''))),
        'pack_title': ' '.join(str(source.get('pack_title', current.get('pack_title', '')) or '').split()).strip()[:160],
        'planned_outcomes': {
            'flashcards': _bounded_int(planned.get('flashcards'), maximum=5000),
            'questions': _bounded_int(planned.get('questions'), maximum=5000),
            'notes_minutes': _bounded_int(planned.get('notes_minutes'), maximum=5000),
        },
        'origin': origin,
        'locked': bool(source.get('locked', current.get('locked', origin in {'legacy', 'manual'}))),
        'status': status,
        'proposal_id': sanitize_id(source.get('proposal_id', current.get('proposal_id', ''))),
        'revision': _bounded_int(current.get('revision', 0), maximum=1000000000),
        'created_at': float(current.get('created_at', now_ts) or now_ts),
        'updated_at': float(now_ts or current.get('updated_at', 0) or 0),
    }, ''


def estimate_personal_pace(activities):
    """Return stable minute estimates after enough recent, outcome-bearing sessions."""
    source = activities if isinstance(activities, list) else []
    useful = []
    for raw in source[:100]:
        item = raw if isinstance(raw, dict) else {}
        metrics = activity_metrics(item.get('metrics', item))
        weighted_outcomes = metrics['cards_reviewed'] + (metrics['questions_answered'] * 2)
        if metrics['minutes'] > 0 and weighted_outcomes > 0:
            useful.append((metrics['minutes'], weighted_outcomes))
    total_minutes = sum(item[0] for item in useful)
    total_weighted = sum(item[1] for item in useful)
    if len(useful) < 3 or total_weighted < 20:
        return {'card_minutes': 1.0, 'question_minutes': 2.0, 'personalized': False}
    factor = max(0.35, min(3.0, total_minutes / total_weighted))
    return {
        'card_minutes': round(factor, 2),
        'question_minutes': round(factor * 2, 2),
        'personalized': True,
    }


def build_pack_workload(
    pack,
    state=None,
    notes_minutes=45,
    today='',
    card_minutes=1.0,
    question_minutes=2.0,
    completed_notes_minutes=0,
):
    safe_pack = pack if isinstance(pack, dict) else {}
    state_map = state if isinstance(state, dict) else {}
    flashcards_total = _bounded_int(safe_pack.get('flashcards_count', len(safe_pack.get('flashcards', []) if isinstance(safe_pack.get('flashcards'), list) else [])), maximum=5000)
    questions_total = _bounded_int(safe_pack.get('test_questions_count', len(safe_pack.get('test_questions', []) if isinstance(safe_pack.get('test_questions'), list) else [])), maximum=5000)
    mastered_cards = 0
    mastered_questions = 0
    due_cards = 0
    retry_questions = 0
    seen_cards = 0
    answered_questions = 0
    for card_id, raw in state_map.items():
        entry = raw if isinstance(raw, dict) else {}
        correct = _bounded_int(entry.get('correct'), maximum=100000)
        wrong = _bounded_int(entry.get('wrong'), maximum=100000)
        level = _bounded_int(entry.get('level'), maximum=100)
        if str(card_id).startswith('fc_'):
            if correct or wrong or entry.get('seen') or entry.get('flip_count'):
                seen_cards += 1
            if level >= 3 or (correct >= 3 and correct > wrong):
                mastered_cards += 1
            if (correct or wrong or entry.get('seen')) and str(entry.get('next_review_date', '') or '') <= str(today or ''):
                due_cards += 1
        elif str(card_id).startswith('q_'):
            if correct or wrong or entry.get('seen'):
                answered_questions += 1
            if correct >= 2 and correct > wrong:
                mastered_questions += 1
            if wrong >= correct and (correct or wrong):
                retry_questions += 1
    due_cards = min(flashcards_total, due_cards)
    retry_questions = min(questions_total, retry_questions)
    cards_remaining = max(due_cards, flashcards_total - min(flashcards_total, mastered_cards))
    questions_remaining = max(retry_questions, questions_total - min(questions_total, mastered_questions))
    note_minutes = 0
    if cards_remaining == 0 and questions_remaining == 0:
        note_minutes = max(
            0,
            _bounded_int(notes_minutes, default=45, minimum=15, maximum=5000)
            - _bounded_int(completed_notes_minutes, maximum=5000),
        )
    card_pace = max(0.25, min(5.0, float(card_minutes or 1.0)))
    question_pace = max(0.5, min(10.0, float(question_minutes or 2.0)))
    total_minutes = int(math.ceil((cards_remaining * card_pace + questions_remaining * question_pace + note_minutes) * 1.15))
    return {
        'pack_id': str(safe_pack.get('study_pack_id', safe_pack.get('pack_id', '')) or ''),
        'title': str(safe_pack.get('title', '') or 'Untitled pack'),
        'flashcards_total': flashcards_total,
        'questions_total': questions_total,
        'mastered_cards': min(flashcards_total, mastered_cards),
        'mastered_questions': min(questions_total, mastered_questions),
        'due_cards': due_cards,
        'retry_questions': retry_questions,
        'unseen_cards': max(0, flashcards_total - min(flashcards_total, seen_cards)),
        'unanswered_questions': max(0, questions_total - min(questions_total, answered_questions)),
        'unmastered_cards': max(0, flashcards_total - min(flashcards_total, mastered_cards)),
        'unmastered_questions': max(0, questions_total - min(questions_total, mastered_questions)),
        'cards_remaining': cards_remaining,
        'questions_remaining': questions_remaining,
        'notes_minutes': note_minutes,
        'card_minutes_per_item': card_pace,
        'question_minutes_per_item': question_pace,
        'total_minutes': max(0, total_minutes),
    }


def _parse_local_datetime(day_value, clock_value, timezone_name):
    zone = ZoneInfo(timezone_name) if ZoneInfo is not None else timezone.utc
    hour, minute = [int(part) for part in clock_value.split(':', 1)]
    return datetime.combine(day_value, datetime_time(hour=hour, minute=minute), tzinfo=zone)


def _session_start_utc(item, fallback_timezone):
    try:
        instant = datetime.fromisoformat(str(item.get('starts_at_utc', '')).replace('Z', '+00:00'))
        if instant.tzinfo is not None:
            return instant.astimezone(timezone.utc)
    except (ValueError, TypeError):
        pass
    return _parse_local_datetime(date.fromisoformat(item['date']), item['time'], sanitize_timezone(item.get('timezone') or fallback_timezone)).astimezone(timezone.utc)


def build_available_slots(*, start_date, exam_date, preferences, occupied=None, max_sessions=50000, now=None):
    start_day = date.fromisoformat(sanitize_date(start_date))
    exam_day = date.fromisoformat(sanitize_date(exam_date))
    safe_preferences = sanitize_preferences(preferences)
    duration = safe_preferences['default_session_minutes']
    timezone_name = safe_preferences['timezone']
    if now is not None and (now.tzinfo is None or now.utcoffset() is None):
        raise ValueError('The scheduling cutoff must include a timezone.')
    cutoff = now.astimezone(timezone.utc) if now is not None else None
    occupied_ranges = []
    for item in occupied if isinstance(occupied, list) else []:
        if str(item.get('status', 'planned')) in {'cancelled', 'skipped'} and item.get('cancellation_reason') != 'user_removed':
            continue
        item_date = sanitize_date(item.get('date'))
        item_time = str(item.get('time', '') or '')
        if not item_date or not TIME_RE.match(item_time):
            continue
        start = _session_start_utc(item, timezone_name)
        occupied_ranges.append((start, start + timedelta(minutes=_bounded_int(item.get('duration'), default=duration, minimum=5, maximum=360))))
    slots = []
    day_cursor = start_day
    final_day = min(exam_day - timedelta(days=1), start_day + timedelta(days=365))
    availability = safe_preferences['availability']
    while day_cursor <= final_day and len(slots) < max_sessions:
        for window in [item for item in availability if item['weekday'] == day_cursor.weekday()]:
            cursor = _parse_local_datetime(day_cursor, window['start'], timezone_name)
            window_end = _parse_local_datetime(day_cursor, window['end'], timezone_name)
            while cursor + timedelta(minutes=duration) <= window_end and len(slots) < max_sessions:
                slot_end = cursor + timedelta(minutes=duration)
                is_future = cutoff is None or cursor.astimezone(timezone.utc) >= cutoff
                if is_future and not any(cursor.astimezone(timezone.utc) < occupied_end and slot_end.astimezone(timezone.utc) > occupied_start for occupied_start, occupied_end in occupied_ranges):
                    slots.append({
                        'date': day_cursor.isoformat(),
                        'time': cursor.strftime('%H:%M'),
                        'starts_at_utc': cursor.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z'),
                        'duration': duration,
                        'timezone': timezone_name,
                    })
                    occupied_ranges.append((cursor.astimezone(timezone.utc), slot_end.astimezone(timezone.utc)))
                cursor = slot_end + timedelta(minutes=15)
        day_cursor += timedelta(days=1)
    return slots


def _workload_minutes(workload):
    minutes = (workload['cards_remaining'] * workload['card_minutes_per_item']
               + workload['questions_remaining'] * workload['question_minutes_per_item']
               + workload['notes_minutes'])
    return max(0, int(math.ceil(minutes * 1.15 - 1e-9)))


def _allocate_outcomes(workload, duration):
    """Consume only whole items that fit, keeping unassigned remainders alive."""
    remaining = duration / 1.15
    cards = min(workload['cards_remaining'], int((remaining + 1e-9) / workload['card_minutes_per_item']))
    remaining -= cards * workload['card_minutes_per_item']
    questions = min(workload['questions_remaining'], int((remaining + 1e-9) / workload['question_minutes_per_item']))
    remaining -= questions * workload['question_minutes_per_item']
    notes_minutes = min(workload['notes_minutes'], max(0, int(remaining + 1e-9)))
    workload['cards_remaining'] -= cards
    workload['questions_remaining'] -= questions
    workload['notes_minutes'] -= notes_minutes
    minutes = cards * workload['card_minutes_per_item'] + questions * workload['question_minutes_per_item'] + notes_minutes
    return {'flashcards': cards, 'questions': questions, 'notes_minutes': notes_minutes}, max(5, int(math.ceil(minutes * 1.15 - 1e-9)))


def _daily_schedule(*, goal, workloads, preferences, start_date, occupied, proposal_id, now, required_minutes):
    """Daily commitments keep their wall-clock time and duration, including revision."""
    safe = sanitize_preferences(preferences)
    duration = safe['default_session_minutes']
    start_minutes = int(safe['daily_start'][:2]) * 60 + int(safe['daily_start'][3:])
    if start_minutes + duration >= 24 * 60:
        raise ValueError('Choose a start time that leaves room for the full session before midnight.')
    end_minutes = start_minutes + duration
    safe['availability'] = [{'weekday': day, 'start': safe['daily_start'], 'end': f'{end_minutes // 60:02d}:{end_minutes % 60:02d}'} for day in range(7)]
    candidates = build_available_slots(start_date=start_date, exam_date=goal['exam_date'], preferences=safe, now=now)
    same_goal = [item for item in occupied if item.get('goal_id') == goal.get('goal_id')]
    retained = [item for item in same_goal if item.get('status', 'planned') in {'planned', 'completed', 'skipped'}]
    covered_dates = {item['date'] for item in retained}
    excluded_dates = {item['date'] for item in same_goal if item.get('status') == 'cancelled' and item.get('cancellation_reason') == 'user_removed'}
    conflicts = []
    scheduled = []
    rotation = 0
    for slot in candidates:
        if slot['date'] in covered_dates or slot['date'] in excluded_dates:
            continue
        start = datetime.fromisoformat(slot['starts_at_utc'].replace('Z', '+00:00'))
        end = start + timedelta(minutes=duration)
        if ZoneInfo is not None and start.astimezone(ZoneInfo(safe['timezone'])).strftime('%H:%M') != slot['time']:
            conflicts.append({'date': slot['date'], 'time': slot['time'], 'session_ids': [], 'reason': 'daylight_saving_time'})
            continue
        collision = []
        for item in occupied:
            if item.get('status', 'planned') in {'cancelled', 'skipped'}:
                continue
            other_start = _session_start_utc(item, safe['timezone'])
            if start < other_start + timedelta(minutes=int(item.get('duration', duration))) and end > other_start:
                collision.append(item.get('id', ''))
        if collision:
            conflicts.append({'date': slot['date'], 'time': slot['time'], 'session_ids': collision})
            continue
        available = [item for item in workloads if _workload_minutes(item) > 0]
        pool = available or workloads
        if not pool:
            continue
        workload = pool[rotation % len(pool)]
        rotation += 1
        if available:
            outcomes, coverage = _allocate_outcomes(workload, duration)
            coverage = min(duration, coverage) if any(outcomes.values()) else 0
        else:
            outcomes, coverage = {'flashcards': 0, 'questions': 0, 'notes_minutes': 0}, 0
        revision_minutes = max(0, duration - coverage)
        intent = 'review' if not coverage else 'mixed' if revision_minutes else 'study'
        scheduled.append({
            **slot, 'duration': duration,
            'id': f"sp_{proposal_id}_{len(scheduled) + 1:03d}",
            'title': f"{'Review' if intent == 'review' else 'Study'} {workload.get('title', 'study pack')}",
            'goal_id': goal.get('goal_id', ''), 'pack_id': workload.get('pack_id', ''),
            'pack_title': workload.get('title', ''), 'planned_outcomes': outcomes,
            'coverage_minutes': coverage, 'revision_minutes': revision_minutes, 'study_intent': intent,
            'origin': 'automatic', 'locked': False, 'status': 'planned', 'proposal_id': proposal_id,
        })
    return {
        'sessions': scheduled, 'required_minutes': required_minutes,
        'scheduled_minutes': sum(item['duration'] for item in scheduled),
        'shortage_minutes': sum(_workload_minutes(item) for item in workloads),
        'capacity_minutes': len(candidates) * duration,
        'retained_sessions': retained, 'conflicts': conflicts, 'excluded_dates': sorted(excluded_dates),
    }


def generate_schedule(*, goal, pack_workloads, preferences, start_date, occupied=None, proposal_id='', now=None):
    safe_goal = goal if isinstance(goal, dict) else {}
    slots = build_available_slots(
        start_date=start_date,
        exam_date=safe_goal.get('exam_date', ''),
        preferences=preferences,
        occupied=[item for item in (occupied or []) if item.get('cancellation_reason') != 'user_removed' or item.get('goal_id') == safe_goal.get('goal_id')],
        now=now,
    )
    queue = []
    for workload in pack_workloads if isinstance(pack_workloads, list) else []:
        item = dict(workload)
        item['cards_remaining'] = _bounded_int(item.get('cards_remaining'))
        item['questions_remaining'] = _bounded_int(item.get('questions_remaining'))
        item['notes_minutes'] = _bounded_int(item.get('notes_minutes'))
        item['card_minutes_per_item'] = max(0.25, min(5.0, float(item.get('card_minutes_per_item', 1.0) or 1.0)))
        item['question_minutes_per_item'] = max(0.5, min(10.0, float(item.get('question_minutes_per_item', 2.0) or 2.0)))
        if _workload_minutes(item) > 0 or sanitize_preferences(preferences)['cadence'] == 'daily':
            queue.append(item)
    queue.sort(key=lambda item: (
        -_bounded_int(item.get('due_cards')),
        -_bounded_int(item.get('retry_questions')),
        -_bounded_int(item.get('unseen_cards')),
        -_bounded_int(item.get('unanswered_questions')),
        str(item.get('title', '')).lower(),
    ))
    total_required = sum(_workload_minutes(item) for item in queue)
    # A locked/manual commitment already covers its targets; don't assign them again.
    for session in occupied or []:
        if session.get('goal_id') != safe_goal.get('goal_id') or session.get('status', 'planned') != 'planned':
            continue
        for workload in queue:
            if workload.get('pack_id') == session.get('pack_id'):
                outcomes = session.get('planned_outcomes') or {}
                for remaining, outcome in [('cards_remaining', 'flashcards'), ('questions_remaining', 'questions'), ('notes_minutes', 'notes_minutes')]:
                    workload[remaining] = max(0, workload[remaining] - _bounded_int(outcomes.get(outcome)))
    if sanitize_preferences(preferences)['cadence'] == 'daily':
        return _daily_schedule(goal=safe_goal, workloads=queue, preferences=preferences, start_date=start_date,
                               occupied=occupied or [], proposal_id=proposal_id, now=now, required_minutes=total_required)
    default_duration = sanitize_preferences(preferences)['default_session_minutes']
    # Build one-pack sessions before spacing them over the calendar. Counting
    # combined minutes undercounts small packs and loses rounded item remainders.
    active = [item for item in queue if _workload_minutes(item) > 0]
    allocations = []
    while active and len(allocations) < min(200, len(slots)):
        workload = active.pop(0)
        outcomes, duration = _allocate_outcomes(workload, default_duration)
        if any(outcomes.values()):
            allocations.append((workload, outcomes, duration))
        if _workload_minutes(workload) > 0:
            active.append(workload)
    needed_slots = len(allocations)
    selected_slots = slots
    if 0 < needed_slots < len(slots):
        if needed_slots == 1:
            selected_slots = [slots[0]]
        else:
            last_index = len(slots) - 1
            indices = [round(index * last_index / (needed_slots - 1)) for index in range(needed_slots)]
            selected_slots = [slots[index] for index in indices]
    scheduled = []
    for index, (slot, allocation) in enumerate(zip(selected_slots, allocations)):
        workload, outcomes, duration = allocation
        scheduled.append({
            **slot,
            'duration': duration,
            'id': f"sp_{proposal_id}_{index + 1:03d}",
            'title': f"Study {workload.get('title', 'study pack')}",
            'goal_id': safe_goal.get('goal_id', ''),
            'pack_id': workload.get('pack_id', ''),
            'pack_title': workload.get('title', ''),
            'planned_outcomes': outcomes,
            'origin': 'automatic',
            'locked': False,
            'status': 'planned',
            'proposal_id': proposal_id,
        })
    return {
        'sessions': scheduled,
        'required_minutes': total_required,
        'scheduled_minutes': sum(item['duration'] for item in scheduled),
        'shortage_minutes': sum(_workload_minutes(item) for item in queue),
        'capacity_minutes': sum(item['duration'] for item in slots),
    }


def activity_metrics(payload):
    source = payload if isinstance(payload, dict) else {}
    return {
        'minutes': _bounded_int(source.get('minutes'), maximum=1440),
        'cards_reviewed': _bounded_int(source.get('cards_reviewed'), maximum=100000),
        'questions_answered': _bounded_int(source.get('questions_answered'), maximum=100000),
        'correct': _bounded_int(source.get('correct'), maximum=100000),
        'incorrect': _bounded_int(source.get('incorrect'), maximum=100000),
    }
