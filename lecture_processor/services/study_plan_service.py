"""Unified Study Plan APIs, scheduling, progress aggregation, and calendar feeds."""

from __future__ import annotations

import hashlib
import hmac
import math
import secrets
from datetime import date, datetime, timedelta, timezone

from flask import Response

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.planner import models as legacy_models
from lecture_processor.domains.planner import study_plan
from lecture_processor.domains.study import progress as study_progress
from lecture_processor.services import access_service


PROPOSAL_TTL_SECONDS = 15 * 60
MAX_BOOTSTRAP_DAYS = 120
MAX_CALENDAR_FEEDS = 5


def _require_user(app_ctx, request):
    return access_service.require_allowed_user(app_ctx, request)


def _write_guard(app_ctx, uid):
    allowed, message = account_lifecycle.ensure_account_allows_writes(uid, runtime=app_ctx)
    if allowed:
        return None
    return app_ctx.jsonify({'error': message, 'status': 'account_deletion_in_progress'}), 409


def _new_id(prefix):
    return f"{prefix}_{secrets.token_urlsafe(12).replace('-', '_')[:18]}"


def _today_for_timezone(timezone_name):
    safe_timezone = study_plan.sanitize_timezone(timezone_name)
    try:
        from zoneinfo import ZoneInfo
        return datetime.now(ZoneInfo(safe_timezone)).date().isoformat()
    except Exception:
        return datetime.now(timezone.utc).date().isoformat()


def _starts_at_utc(date_value, time_value, timezone_name):
    try:
        from zoneinfo import ZoneInfo
        local = datetime.fromisoformat(f'{date_value}T{time_value}:00').replace(tzinfo=ZoneInfo(timezone_name))
        return local.astimezone(timezone.utc).isoformat().replace('+00:00', 'Z')
    except Exception:
        return ''


def _preferences(app_ctx, uid):
    snapshot = app_ctx.planner_repo.get_study_plan_preferences(app_ctx.db, uid)
    raw = snapshot.to_dict() if snapshot.exists else {}
    if not raw.get('timezone'):
        try:
            progress_doc = app_ctx.get_study_progress_doc(uid).get()
            progress_data = progress_doc.to_dict() if progress_doc.exists else {}
            raw['timezone'] = study_progress.sanitize_timezone_name(progress_data.get('timezone'), runtime=app_ctx) or 'UTC'
        except Exception:
            raw['timezone'] = 'UTC'
    safe = study_plan.sanitize_preferences(raw)
    safe_revision = _safe_revision(raw.get('revision', 0))
    safe['revision'] = safe_revision if safe_revision >= 0 else 0
    safe['migration_v1_complete'] = bool(raw.get('migration_v1_complete', False))
    safe['availability_configured'] = bool(raw.get('availability_configured', False))
    safe['updated_at'] = _safe_float(raw.get('updated_at', 0))
    return safe


def _serialize_goal(raw):
    source = raw if isinstance(raw, dict) else {}
    revision = _safe_revision(source.get('revision', 0))
    return {
        'goal_id': str(source.get('goal_id', '') or ''),
        'title': str(source.get('title', '') or ''),
        'exam_date': str(source.get('exam_date', '') or ''),
        'pack_ids': list(source.get('pack_ids', []) if isinstance(source.get('pack_ids'), list) else []),
        'notes_minutes_by_pack': dict(source.get('notes_minutes_by_pack', {}) if isinstance(source.get('notes_minutes_by_pack'), dict) else {}),
        'status': str(source.get('status', 'active') or 'active'),
        'revision': revision if revision >= 0 else 0,
        'created_at': _safe_float(source.get('created_at', 0)),
        'updated_at': _safe_float(source.get('updated_at', 0)),
        'migrated_from_folder_id': str(source.get('migrated_from_folder_id', '') or ''),
    }


def _pack_summary(raw, doc_id=''):
    source = raw if isinstance(raw, dict) else {}
    return {
        'study_pack_id': str(doc_id or source.get('study_pack_id', '')),
        'title': str(source.get('title', '') or 'Untitled pack'),
        'mode': str(source.get('mode', '') or ''),
        'flashcards_count': int(source.get('flashcards_count', len(source.get('flashcards', []) if isinstance(source.get('flashcards'), list) else [])) or 0),
        'test_questions_count': int(source.get('test_questions_count', len(source.get('test_questions', []) if isinstance(source.get('test_questions'), list) else [])) or 0),
        'folder_id': str(source.get('folder_id', '') or ''),
        'folder_name': str(source.get('folder_name', '') or ''),
        'course': str(source.get('course', '') or ''),
        'subject': str(source.get('subject', '') or ''),
        'archived': bool(source.get('archived', False)),
    }


def _pack_summary_page(app_ctx, uid, limit=100, after_doc=None):
    safe_limit = min(100, max(1, int(limit or 100)))
    docs = app_ctx.study_repo.list_study_pack_summaries_by_uid(app_ctx.db, uid, safe_limit + 1, after_doc=after_doc)
    has_more = len(docs) > safe_limit
    page_docs = docs[:safe_limit]
    packs = []
    for doc in page_docs:
        raw = doc.to_dict() or {}
        summary = _pack_summary(raw, getattr(doc, 'id', ''))
        if not summary['archived'] and summary['mode'].strip().lower() != 'voice-note':
            packs.append(summary)
    next_cursor = str(getattr(page_docs[-1], 'id', '') or '') if has_more and page_docs else ''
    return packs, next_cursor


def _pack_summaries(app_ctx, uid, limit=100):
    return _pack_summary_page(app_ctx, uid, limit)[0]


def _pack_states(app_ctx, uid, pack_ids):
    states = {}
    for pack_id in pack_ids:
        try:
            doc = app_ctx.get_study_card_state_doc(uid, pack_id).get()
            raw = doc.to_dict() if doc.exists else {}
            states[pack_id] = study_progress.sanitize_card_state_map((raw or {}).get('state', {}), runtime=app_ctx)
        except Exception:
            states[pack_id] = {}
    return states


def _recent_activity_context(app_ctx, uid):
    activities = app_ctx.planner_repo.list_study_activity_by_uid(
        app_ctx.db,
        uid,
        100,
        start_ts=app_ctx.time.time() - (90 * 24 * 60 * 60),
    )
    notes_minutes_by_pack = {}
    for activity in activities:
        mode = str(activity.get('mode', '') or '').strip().lower()
        if mode not in {'notes', 'read', 'reading'}:
            continue
        pack_id = str(activity.get('pack_id', '') or '')
        if pack_id:
            notes_minutes_by_pack[pack_id] = notes_minutes_by_pack.get(pack_id, 0) + study_plan.activity_metrics(activity.get('metrics', {}))['minutes']
    return study_plan.estimate_personal_pace(activities), notes_minutes_by_pack


def _safe_revision(value):
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return -1


def _safe_float(value, default=0.0):
    try:
        parsed = float(value or 0)
    except (TypeError, ValueError):
        return float(default)
    return parsed if math.isfinite(parsed) else float(default)


def _owned_pack_ids(app_ctx, uid, pack_ids):
    owned = set()
    for pack_id in study_plan.sanitize_pack_ids(pack_ids):
        doc = app_ctx.study_repo.get_study_pack_summary_doc(app_ctx.db, pack_id)
        raw = doc.to_dict() if getattr(doc, 'exists', False) else {}
        if (
            getattr(doc, 'exists', False)
            and str(raw.get('uid', '') or '') == uid
            and str(raw.get('mode', '') or '').strip().lower() != 'voice-note'
            and not bool(raw.get('archived', False))
        ):
            owned.add(pack_id)
    return owned


def _owned_pack_summaries(app_ctx, uid, pack_ids):
    summaries = {}
    for pack_id in study_plan.sanitize_pack_ids(pack_ids):
        doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
        raw = doc.to_dict() if getattr(doc, 'exists', False) else {}
        if not getattr(doc, 'exists', False) or str(raw.get('uid', '') or '') != uid:
            continue
        summary = _pack_summary(raw, pack_id)
        if summary['archived'] or summary['mode'].strip().lower() == 'voice-note':
            continue
        summaries[pack_id] = summary
    return summaries


def _migrate_legacy_folder_goals(app_ctx, uid, preferences):
    if preferences.get('migration_v1_complete'):
        return preferences
    existing = app_ctx.planner_repo.list_study_goals_by_uid(app_ctx.db, uid, 200)
    migrated_folder_ids = {str(item.get('migrated_from_folder_id', '') or '') for item in existing}
    packs = _pack_summaries(app_ctx, uid, 100)
    packs_by_folder = {}
    for pack in packs:
        folder_id = pack.get('folder_id')
        if folder_id:
            packs_by_folder.setdefault(folder_id, []).append(pack['study_pack_id'])
    try:
        folders = app_ctx.study_repo.list_study_folders_by_uid(app_ctx.db, uid)
    except Exception:
        folders = []
    now_ts = app_ctx.time.time()
    for doc in folders:
        raw = doc.to_dict() or {}
        exam_date = study_plan.sanitize_date(raw.get('exam_date'))
        pack_ids = packs_by_folder.get(str(getattr(doc, 'id', '') or ''), [])
        folder_id = str(getattr(doc, 'id', '') or '')
        if not exam_date or not pack_ids or folder_id in migrated_folder_ids:
            continue
        goal_id = 'goal_migrated_' + hashlib.sha256(f'{uid}:{folder_id}'.encode('utf-8')).hexdigest()[:16]
        payload, error = study_plan.sanitize_goal({
            'goal_id': goal_id,
            'title': raw.get('name', 'Study goal'),
            'exam_date': exam_date,
            'pack_ids': pack_ids,
        }, goal_id=goal_id, now_ts=now_ts)
        if payload is None or error:
            continue
        payload.update({'uid': uid, 'revision': 1, 'migrated_from_folder_id': folder_id})
        app_ctx.planner_repo.set_study_goal(app_ctx.db, uid, goal_id, payload, merge=False)
    updated = dict(preferences)
    updated['migration_v1_complete'] = True
    updated['availability_configured'] = bool(preferences.get('availability_configured', False))
    updated['revision'] = max(1, int(updated.get('revision', 0) or 0))
    updated['updated_at'] = now_ts
    app_ctx.planner_repo.set_study_plan_preferences(app_ctx.db, uid, updated, merge=False)
    return updated


def _session_records(app_ctx, uid, start_date='', end_date='', limit=400):
    records = app_ctx.planner_repo.list_planner_sessions_by_uid(
        app_ctx.db,
        uid,
        min(400, max(1, int(limit or 400))),
        start_date=start_date or None,
    )
    sessions = []
    for raw in records:
        safe, error = legacy_models.sanitize_session_payload(
            raw,
            session_id=raw.get('id', ''),
            existing=raw,
            now_ts=float(raw.get('updated_at', 0) or app_ctx.time.time()),
            runtime=app_ctx,
        )
        if safe is None or error:
            continue
        if start_date and safe['date'] < start_date:
            continue
        if end_date and safe['date'] > end_date:
            continue
        sessions.append(safe)
    return legacy_models.sort_sessions(sessions, runtime=app_ctx)


def _activity_summary(app_ctx, uid, start_ts, sessions, goals, workloads_by_pack, goal_workloads=None, period_start_date='', period_end_date=''):
    activities = app_ctx.planner_repo.list_study_activity_by_uid(app_ctx.db, uid, 500, start_ts=start_ts)
    metrics = {'minutes': 0, 'cards_reviewed': 0, 'questions_answered': 0, 'correct': 0, 'incorrect': 0}
    for item in activities:
        cleaned = study_plan.activity_metrics(item.get('metrics', {}))
        for key in metrics:
            metrics[key] += cleaned[key]
    period_sessions = [
        item for item in sessions
        if (not period_start_date or item.get('date', '') >= period_start_date)
        and (not period_end_date or item.get('date', '') <= period_end_date)
    ]
    planned_minutes = sum(int(item.get('duration', 0) or 0) for item in period_sessions if item.get('status') != 'cancelled')
    completed_minutes = sum(int(item.get('duration', 0) or 0) for item in period_sessions if item.get('status') == 'completed')
    total_answers = metrics['correct'] + metrics['incorrect']
    per_goal = []
    for goal in goals:
        pack_ids = goal.get('pack_ids', [])
        goal_pack_workloads = (goal_workloads or {}).get(goal.get('goal_id'), workloads_by_pack)
        remaining = sum(int((goal_pack_workloads.get(pack_id) or {}).get('total_minutes', 0) or 0) for pack_id in pack_ids)
        scheduled_future = sum(
            int(item.get('duration', 0) or 0)
            for item in sessions
            if item.get('goal_id') == goal.get('goal_id') and item.get('status') == 'planned'
        )
        total_outcomes = sum(
            int((goal_pack_workloads.get(pack_id) or {}).get('flashcards_total', 0) or 0)
            + int((goal_pack_workloads.get(pack_id) or {}).get('questions_total', 0) or 0)
            for pack_id in pack_ids
        )
        mastered_outcomes = sum(
            int((goal_pack_workloads.get(pack_id) or {}).get('mastered_cards', 0) or 0)
            + int((goal_pack_workloads.get(pack_id) or {}).get('mastered_questions', 0) or 0)
            for pack_id in pack_ids
        )
        mastery_percent = round((mastered_outcomes / total_outcomes) * 100) if total_outcomes else 0
        coverage_percent = min(100, round((scheduled_future / remaining) * 100)) if remaining else 100
        per_goal.append({
            'goal_id': goal.get('goal_id'),
            'title': goal.get('title'),
            'exam_date': goal.get('exam_date'),
            'remaining_minutes': remaining,
            'scheduled_minutes': scheduled_future,
            'on_track': scheduled_future >= remaining if remaining else True,
            'needs_rebalance': abs(scheduled_future - remaining) >= 45,
            'mastery_percent': mastery_percent,
            'readiness_percent': round((mastery_percent + coverage_percent) / 2) if total_outcomes else coverage_percent,
        })
    try:
        progress_doc = app_ctx.get_study_progress_doc(uid).get()
        progress_data = progress_doc.to_dict() if progress_doc.exists else {}
        card_docs = app_ctx.study_repo.list_study_card_states_by_uid(app_ctx.db, uid, app_ctx.MAX_PROGRESS_PACKS_PER_SYNC)
        card_maps = [study_progress.sanitize_card_state_map((doc.to_dict() or {}).get('state', {}), runtime=app_ctx) for doc in card_docs]
        legacy_summary = study_progress.compute_study_progress_summary(progress_data, card_maps, runtime=app_ctx)
    except Exception:
        legacy_summary = {'current_streak': 0, 'due_today': 0}
    global_outcomes = sum(int(item.get('flashcards_total', 0) or 0) + int(item.get('questions_total', 0) or 0) for item in workloads_by_pack.values())
    global_mastered = sum(int(item.get('mastered_cards', 0) or 0) + int(item.get('mastered_questions', 0) or 0) for item in workloads_by_pack.values())
    return {
        **metrics,
        'planned_minutes': planned_minutes,
        'completed_minutes': completed_minutes,
        'accuracy_percent': round((metrics['correct'] / total_answers) * 100) if total_answers else 0,
        'current_streak': int(legacy_summary.get('current_streak', 0) or 0),
        'due_cards': int(legacy_summary.get('due_today', 0) or 0),
        'mastery_percent': round((global_mastered / global_outcomes) * 100) if global_outcomes else 0,
        'goals': per_goal,
    }


def _date_bounds(request, timezone_name):
    today = _today_for_timezone(timezone_name)
    start_value = study_plan.sanitize_date(request.args.get('from')) or today
    end_value = study_plan.sanitize_date(request.args.get('to')) or (date.fromisoformat(start_value) + timedelta(days=42)).isoformat()
    start_day = date.fromisoformat(start_value)
    end_day = date.fromisoformat(end_value)
    if end_day < start_day:
        end_day = start_day
    if (end_day - start_day).days > MAX_BOOTSTRAP_DAYS:
        end_day = start_day + timedelta(days=MAX_BOOTSTRAP_DAYS)
    return start_day.isoformat(), end_day.isoformat()


def _local_day_start_timestamp(day_value, timezone_name):
    try:
        from zoneinfo import ZoneInfo
        return datetime.combine(day_value, datetime.min.time(), tzinfo=ZoneInfo(timezone_name)).timestamp()
    except Exception:
        return datetime.combine(day_value, datetime.min.time(), tzinfo=timezone.utc).timestamp()


def get_bootstrap(app_ctx, request):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    try:
        preferences = _migrate_legacy_folder_goals(app_ctx, uid, _preferences(app_ctx, uid))
        start_date, end_date = _date_bounds(request, preferences['timezone'])
        goals = [_serialize_goal(item) for item in app_ctx.planner_repo.list_study_goals_by_uid(app_ctx.db, uid, 200)]
        active_goals = [item for item in goals if item['status'] == 'active']
        try:
            pack_limit = max(1, min(100, int(request.args.get('pack_limit', 100) or 100)))
        except (TypeError, ValueError):
            return app_ctx.jsonify({'error': 'Library page size is invalid.'}), 400
        packs, next_pack_cursor = _pack_summary_page(app_ctx, uid, pack_limit)
        loaded_pack_ids = {item['study_pack_id'] for item in packs}
        selected_pack_ids = {pack_id for goal in active_goals for pack_id in goal['pack_ids']}
        for pack_id in sorted(selected_pack_ids - loaded_pack_ids):
            doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, pack_id)
            raw = doc.to_dict() if getattr(doc, 'exists', False) else {}
            if getattr(doc, 'exists', False) and str(raw.get('uid', '') or '') == uid:
                summary = _pack_summary(raw, pack_id)
                if not summary['archived']:
                    packs.append(summary)
        states = _pack_states(app_ctx, uid, [item['study_pack_id'] for item in packs])
        pace, completed_notes = _recent_activity_context(app_ctx, uid)
        today = _today_for_timezone(preferences['timezone'])
        workloads = {
            pack['study_pack_id']: study_plan.build_pack_workload(
                pack,
                states.get(pack['study_pack_id'], {}),
                today=today,
                card_minutes=pace['card_minutes'],
                question_minutes=pace['question_minutes'],
                completed_notes_minutes=completed_notes.get(pack['study_pack_id'], 0),
            )
            for pack in packs
        }
        packs_by_id = {pack['study_pack_id']: pack for pack in packs}
        goal_workloads = {
            goal['goal_id']: {
                pack_id: study_plan.build_pack_workload(
                    packs_by_id[pack_id],
                    states.get(pack_id, {}),
                    notes_minutes=goal.get('notes_minutes_by_pack', {}).get(pack_id, 45),
                    today=today,
                    card_minutes=pace['card_minutes'],
                    question_minutes=pace['question_minutes'],
                    completed_notes_minutes=completed_notes.get(pack_id, 0),
                )
                for pack_id in goal['pack_ids']
                if pack_id in packs_by_id
            }
            for goal in active_goals
        }
        membership = {pack_id for goal in active_goals for pack_id in goal['pack_ids']}
        for pack in packs:
            pack['in_plan'] = pack['study_pack_id'] in membership
            pack['workload'] = workloads.get(pack['study_pack_id'], {})
        sessions = _session_records(app_ctx, uid, start_date, end_date)
        week_start = date.fromisoformat(today) - timedelta(days=date.fromisoformat(today).weekday())
        week_end = week_start + timedelta(days=6)
        progress_end = max([week_end.isoformat()] + [goal['exam_date'] for goal in active_goals])
        progress_sessions = _session_records(app_ctx, uid, week_start.isoformat(), progress_end, 400)
        progress = _activity_summary(
            app_ctx,
            uid,
            _local_day_start_timestamp(week_start, preferences['timezone']),
            progress_sessions,
            active_goals,
            workloads,
            goal_workloads=goal_workloads,
            period_start_date=week_start.isoformat(),
            period_end_date=week_end.isoformat(),
        )
        feeds = [_public_feed_state(item) for item in app_ctx.planner_repo.list_calendar_feeds_by_uid(app_ctx.db, uid, MAX_CALENDAR_FEEDS, active_only=True)]
        return app_ctx.jsonify({
            'preferences': preferences,
            'goals': goals,
            'sessions': sessions,
            'progress': progress,
            'study_packs': packs,
            'calendar_feeds': feeds,
            'pace': pace,
            'range': {'from': start_date, 'to': end_date},
            'next_pack_cursor': next_pack_cursor,
        })
    except Exception as error:
        app_ctx.logger.error('Could not load Study Plan bootstrap for %s: %s', uid, error)
        return app_ctx.jsonify({'error': 'Could not load your study plan.'}), 500


def get_membership(app_ctx, request):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    goals = app_ctx.planner_repo.list_study_goals_by_uid(app_ctx.db, decoded['uid'], 200)
    pack_ids = sorted({pack_id for goal in goals if goal.get('status', 'active') == 'active' for pack_id in study_plan.sanitize_pack_ids(goal.get('pack_ids', []))})
    return app_ctx.jsonify({'pack_ids': pack_ids})


def get_library_page(app_ctx, request):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    try:
        limit = max(1, min(100, int(request.args.get('limit', 100) or 100)))
    except (TypeError, ValueError):
        return app_ctx.jsonify({'error': 'Library page size is invalid.'}), 400
    cursor = study_plan.sanitize_id(request.args.get('cursor'))
    after_doc = None
    if request.args.get('cursor') and not cursor:
        return app_ctx.jsonify({'error': 'Library cursor is invalid.'}), 400
    if cursor:
        after_doc = app_ctx.study_repo.get_study_pack_doc(app_ctx.db, cursor)
        raw = after_doc.to_dict() if getattr(after_doc, 'exists', False) else {}
        if not getattr(after_doc, 'exists', False) or str(raw.get('uid', '') or '') != uid:
            return app_ctx.jsonify({'error': 'Library cursor is invalid.'}), 400
    packs, next_cursor = _pack_summary_page(app_ctx, uid, limit, after_doc=after_doc)
    active_goals = [item for item in app_ctx.planner_repo.list_study_goals_by_uid(app_ctx.db, uid, 200) if item.get('status', 'active') == 'active']
    membership = {pack_id for goal in active_goals for pack_id in study_plan.sanitize_pack_ids(goal.get('pack_ids', []))}
    for pack in packs:
        pack['in_plan'] = pack['study_pack_id'] in membership
    return app_ctx.jsonify({'study_packs': packs, 'next_cursor': next_cursor})


def update_preferences(app_ctx, request):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard is not None:
        return guard
    incoming = request.get_json(silent=True) or {}
    current = _preferences(app_ctx, uid)
    requested_revision = incoming.get('revision')
    if requested_revision is not None and _safe_revision(requested_revision) != _safe_revision(current.get('revision', 0)):
        return app_ctx.jsonify({'error': 'Planning settings changed in another tab.', 'code': 'revision_conflict', 'preferences': current}), 409
    safe = study_plan.sanitize_preferences(incoming, existing=current)
    safe.update({'uid': uid, 'revision': int(current.get('revision', 0)) + 1, 'migration_v1_complete': True, 'availability_configured': 'availability' in incoming or bool(current.get('availability_configured', False)), 'updated_at': app_ctx.time.time()})
    app_ctx.planner_repo.set_study_plan_preferences(app_ctx.db, uid, safe, merge=False)
    return app_ctx.jsonify({'ok': True, 'preferences': safe})


def create_goal(app_ctx, request):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard is not None:
        return guard
    body = request.get_json(silent=True) or {}
    goal_id = _new_id('goal')
    payload, error = study_plan.sanitize_goal(body, goal_id=goal_id, now_ts=app_ctx.time.time())
    if payload is None:
        return app_ctx.jsonify({'error': error}), 400
    owned = _owned_pack_ids(app_ctx, uid, payload['pack_ids'])
    if owned != set(payload['pack_ids']):
        return app_ctx.jsonify({'error': 'One or more study packs could not be found.'}), 400
    payload.update({'uid': uid, 'status': 'active', 'revision': 1})
    app_ctx.planner_repo.set_study_goal(app_ctx.db, uid, goal_id, payload, merge=False)
    return app_ctx.jsonify({'ok': True, 'goal': _serialize_goal(payload)}), 201


def update_goal(app_ctx, request, goal_id):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard is not None:
        return guard
    safe_id = study_plan.sanitize_id(goal_id)
    if not safe_id:
        return app_ctx.jsonify({'error': 'Study goal id is invalid.'}), 400
    snapshot = app_ctx.planner_repo.get_study_goal(app_ctx.db, uid, safe_id)
    if not snapshot.exists:
        return app_ctx.jsonify({'error': 'Study goal not found.'}), 404
    current = snapshot.to_dict()
    body = request.get_json(silent=True) or {}
    if 'revision' in body and _safe_revision(body.get('revision')) != _safe_revision(current.get('revision', 0)):
        return app_ctx.jsonify({'error': 'This goal changed in another tab.', 'code': 'revision_conflict', 'goal': _serialize_goal(current)}), 409
    payload, error = study_plan.sanitize_goal(body, goal_id=safe_id, existing=current, now_ts=app_ctx.time.time())
    if payload is None:
        return app_ctx.jsonify({'error': error}), 400
    if _owned_pack_ids(app_ctx, uid, payload['pack_ids']) != set(payload['pack_ids']):
        return app_ctx.jsonify({'error': 'One or more study packs could not be found.'}), 400
    payload.update({'uid': uid, 'revision': int(current.get('revision', 0) or 0) + 1})
    app_ctx.planner_repo.set_study_goal(app_ctx.db, uid, safe_id, payload, merge=False)
    return app_ctx.jsonify({'ok': True, 'goal': _serialize_goal(payload)})


def archive_goal(app_ctx, request, goal_id):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard is not None:
        return guard
    safe_id = study_plan.sanitize_id(goal_id)
    if not safe_id:
        return app_ctx.jsonify({'error': 'Study goal id is invalid.'}), 400
    snapshot = app_ctx.planner_repo.get_study_goal(app_ctx.db, uid, safe_id)
    if not snapshot.exists:
        return app_ctx.jsonify({'error': 'Study goal not found.'}), 404
    current = snapshot.to_dict()
    current.update({'status': 'archived', 'revision': int(current.get('revision', 0) or 0) + 1, 'updated_at': app_ctx.time.time()})
    app_ctx.planner_repo.set_study_goal(app_ctx.db, uid, safe_id, current, merge=False)
    today = _today_for_timezone(_preferences(app_ctx, uid)['timezone'])
    for item in _session_records(app_ctx, uid, today, '', 400):
        if item.get('goal_id') == safe_id and item.get('origin') == 'automatic' and item.get('status') == 'planned':
            item.update({'status': 'cancelled', 'revision': int(item.get('revision', 0) or 0) + 1, 'updated_at': app_ctx.time.time()})
            app_ctx.planner_repo.set_planner_session(app_ctx.db, uid, item['id'], {**item, 'uid': uid}, merge=False)
    return app_ctx.jsonify({'ok': True, 'goal': _serialize_goal(current)})


def preview_plan(app_ctx, request):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    body = request.get_json(silent=True) or {}
    now_ts = app_ctx.time.time()
    raw_goal = body.get('goal') if isinstance(body.get('goal'), dict) else {}
    requested_goal_id = study_plan.sanitize_id(raw_goal.get('goal_id'))
    existing_goal = {}
    if requested_goal_id:
        snapshot = app_ctx.planner_repo.get_study_goal(app_ctx.db, uid, requested_goal_id)
        if not snapshot.exists:
            return app_ctx.jsonify({'error': 'Study goal not found.'}), 404
        existing_goal = snapshot.to_dict()
    goal_id = requested_goal_id or _new_id('goal')
    goal, validation_error = study_plan.sanitize_goal(raw_goal, goal_id=goal_id, existing=existing_goal, now_ts=now_ts)
    if goal is None:
        return app_ctx.jsonify({'error': validation_error}), 400
    if _owned_pack_ids(app_ctx, uid, goal['pack_ids']) != set(goal['pack_ids']):
        return app_ctx.jsonify({'error': 'One or more study packs could not be found.'}), 400
    current_preferences = _preferences(app_ctx, uid)
    requested_preferences = body.get('preferences') if isinstance(body.get('preferences'), dict) else {}
    preferences = study_plan.sanitize_preferences(requested_preferences, existing=current_preferences)
    preferences['availability_configured'] = True
    today = _today_for_timezone(preferences['timezone'])
    if goal['exam_date'] <= today:
        return app_ctx.jsonify({'error': 'The exam date must be after today.'}), 400
    packs_by_id = _owned_pack_summaries(app_ctx, uid, goal['pack_ids'])
    states = _pack_states(app_ctx, uid, goal['pack_ids'])
    pace, completed_notes = _recent_activity_context(app_ctx, uid)
    workloads = [
        study_plan.build_pack_workload(
            packs_by_id[pack_id],
            states.get(pack_id, {}),
            notes_minutes=goal.get('notes_minutes_by_pack', {}).get(pack_id, 45),
            today=today,
            card_minutes=pace['card_minutes'],
            question_minutes=pace['question_minutes'],
            completed_notes_minutes=completed_notes.get(pack_id, 0),
        )
        for pack_id in goal['pack_ids']
        if pack_id in packs_by_id
    ]
    future_sessions = _session_records(app_ctx, uid, today, goal['exam_date'], 400)
    occupied = [
        item for item in future_sessions
        if item.get('goal_id') != goal_id
        or item.get('locked')
        or item.get('origin') != 'automatic'
        or item.get('status') != 'planned'
    ]
    proposal_id = _new_id('proposal')
    preview = study_plan.generate_schedule(
        goal=goal,
        pack_workloads=workloads,
        preferences=preferences,
        start_date=today,
        occupied=occupied,
        proposal_id=proposal_id,
    )
    proposal = {
        'proposal_id': proposal_id,
        'goal': goal,
        'preferences': preferences,
        'sessions': preview['sessions'],
        'summary': {key: preview[key] for key in ('required_minutes', 'scheduled_minutes', 'shortage_minutes', 'capacity_minutes')},
        'pace': pace,
        'base_goal_revision': int(existing_goal.get('revision', 0) or 0),
        'base_preferences_revision': int(current_preferences.get('revision', 0) or 0),
        'created_at': now_ts,
        'expires_at': now_ts + PROPOSAL_TTL_SECONDS,
        'applied_at': 0,
        'applied_session_ids': [],
    }
    app_ctx.planner_repo.set_study_plan_proposal(app_ctx.db, uid, proposal)
    return app_ctx.jsonify({'proposal': proposal})


def apply_plan(app_ctx, request):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard is not None:
        return guard
    body = request.get_json(silent=True) or {}
    proposal_id = study_plan.sanitize_id(body.get('proposal_id'))
    idempotency_key = study_plan.sanitize_id(body.get('idempotency_key'))
    if not proposal_id or not idempotency_key:
        return app_ctx.jsonify({'error': 'Proposal id and idempotency key are required.'}), 400
    snapshot = app_ctx.planner_repo.get_study_plan_proposal(app_ctx.db, uid)
    if not snapshot.exists:
        return app_ctx.jsonify({'error': 'This plan preview expired. Create a new preview.'}), 409
    proposal = snapshot.to_dict()
    if proposal.get('proposal_id') != proposal_id or float(proposal.get('expires_at', 0) or 0) < app_ctx.time.time():
        return app_ctx.jsonify({'error': 'This plan preview expired. Create a new preview.'}), 409
    if proposal.get('applied_at'):
        if not hmac.compare_digest(str(proposal.get('idempotency_key', '') or ''), idempotency_key):
            return app_ctx.jsonify({'error': 'This preview was already accepted.', 'code': 'idempotency_conflict'}), 409
        return app_ctx.jsonify({'ok': True, 'goal': _serialize_goal(proposal.get('goal', {})), 'session_ids': proposal.get('applied_session_ids', []), 'replayed': True})
    goal = dict(proposal.get('goal') or {})
    current_goal_snapshot = app_ctx.planner_repo.get_study_goal(app_ctx.db, uid, goal.get('goal_id', ''))
    current_goal = current_goal_snapshot.to_dict() if current_goal_snapshot.exists else {}
    if int(current_goal.get('revision', 0) or 0) != int(proposal.get('base_goal_revision', 0) or 0):
        return app_ctx.jsonify({'error': 'The study goal changed after this preview.', 'code': 'revision_conflict'}), 409
    current_preferences = _preferences(app_ctx, uid)
    if int(current_preferences.get('revision', 0) or 0) != int(proposal.get('base_preferences_revision', 0) or 0):
        return app_ctx.jsonify({'error': 'Availability changed after this preview.', 'code': 'revision_conflict'}), 409
    now_ts = app_ctx.time.time()
    goal.update({'uid': uid, 'revision': int(current_goal.get('revision', 0) or 0) + 1, 'updated_at': now_ts})
    preferences = dict(proposal.get('preferences') or {})
    preferences.update({'uid': uid, 'revision': int(current_preferences.get('revision', 0) or 0) + 1, 'migration_v1_complete': True, 'availability_configured': True, 'updated_at': now_ts})
    today = _today_for_timezone(preferences['timezone'])
    cancellations = []
    for existing in _session_records(app_ctx, uid, today, goal['exam_date'], 250):
        if existing.get('goal_id') == goal['goal_id'] and existing.get('origin') == 'automatic' and not existing.get('locked') and existing.get('status') == 'planned':
            existing.update({'status': 'cancelled', 'revision': int(existing.get('revision', 0) or 0) + 1, 'updated_at': now_ts})
            cancellations.append({**existing, 'uid': uid})
    session_payloads = []
    for raw in proposal.get('sessions', [])[:200]:
        safe, validation_error = legacy_models.sanitize_session_payload(raw, session_id=raw.get('id', ''), now_ts=now_ts, runtime=app_ctx)
        if safe is None or validation_error:
            continue
        safe.update({'uid': uid, 'revision': 1})
        session_payloads.append(safe)
    proposal.update({
        'applied_at': now_ts,
        'applied_session_ids': [item['id'] for item in session_payloads],
        'goal': goal,
        'idempotency_key': idempotency_key,
    })
    if app_ctx.db is not None and hasattr(app_ctx.db, 'batch'):
        batch = app_ctx.db.batch()
        batch.set(app_ctx.planner_repo.study_goal_doc_ref(app_ctx.db, goal['goal_id']), goal)
        batch.set(app_ctx.planner_repo.study_plan_preferences_doc_ref(app_ctx.db, uid), preferences)
        for existing in cancellations:
            batch.set(app_ctx.planner_repo.planner_session_doc_ref(app_ctx.db, uid, existing['id']), existing)
        for safe in session_payloads:
            batch.set(app_ctx.planner_repo.planner_session_doc_ref(app_ctx.db, uid, safe['id']), safe)
        batch.set(app_ctx.planner_repo.study_plan_proposal_doc_ref(app_ctx.db, uid), {**proposal, 'uid': uid})
        batch.commit()
    else:
        app_ctx.planner_repo.set_study_goal(app_ctx.db, uid, goal['goal_id'], goal, merge=False)
        app_ctx.planner_repo.set_study_plan_preferences(app_ctx.db, uid, preferences, merge=False)
        for existing in cancellations:
            app_ctx.planner_repo.set_planner_session(app_ctx.db, uid, existing['id'], existing, merge=False)
        for safe in session_payloads:
            app_ctx.planner_repo.set_planner_session(app_ctx.db, uid, safe['id'], safe, merge=False)
        app_ctx.planner_repo.set_study_plan_proposal(app_ctx.db, uid, proposal)
    return app_ctx.jsonify({'ok': True, 'goal': _serialize_goal(goal), 'session_ids': proposal['applied_session_ids'], 'replayed': False})


def update_plan_item(app_ctx, request, session_id):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard is not None:
        return guard
    safe_id = study_plan.sanitize_id(session_id)
    if not safe_id:
        return app_ctx.jsonify({'error': 'Study session id is invalid.'}), 400
    existing_snapshot = app_ctx.planner_repo.get_planner_session(app_ctx.db, uid, safe_id)
    existing = existing_snapshot.to_dict() if existing_snapshot.exists else {}
    body = request.get_json(silent=True) or {}
    if existing and 'revision' in body and _safe_revision(body.get('revision')) != _safe_revision(existing.get('revision', 0)):
        return app_ctx.jsonify({'error': 'This session changed in another tab.', 'code': 'revision_conflict', 'session': existing}), 409
    merged = dict(existing)
    merged.update(body)
    merged['id'] = safe_id
    if not existing:
        merged.setdefault('origin', 'manual')
        merged.setdefault('locked', True)
    safe, validation_error = legacy_models.sanitize_session_payload(merged, session_id=safe_id, existing=existing, now_ts=app_ctx.time.time(), runtime=app_ctx)
    if safe is None:
        return app_ctx.jsonify({'error': validation_error}), 400
    if safe.get('pack_id') and safe['pack_id'] not in _owned_pack_ids(app_ctx, uid, [safe['pack_id']]):
        return app_ctx.jsonify({'error': 'Study pack not found.'}), 400
    safe['starts_at_utc'] = _starts_at_utc(safe['date'], safe['time'], _preferences(app_ctx, uid)['timezone'])
    safe.update({'uid': uid, 'revision': int(existing.get('revision', 0) or 0) + 1})
    app_ctx.planner_repo.set_planner_session(app_ctx.db, uid, safe_id, safe, merge=False)
    return app_ctx.jsonify({'ok': True, 'session': safe}), (200 if existing else 201)


def update_activity(app_ctx, request, activity_id):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard is not None:
        return guard
    safe_id = study_plan.sanitize_id(activity_id)
    if not safe_id:
        return app_ctx.jsonify({'error': 'Activity session id is invalid.'}), 400
    body = request.get_json(silent=True) or {}
    pack_id = study_plan.sanitize_id(body.get('pack_id'))
    if pack_id and pack_id not in _owned_pack_ids(app_ctx, uid, [pack_id]):
        return app_ctx.jsonify({'error': 'Study pack not found.'}), 400
    existing_snapshot = app_ctx.planner_repo.get_study_activity(app_ctx.db, uid, safe_id)
    existing = existing_snapshot.to_dict() if existing_snapshot.exists else {}
    incoming_metrics = study_plan.activity_metrics(body.get('metrics', {}))
    existing_metrics = study_plan.activity_metrics(existing.get('metrics', {}))
    metrics = {key: max(existing_metrics[key], incoming_metrics[key]) for key in incoming_metrics}
    now_ts = app_ctx.time.time()
    started_source = existing.get('started_at') if existing else body.get('started_at', now_ts)
    started_at = _safe_float(started_source, -1)
    ended_source = body.get('ended_at', existing.get('ended_at', 0))
    ended_at = _safe_float(ended_source, -1)
    if started_at <= 0 or started_at > now_ts + 300 or ended_at < 0 or (ended_at and ended_at < started_at) or ended_at > now_ts + 300:
        return app_ctx.jsonify({'error': 'Activity timestamps are invalid.'}), 400
    payload = {
        'activity_id': safe_id,
        'uid': uid,
        'pack_id': pack_id or str(existing.get('pack_id', '') or ''),
        'plan_item_id': study_plan.sanitize_id(body.get('plan_item_id', existing.get('plan_item_id', ''))),
        'mode': str(body.get('mode', existing.get('mode', 'study')) or 'study').strip()[:40],
        'activity_type': str(body.get('activity_type', body.get('mode', existing.get('activity_type', 'study'))) or 'study').strip()[:40],
        'started_at': started_at,
        'ended_at': max(_safe_float(existing.get('ended_at', 0)), ended_at),
        'metrics': metrics,
        'minutes_completed': metrics['minutes'],
        'cards_completed': metrics['cards_reviewed'],
        'questions_completed': metrics['questions_answered'],
        'accuracy_percent': round((metrics['correct'] / (metrics['correct'] + metrics['incorrect'])) * 100) if metrics['correct'] + metrics['incorrect'] else 0,
        'updated_at': now_ts,
    }
    app_ctx.planner_repo.set_study_activity(app_ctx.db, uid, safe_id, payload, merge=False)
    plan_item_id = payload['plan_item_id']
    if plan_item_id and payload['ended_at'] and sum(metrics.values()) > 0:
        session_snapshot = app_ctx.planner_repo.get_planner_session(app_ctx.db, uid, plan_item_id)
        if session_snapshot.exists:
            session = session_snapshot.to_dict()
            session_pack_id = str(session.get('pack_id', '') or '')
            if not session_pack_id or session_pack_id == payload['pack_id']:
                session.update({'status': 'completed', 'revision': int(session.get('revision', 0) or 0) + 1, 'updated_at': now_ts})
                app_ctx.planner_repo.set_planner_session(app_ctx.db, uid, plan_item_id, session, merge=False)
    return app_ctx.jsonify({'ok': True, 'activity': payload})


def _public_feed_state(raw):
    source = raw if isinstance(raw, dict) else {}
    try:
        reminder_offset = max(0, min(1440, int(source.get('reminder_offset_minutes', 30) or 0)))
    except (TypeError, ValueError):
        reminder_offset = 30
    return {
        'feed_id': str(source.get('feed_id', '') or ''),
        'name': str(source.get('name', '') or 'Device calendar'),
        'created_at': _safe_float(source.get('created_at', 0)),
        'revoked_at': _safe_float(source.get('revoked_at', 0)),
        'last_accessed_at': _safe_float(source.get('last_accessed_at', 0)),
        'reminder_offset_minutes': reminder_offset,
    }


def create_calendar_feed(app_ctx, request):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard is not None:
        return guard
    active = app_ctx.planner_repo.list_calendar_feeds_by_uid(app_ctx.db, uid, MAX_CALENDAR_FEEDS + 1, active_only=True)
    if len(active) >= MAX_CALENDAR_FEEDS:
        return app_ctx.jsonify({'error': 'You can connect up to five device calendars.'}), 409
    body = request.get_json(silent=True) or {}
    name = ' '.join(str(body.get('name', '') or 'Device calendar').split()).strip()[:80] or 'Device calendar'
    try:
        reminder_offset = max(0, min(1440, int(body.get('reminder_offset_minutes', 30) or 0)))
    except (TypeError, ValueError):
        return app_ctx.jsonify({'error': 'Reminder offset must be a number of minutes.'}), 400
    feed_id = _new_id('feed')
    secret = secrets.token_urlsafe(32)
    secret_hash = hashlib.sha256(secret.encode('utf-8')).hexdigest()
    now_ts = app_ctx.time.time()
    payload = {
        'feed_id': feed_id,
        'uid': uid,
        'name': name,
        'secret_hash': secret_hash,
        'reminder_offset_minutes': reminder_offset,
        'created_at': now_ts,
        'revoked_at': 0,
        'last_accessed_at': 0,
    }
    app_ctx.planner_repo.set_calendar_feed(app_ctx.db, feed_id, payload, merge=False)
    base_url = str(getattr(app_ctx, 'PUBLIC_BASE_URL', '') or request.url_root).rstrip('/')
    token = f'{feed_id}.{secret}'
    return app_ctx.jsonify({'ok': True, 'feed': _public_feed_state(payload), 'subscription_url': f'{base_url}/calendar/feed/{token}.ics'}), 201


def revoke_calendar_feed(app_ctx, request, feed_id):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard is not None:
        return guard
    safe_id = study_plan.sanitize_id(feed_id)
    if not safe_id:
        return app_ctx.jsonify({'error': 'Calendar connection id is invalid.'}), 400
    snapshot = app_ctx.planner_repo.get_calendar_feed(app_ctx.db, safe_id)
    if not snapshot.exists or str(snapshot.to_dict().get('uid', '') or '') != uid:
        return app_ctx.jsonify({'error': 'Calendar connection not found.'}), 404
    payload = snapshot.to_dict()
    payload['revoked_at'] = app_ctx.time.time()
    app_ctx.planner_repo.set_calendar_feed(app_ctx.db, safe_id, payload, merge=False)
    return app_ctx.jsonify({'ok': True, 'feed': _public_feed_state(payload)})


def rotate_calendar_feed(app_ctx, request, feed_id):
    decoded, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard is not None:
        return guard
    safe_id = study_plan.sanitize_id(feed_id)
    snapshot = app_ctx.planner_repo.get_calendar_feed(app_ctx.db, safe_id)
    payload = snapshot.to_dict() if snapshot.exists else {}
    if not snapshot.exists or str(payload.get('uid', '') or '') != uid or payload.get('revoked_at'):
        return app_ctx.jsonify({'error': 'Calendar connection not found.'}), 404
    secret = secrets.token_urlsafe(32)
    payload.update({
        'secret_hash': hashlib.sha256(secret.encode('utf-8')).hexdigest(),
        'rotated_at': app_ctx.time.time(),
        'last_accessed_at': 0,
    })
    app_ctx.planner_repo.set_calendar_feed(app_ctx.db, safe_id, payload, merge=False)
    base_url = str(getattr(app_ctx, 'PUBLIC_BASE_URL', '') or request.url_root).rstrip('/')
    return app_ctx.jsonify({
        'ok': True,
        'feed': _public_feed_state(payload),
        'subscription_url': f'{base_url}/calendar/feed/{safe_id}.{secret}.ics',
    })


def _ics_escape(value):
    return str(value or '').replace('\\', '\\\\').replace(';', '\\;').replace(',', '\\,').replace('\r', '').replace('\n', '\\n')


def _ics_fold(line):
    chunks = []
    current = ''
    byte_limit = 75
    for character in str(line or ''):
        candidate = current + character
        if current and len(candidate.encode('utf-8')) > byte_limit:
            chunks.append(current)
            current = character
            byte_limit = 74
        else:
            current = candidate
    chunks.append(current)
    return [chunks[0]] + [' ' + chunk for chunk in chunks[1:]]


def _ics_timestamp(date_value, time_value, timezone_name):
    try:
        from zoneinfo import ZoneInfo
        local = datetime.fromisoformat(f'{date_value}T{time_value}:00').replace(tzinfo=ZoneInfo(timezone_name))
    except Exception:
        local = datetime.fromisoformat(f'{date_value}T{time_value}:00').replace(tzinfo=timezone.utc)
    return local.astimezone(timezone.utc)


def get_calendar_feed(app_ctx, request, token):
    raw_token = str(token or '')
    if '.' not in raw_token:
        return Response('Calendar feed not found.', status=404, mimetype='text/plain')
    feed_id, secret = raw_token.split('.', 1)
    safe_id = study_plan.sanitize_id(feed_id)
    if not safe_id or not secret:
        return Response('Calendar feed not found.', status=404, mimetype='text/plain')
    snapshot = app_ctx.planner_repo.get_calendar_feed(app_ctx.db, safe_id)
    if not snapshot.exists:
        return Response('Calendar feed not found.', status=404, mimetype='text/plain')
    feed = snapshot.to_dict()
    digest = hashlib.sha256(secret.encode('utf-8')).hexdigest()
    if not hmac.compare_digest(digest, str(feed.get('secret_hash', '') or '')):
        return Response('Calendar feed not found.', status=404, mimetype='text/plain')
    if feed.get('revoked_at'):
        return Response('Calendar feed has been revoked.', status=410, mimetype='text/plain')
    uid = str(feed.get('uid', '') or '')
    preferences = _preferences(app_ctx, uid)
    today = _today_for_timezone(preferences['timezone'])
    start = (date.fromisoformat(today) - timedelta(days=30)).isoformat()
    end = (date.fromisoformat(today) + timedelta(days=365)).isoformat()
    sessions = _session_records(app_ctx, uid, start, end, 400)
    goals = [_serialize_goal(item) for item in app_ctx.planner_repo.list_study_goals_by_uid(app_ctx.db, uid, 200)]
    now_utc = datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Lecture Processor//Study Plan//EN', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:Lecture Processor Study Plan']
    base_url = str(getattr(app_ctx, 'PUBLIC_BASE_URL', '') or request.url_root).rstrip('/')
    reminder = int(feed.get('reminder_offset_minutes', preferences.get('reminder_offset_minutes', 30)) or 0)
    for session in sessions:
        start_dt = _ics_timestamp(session['date'], session['time'], preferences['timezone'])
        end_dt = start_dt + timedelta(minutes=int(session.get('duration', 45) or 45))
        deep_link = f"{base_url}/study?pack_id={session.get('pack_id', '')}&mode=learn&plan_item_id={session.get('id', '')}" if session.get('pack_id') else f'{base_url}/plan?view=today'
        lines.extend([
            'BEGIN:VEVENT',
            f"UID:{_ics_escape(session['id'])}@lectureprocessor.com",
            f'DTSTAMP:{now_utc}',
            f"DTSTART:{start_dt.strftime('%Y%m%dT%H%M%SZ')}",
            f"DTEND:{end_dt.strftime('%Y%m%dT%H%M%SZ')}",
            f"SEQUENCE:{int(session.get('revision', 0) or 0)}",
            f"STATUS:{'CANCELLED' if session.get('status') in {'cancelled', 'skipped'} else 'CONFIRMED'}",
            f"SUMMARY:{_ics_escape(session.get('title', 'Study session'))}",
            f"DESCRIPTION:{_ics_escape(session.get('notes', 'Open this study session in Lecture Processor.'))}",
            f'URL:{_ics_escape(deep_link)}',
        ])
        if reminder > 0 and session.get('status') == 'planned':
            lines.extend(['BEGIN:VALARM', f'TRIGGER:-PT{reminder}M', 'ACTION:DISPLAY', 'DESCRIPTION:Study session reminder', 'END:VALARM'])
        lines.append('END:VEVENT')
    for goal in goals:
        exam_day = date.fromisoformat(goal['exam_date'])
        lines.extend([
            'BEGIN:VEVENT',
            f"UID:goal-{_ics_escape(goal['goal_id'])}@lectureprocessor.com",
            f'DTSTAMP:{now_utc}',
            f"DTSTART;VALUE=DATE:{exam_day.strftime('%Y%m%d')}",
            f"DTEND;VALUE=DATE:{(exam_day + timedelta(days=1)).strftime('%Y%m%d')}",
            f"SEQUENCE:{int(goal.get('revision', 0) or 0)}",
            f"STATUS:{'CANCELLED' if goal.get('status') == 'archived' else 'CONFIRMED'}",
            f"SUMMARY:{_ics_escape('Exam: ' + goal['title'])}",
            f'URL:{_ics_escape(base_url + "/plan?view=schedule")}',
            'END:VEVENT',
        ])
    lines.append('END:VCALENDAR')
    feed['last_accessed_at'] = app_ctx.time.time()
    try:
        app_ctx.planner_repo.set_calendar_feed(app_ctx.db, safe_id, feed, merge=False)
    except Exception as error:
        app_ctx.logger.warning('Could not record calendar feed access for %s: %s', feed_id, error)
    folded_lines = [folded for line in lines for folded in _ics_fold(line)]
    response = Response('\r\n'.join(folded_lines) + '\r\n', status=200, content_type='text/calendar; charset=utf-8')
    response.headers['Content-Disposition'] = 'inline; filename="lecture-processor-study-plan.ics"'
    response.headers['Cache-Control'] = 'private, max-age=300'
    response.headers['ETag'] = hashlib.sha256(response.get_data()).hexdigest()
    return response
