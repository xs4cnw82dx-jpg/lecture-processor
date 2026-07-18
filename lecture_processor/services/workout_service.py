"""Admin-only workout tracker APIs and public sanitized share reads."""

from __future__ import annotations

from copy import deepcopy
from datetime import date
import secrets

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.workout import models
from lecture_processor.repositories import workout_repo
from lecture_processor.services import admin_support


def _auth(app_ctx, request):
    return admin_support.require_admin(app_ctx, request)


def _write_guard(app_ctx, uid):
    allowed, message = account_lifecycle.ensure_account_allows_writes(uid, runtime=app_ctx)
    if allowed:
        return None
    return app_ctx.jsonify({'error': message, 'status': 'account_deletion_in_progress'}), 409


def _json_payload(request):
    payload = request.get_json(silent=True)
    return payload if isinstance(payload, dict) else {}


def _collection(app_ctx, name, uid, limit=1000):
    return workout_repo.list_records(app_ctx.db, name, uid, limit)


def _profile(app_ctx, uid):
    snapshot = workout_repo.get_profile(app_ctx.db, uid)
    return snapshot.to_dict() if snapshot.exists else models.default_profile(uid)


def _base_revision(payload):
    try:
        return int(payload.get('base_revision'))
    except (TypeError, ValueError, AttributeError):
        return None


def _conflict(app_ctx, payload, existing):
    requested = _base_revision(payload)
    current = int(existing.get('revision', 0) or 0)
    if requested is None or requested == current:
        return None
    return app_ctx.jsonify({'error': 'Revision conflict', 'current': existing}), 409


def _active_cycle_data(app_ctx, uid, profile):
    active_cycle_id = str(profile.get('active_cycle_id', '') or '')
    cycles = _collection(app_ctx, workout_repo.CYCLE_COLLECTION, uid, 50)
    occurrences = _collection(app_ctx, workout_repo.OCCURRENCE_COLLECTION, uid, 800)
    active_cycle = next((item for item in cycles if item.get('id') == active_cycle_id), None)
    active_occurrences = [item for item in occurrences if item.get('cycle_id') == active_cycle_id] if active_cycle_id else []
    active_occurrences.sort(key=lambda item: (item.get('date', ''), item.get('day', '')))
    return cycles, active_cycle, active_occurrences


def _exercise_and_routine_data(app_ctx, uid):
    exercises = models.merged_exercises(uid, _collection(app_ctx, workout_repo.EXERCISE_COLLECTION, uid, 500))
    routines = models.merged_routines(uid, _collection(app_ctx, workout_repo.ROUTINE_COLLECTION, uid, 200))
    return exercises, routines


def _public_profile(profile):
    payload = deepcopy(profile)
    payload.pop('uid', None)
    return payload


def bootstrap(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    profile = _profile(app_ctx, uid)
    exercises, routines = _exercise_and_routine_data(app_ctx, uid)
    cycles, active_cycle, occurrences = _active_cycle_data(app_ctx, uid, profile)
    sessions = _collection(app_ctx, workout_repo.SESSION_COLLECTION, uid, 300)
    sessions.sort(key=lambda item: str(item.get('updated_at', '')), reverse=True)
    active_session = next((models.calculate_session(item) for item in sessions if item.get('status') in {'active', 'paused'}), None)
    previous_scope = str((profile.get('settings') or {}).get('previous_values_scope', 'same_routine') or 'same_routine')
    bodyweight = _collection(app_ctx, workout_repo.BODYWEIGHT_COLLECTION, uid, 500)
    shares = _collection(app_ctx, workout_repo.SHARE_COLLECTION, uid, 200)
    return app_ctx.jsonify({
        'seed': models.load_seed(),
        'profile': _public_profile(profile),
        'exercises': exercises,
        'routines': routines,
        'cycles': sorted(cycles, key=lambda item: str(item.get('created_at', '')), reverse=True),
        'active_cycle': active_cycle,
        'occurrences': occurrences,
        'active_session': active_session,
        'history': [models.calculate_session(item) for item in sessions if item.get('status') == 'completed'][:30],
        'previous_values': models.previous_values(sessions, reference=active_session, scope=previous_scope),
        'bodyweight': sorted(bodyweight, key=lambda item: str(item.get('date', ''))),
        'shares': [{key: item.get(key) for key in ('token', 'kind', 'source_id', 'revoked', 'created_at', 'updated_at')} for item in shares],
        'statistics': models.build_statistics(sessions, occurrences, bodyweight, include_warmups=bool((profile.get('settings') or {}).get('warmup_sets_in_statistics'))),
        'server_date': date.today().isoformat(),
    })


def update_profile(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    payload = _json_payload(request)
    existing = _profile(app_ctx, uid)
    conflict = _conflict(app_ctx, payload, existing)
    if conflict:
        return conflict
    safe = models.sanitize_profile(payload, existing, uid=uid, now_ts=app_ctx.time.time())
    workout_repo.set_profile(app_ctx.db, uid, safe)
    return app_ctx.jsonify({'ok': True, 'profile': _public_profile(safe)})


def update_start_tests(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    payload = _json_payload(request)
    existing = _profile(app_ctx, uid)
    conflict = _conflict(app_ctx, payload, existing)
    if conflict:
        return conflict
    incoming = payload.get('tests') if isinstance(payload.get('tests'), list) else []
    baseline = {item['exercise_id']: item for item in models.load_seed()['start_tests']}
    safe_tests = []
    for item in incoming[: len(baseline)]:
        if not isinstance(item, dict) or item.get('exercise_id') not in baseline:
            continue
        base = baseline[item['exercise_id']]
        try:
            test_kg = max(0, min(float(item.get('test_kg', base['test_kg']) or 0), 500))
            raw_test_reps = item.get('test_reps')
            test_reps = None if raw_test_reps in (None, '') else max(0, min(int(raw_test_reps), 1000))
        except (TypeError, ValueError):
            return app_ctx.jsonify({'error': 'Start-test load and reps must be numeric.'}), 400
        advice = models.start_test_advice(
            test_kg=test_kg,
            test_reps=test_reps,
            rep_min=base['rep_min'],
            rep_max=base['rep_max'],
            load_type=base['load_type'],
        )
        safe_tests.append({
            'exercise_id': base['exercise_id'],
            'test_kg': test_kg,
            'test_reps': test_reps,
            **advice,
        })
    existing['start_tests'] = safe_tests
    safe = models.sanitize_profile({}, existing, uid=uid, now_ts=app_ctx.time.time())
    workout_repo.set_profile(app_ctx.db, uid, safe)
    return app_ctx.jsonify({'ok': True, 'tests': safe_tests, 'profile': _public_profile(safe)})


def _start_cycle(app_ctx, uid, payload):
    profile = _profile(app_ctx, uid)
    exercises, routines = _exercise_and_routine_data(app_ctx, uid)
    _ = exercises
    old_cycle_id = str(profile.get('active_cycle_id', '') or '')
    if old_cycle_id:
        old_snapshot = workout_repo.get_record(app_ctx.db, workout_repo.CYCLE_COLLECTION, uid, old_cycle_id)
        if old_snapshot.exists:
            old_cycle = old_snapshot.to_dict()
            old_cycle['status'] = 'archived'
            old_cycle['revision'] = int(old_cycle.get('revision', 0) or 0) + 1
            old_cycle['updated_at'] = models.utc_iso(app_ctx.time.time())
            workout_repo.set_record(app_ctx.db, workout_repo.CYCLE_COLLECTION, uid, old_cycle_id, old_cycle)
    cycle_id = f"cycle-{secrets.token_hex(8)}"
    use_baseline = bool(payload.get('restore_excel_baseline', False))
    cycle, occurrences = models.build_cycle(
        uid,
        cycle_id,
        payload.get('start_monday'),
        now_ts=app_ctx.time.time(),
        routines=models.baseline_routines(uid) if use_baseline else routines,
        training_days=profile.get('training_days'),
    )
    workout_repo.set_record(app_ctx.db, workout_repo.CYCLE_COLLECTION, uid, cycle_id, cycle)
    for occurrence in occurrences:
        workout_repo.set_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, occurrence['id'], occurrence)
    profile['active_cycle_id'] = cycle_id
    profile['setup_completed'] = True
    safe_profile = models.sanitize_profile({}, profile, uid=uid, now_ts=app_ctx.time.time())
    workout_repo.set_profile(app_ctx.db, uid, safe_profile)
    return cycle, occurrences, safe_profile


def start_cycle(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    payload = _json_payload(request)
    try:
        date.fromisoformat(str(payload.get('start_monday') or ''))
    except ValueError:
        return app_ctx.jsonify({'error': 'A valid start date is required.'}), 400
    cycle, occurrences, profile = _start_cycle(app_ctx, uid, payload)
    return app_ctx.jsonify({'ok': True, 'cycle': cycle, 'occurrences': occurrences, 'profile': _public_profile(profile)})


def reset_cycle(app_ctx, request):
    return start_cycle(app_ctx, request)


def list_exercises(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    exercises, _ = _exercise_and_routine_data(app_ctx, decoded['uid'])
    return app_ctx.jsonify({'exercises': exercises})


def create_exercise(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    safe, validation_error = models.sanitize_exercise(_json_payload(request), uid=uid, now_ts=app_ctx.time.time())
    if not safe:
        return app_ctx.jsonify({'error': validation_error}), 400
    workout_repo.set_record(app_ctx.db, workout_repo.EXERCISE_COLLECTION, uid, safe['id'], safe)
    return app_ctx.jsonify({'ok': True, 'exercise': safe}), 201


def update_exercise(app_ctx, request, exercise_id):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    existing_snapshot = workout_repo.get_record(app_ctx.db, workout_repo.EXERCISE_COLLECTION, uid, models.safe_id(exercise_id))
    existing = existing_snapshot.to_dict() if existing_snapshot.exists else next((item for item in models.merged_exercises(uid, []) if item['id'] == exercise_id), {})
    if not existing:
        return app_ctx.jsonify({'error': 'Exercise not found'}), 404
    payload = _json_payload(request)
    conflict = _conflict(app_ctx, payload, existing)
    if conflict:
        return conflict
    safe, validation_error = models.sanitize_exercise(payload, uid=uid, existing=existing, now_ts=app_ctx.time.time())
    if not safe:
        return app_ctx.jsonify({'error': validation_error}), 400
    safe['id'] = existing['id']
    safe['seeded'] = bool(existing.get('seeded'))
    workout_repo.set_record(app_ctx.db, workout_repo.EXERCISE_COLLECTION, uid, safe['id'], safe)
    return app_ctx.jsonify({'ok': True, 'exercise': safe})


def list_routines(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    _, routines = _exercise_and_routine_data(app_ctx, decoded['uid'])
    return app_ctx.jsonify({'routines': routines})


def create_routine(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    safe, validation_error = models.sanitize_routine(_json_payload(request), uid=uid, now_ts=app_ctx.time.time())
    if not safe:
        return app_ctx.jsonify({'error': validation_error}), 400
    workout_repo.set_record(app_ctx.db, workout_repo.ROUTINE_COLLECTION, uid, safe['id'], safe)
    return app_ctx.jsonify({'ok': True, 'routine': safe}), 201


def _apply_routine_to_occurrence(occurrence, routine):
    existing_by_id = {item.get('exercise_id'): item for item in occurrence.get('exercises', [])}
    next_exercises = []
    for index, routine_item in enumerate(routine.get('exercises', [])):
        item = deepcopy(existing_by_id.get(routine_item.get('exercise_id'), {}))
        item.update(deepcopy(routine_item))
        item['order'] = index + 1
        item.setdefault('exercise_name', routine_item.get('exercise_id'))
        item.setdefault('muscle_group', '')
        item.setdefault('load_type', routine_item.get('load_type', ''))
        next_exercises.append(item)
    occurrence['exercises'] = next_exercises
    occurrence['name'] = routine.get('name', occurrence.get('name'))
    occurrence['focus'] = routine.get('focus', occurrence.get('focus'))
    return occurrence


def update_routine(app_ctx, request, routine_id):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    safe_id = models.safe_id(routine_id)
    snapshot = workout_repo.get_record(app_ctx.db, workout_repo.ROUTINE_COLLECTION, uid, safe_id)
    existing = snapshot.to_dict() if snapshot.exists else next((item for item in models.baseline_routines(uid) if item['id'] == safe_id), {})
    if not existing:
        return app_ctx.jsonify({'error': 'Routine not found'}), 404
    payload = _json_payload(request)
    conflict = _conflict(app_ctx, payload, existing)
    if conflict:
        return conflict
    safe, validation_error = models.sanitize_routine(payload, uid=uid, existing=existing, now_ts=app_ctx.time.time())
    if not safe:
        return app_ctx.jsonify({'error': validation_error}), 400
    safe['id'] = safe_id
    safe['seeded'] = bool(existing.get('seeded'))
    workout_repo.set_record(app_ctx.db, workout_repo.ROUTINE_COLLECTION, uid, safe_id, safe)
    propagated = 0
    if safe.get('day') and safe.get('block'):
        profile = _profile(app_ctx, uid)
        _, _, occurrences = _active_cycle_data(app_ctx, uid, profile)
        for occurrence in occurrences:
            if occurrence.get('status') != 'planned' or int(occurrence.get('block', 0) or 0) != int(safe['block']) or occurrence.get('day') != safe['day']:
                continue
            _apply_routine_to_occurrence(occurrence, safe)
            occurrence['revision'] = int(occurrence.get('revision', 0) or 0) + 1
            occurrence['updated_at'] = models.utc_iso(app_ctx.time.time())
            workout_repo.set_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, occurrence['id'], occurrence)
            propagated += 1
    return app_ctx.jsonify({'ok': True, 'routine': safe, 'propagated_occurrences': propagated})


def duplicate_routine(app_ctx, request, routine_id):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    _, routines = _exercise_and_routine_data(app_ctx, uid)
    source = next((item for item in routines if item['id'] == routine_id), None)
    if not source:
        return app_ctx.jsonify({'error': 'Routine not found'}), 404
    copy = deepcopy(source)
    copy['id'] = f"routine-{secrets.token_hex(6)}"
    copy['name'] = f"{source.get('name', 'Routine')} Copy"
    copy['seeded'] = False
    copy['revision'] = 1
    copy['updated_at'] = models.utc_iso(app_ctx.time.time())
    workout_repo.set_record(app_ctx.db, workout_repo.ROUTINE_COLLECTION, uid, copy['id'], copy)
    return app_ctx.jsonify({'ok': True, 'routine': copy}), 201


def delete_routine(app_ctx, request, routine_id):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    _, routines = _exercise_and_routine_data(app_ctx, uid)
    routine = next((item for item in routines if item['id'] == routine_id), None)
    if not routine:
        return app_ctx.jsonify({'error': 'Routine not found'}), 404
    if routine.get('seeded'):
        return app_ctx.jsonify({'error': 'Seeded routines can be edited or restored, not deleted.'}), 400
    routine['archived'] = True
    routine['revision'] = int(routine.get('revision', 0) or 0) + 1
    routine['updated_at'] = models.utc_iso(app_ctx.time.time())
    workout_repo.set_record(app_ctx.db, workout_repo.ROUTINE_COLLECTION, uid, routine_id, routine)
    return app_ctx.jsonify({'ok': True})


def restore_baseline(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    baseline = models.baseline_routines(uid)
    for routine in baseline:
        workout_repo.delete_record(app_ctx.db, workout_repo.ROUTINE_COLLECTION, uid, routine['id'])
    profile = _profile(app_ctx, uid)
    _, _, occurrences = _active_cycle_data(app_ctx, uid, profile)
    restored = 0
    for occurrence in occurrences:
        if occurrence.get('status') != 'planned':
            continue
        occurrence['exercises'] = models.prescriptions_for(occurrence.get('week'), occurrence.get('day'))
        occurrence['revision'] = int(occurrence.get('revision', 0) or 0) + 1
        occurrence['updated_at'] = models.utc_iso(app_ctx.time.time())
        workout_repo.set_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, occurrence['id'], occurrence)
        restored += 1
    return app_ctx.jsonify({'ok': True, 'routines': baseline, 'restored_occurrences': restored})


def list_occurrences(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    profile = _profile(app_ctx, decoded['uid'])
    _, cycle, occurrences = _active_cycle_data(app_ctx, decoded['uid'], profile)
    return app_ctx.jsonify({'cycle': cycle, 'occurrences': occurrences})


def update_occurrence(app_ctx, request, occurrence_id):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    snapshot = workout_repo.get_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, models.safe_id(occurrence_id))
    if not snapshot.exists:
        return app_ctx.jsonify({'error': 'Workout occurrence not found'}), 404
    existing = snapshot.to_dict()
    payload = _json_payload(request)
    conflict = _conflict(app_ctx, payload, existing)
    if conflict:
        return conflict
    if existing.get('status') not in {'planned', 'skipped'}:
        return app_ctx.jsonify({'error': 'Active or completed workouts are frozen.'}), 409
    if 'date' in payload:
        try:
            existing['date'] = date.fromisoformat(str(payload['date'])).isoformat()
        except ValueError:
            return app_ctx.jsonify({'error': 'Invalid date'}), 400
    if payload.get('status') in {'planned', 'skipped'}:
        existing['status'] = payload['status']
    existing['revision'] = int(existing.get('revision', 0) or 0) + 1
    existing['updated_at'] = models.utc_iso(app_ctx.time.time())
    workout_repo.set_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, existing['id'], existing)
    return app_ctx.jsonify({'ok': True, 'occurrence': existing})


def _all_sessions(app_ctx, uid):
    sessions = _collection(app_ctx, workout_repo.SESSION_COLLECTION, uid, 1000)
    sessions.sort(key=lambda item: str(item.get('updated_at', '')), reverse=True)
    return sessions


def list_sessions(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    try:
        limit = max(1, min(int(request.args.get('limit', 50) or 50), 100))
    except (TypeError, ValueError):
        limit = 50
    sessions = _all_sessions(app_ctx, decoded['uid'])
    status_filter = str(request.args.get('status', '') or '').strip()
    if status_filter:
        sessions = [item for item in sessions if item.get('status') == status_filter]
    return app_ctx.jsonify({'sessions': [models.calculate_session(item) for item in sessions[:limit]]})


def start_session(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    sessions = _all_sessions(app_ctx, uid)
    active = next((item for item in sessions if item.get('status') in {'active', 'paused'}), None)
    if active:
        return app_ctx.jsonify({'ok': True, 'resumed': True, 'session': models.calculate_session(active)})
    payload = _json_payload(request)
    occurrence = None
    routine = None
    occurrence_id = models.safe_id(payload.get('occurrence_id'), prefix='') if payload.get('occurrence_id') else ''
    routine_id = models.safe_id(payload.get('routine_id'), prefix='') if payload.get('routine_id') else ''
    if occurrence_id:
        snapshot = workout_repo.get_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, occurrence_id)
        if not snapshot.exists:
            return app_ctx.jsonify({'error': 'Workout occurrence not found'}), 404
        occurrence = snapshot.to_dict()
        if occurrence.get('status') == 'completed':
            return app_ctx.jsonify({'error': 'Workout is already completed'}), 409
    elif routine_id:
        _, routines = _exercise_and_routine_data(app_ctx, uid)
        routine = next((item for item in routines if item['id'] == routine_id and not item.get('archived')), None)
        if not routine:
            return app_ctx.jsonify({'error': 'Routine not found'}), 404
    else:
        raw_routine = payload.get('routine') if isinstance(payload.get('routine'), dict) else {'id': '', 'name': 'Empty Workout', 'exercises': []}
        routine = raw_routine
    exercises, _ = _exercise_and_routine_data(app_ctx, uid)
    lookup = {item['id']: item for item in exercises}
    profile = _profile(app_ctx, uid)
    session_id = f"session-{secrets.token_hex(8)}"
    session = models.create_session_snapshot(
        uid,
        session_id,
        occurrence=occurrence,
        routine=routine,
        exercises_by_id=lookup,
        bodyweight_kg=profile.get('bodyweight_kg', 0),
        now_ts=app_ctx.time.time(),
    )
    previous = models.previous_values(sessions, reference=session, scope=str((profile.get('settings') or {}).get('previous_values_scope', 'same_routine') or 'same_routine'))
    for item in session.get('exercises', []):
        item['previous_sets'] = previous.get(item['exercise_id'], [])
    workout_repo.set_record(app_ctx.db, workout_repo.SESSION_COLLECTION, uid, session_id, session)
    if occurrence:
        occurrence['status'] = 'active'
        occurrence['session_id'] = session_id
        occurrence['revision'] = int(occurrence.get('revision', 0) or 0) + 1
        occurrence['updated_at'] = models.utc_iso(app_ctx.time.time())
        workout_repo.set_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, occurrence['id'], occurrence)
    return app_ctx.jsonify({'ok': True, 'resumed': False, 'session': models.calculate_session(session)}), 201


def update_session(app_ctx, request, session_id):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    snapshot = workout_repo.get_record(app_ctx.db, workout_repo.SESSION_COLLECTION, uid, models.safe_id(session_id))
    if not snapshot.exists:
        return app_ctx.jsonify({'error': 'Workout session not found'}), 404
    existing = snapshot.to_dict()
    if existing.get('status') in {'completed', 'discarded'}:
        return app_ctx.jsonify({'error': 'Completed or discarded workouts are immutable.'}), 409
    payload = _json_payload(request)
    conflict = _conflict(app_ctx, payload, existing)
    if conflict:
        return conflict
    safe, validation_error = models.sanitize_session_update(payload, existing, now_ts=app_ctx.time.time())
    if not safe:
        return app_ctx.jsonify({'error': validation_error}), 400
    workout_repo.set_record(app_ctx.db, workout_repo.SESSION_COLLECTION, uid, safe['id'], safe)
    return app_ctx.jsonify({'ok': True, 'session': models.calculate_session(safe)})


def finish_session(app_ctx, request, session_id):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    snapshot = workout_repo.get_record(app_ctx.db, workout_repo.SESSION_COLLECTION, uid, models.safe_id(session_id))
    if not snapshot.exists:
        return app_ctx.jsonify({'error': 'Workout session not found'}), 404
    existing = snapshot.to_dict()
    if existing.get('status') == 'completed':
        return app_ctx.jsonify({'ok': True, 'session': models.calculate_session(existing)})
    payload = _json_payload(request)
    conflict = _conflict(app_ctx, payload, existing)
    if conflict:
        return conflict
    if isinstance(payload.get('exercises'), list):
        safe, validation_error = models.sanitize_session_update(payload, existing, now_ts=app_ctx.time.time())
        if not safe:
            return app_ctx.jsonify({'error': validation_error}), 400
        existing = safe
    previous_stats = models.build_statistics(_all_sessions(app_ctx, uid), [], [])['records']
    existing['status'] = 'completed'
    existing['finished_at'] = models.utc_iso(app_ctx.time.time())
    existing['updated_at'] = existing['finished_at']
    existing['revision'] = int(existing.get('revision', 0) or 0) + 1
    calculated = models.calculate_session(existing)
    records = []
    for exercise in calculated.get('exercises', []):
        completed_sets = [item for item in exercise.get('sets', []) if item.get('completed') and item.get('type') != 'warmup']
        if not completed_sets:
            continue
        previous = previous_stats.get(exercise.get('exercise_id'), {})
        if exercise.get('tracking_type') == 'duration':
            duration_record = max(int(item.get('duration_seconds', 0) or 0) for item in completed_sets)
            if duration_record > int(previous.get('duration_seconds', 0) or 0):
                records.append({'exercise_id': exercise.get('exercise_id'), 'name': exercise.get('exercise_name'), 'type': 'duration', 'value': duration_record})
            continue
        heaviest = max(float(item.get('kg', 0) or 0) for item in completed_sets)
        reps = max(int(item.get('reps', 0) or 0) for item in completed_sets)
        estimated = max(models.epley_1rm(item.get('kg'), item.get('reps')) for item in completed_sets)
        best_set_volume = max(models.set_volume(exercise, item, calculated.get('bodyweight_kg', 0)) for item in completed_sets)
        if heaviest > float(previous.get('heaviest_kg', 0) or 0):
            records.append({'exercise_id': exercise.get('exercise_id'), 'name': exercise.get('exercise_name'), 'type': 'heaviest_weight', 'value': heaviest})
        if reps > int(previous.get('most_reps', 0) or 0):
            records.append({'exercise_id': exercise.get('exercise_id'), 'name': exercise.get('exercise_name'), 'type': 'most_reps', 'value': reps})
        if estimated > float(previous.get('estimated_1rm', 0) or 0):
            records.append({'exercise_id': exercise.get('exercise_id'), 'name': exercise.get('exercise_name'), 'type': 'estimated_1rm', 'value': round(estimated, 2)})
        if best_set_volume > float(previous.get('set_volume_kg', 0) or 0):
            records.append({'exercise_id': exercise.get('exercise_id'), 'name': exercise.get('exercise_name'), 'type': 'set_volume', 'value': round(best_set_volume, 2)})
    previous_session_volume = max((models.calculate_session(item).get('volume_kg', 0) for item in _all_sessions(app_ctx, uid) if item.get('status') == 'completed'), default=0)
    if calculated.get('volume_kg', 0) > previous_session_volume:
        records.append({'exercise_id': '', 'name': calculated.get('name', 'Workout'), 'type': 'session_volume', 'value': calculated.get('volume_kg', 0)})
    calculated['personal_records'] = records
    workout_repo.set_record(app_ctx.db, workout_repo.SESSION_COLLECTION, uid, calculated['id'], calculated)
    if calculated.get('occurrence_id'):
        occurrence_snapshot = workout_repo.get_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, calculated['occurrence_id'])
        if occurrence_snapshot.exists:
            occurrence = occurrence_snapshot.to_dict()
            occurrence['status'] = 'completed'
            occurrence['session_id'] = calculated['id']
            occurrence['revision'] = int(occurrence.get('revision', 0) or 0) + 1
            occurrence['updated_at'] = calculated['finished_at']
            workout_repo.set_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, occurrence['id'], occurrence)
    return app_ctx.jsonify({'ok': True, 'session': calculated, 'personal_records': records})


def discard_session(app_ctx, request, session_id):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    snapshot = workout_repo.get_record(app_ctx.db, workout_repo.SESSION_COLLECTION, uid, models.safe_id(session_id))
    if not snapshot.exists:
        return app_ctx.jsonify({'error': 'Workout session not found'}), 404
    session = snapshot.to_dict()
    if session.get('status') == 'completed':
        return app_ctx.jsonify({'error': 'Completed workouts cannot be discarded.'}), 409
    session['status'] = 'discarded'
    session['revision'] = int(session.get('revision', 0) or 0) + 1
    session['updated_at'] = models.utc_iso(app_ctx.time.time())
    workout_repo.set_record(app_ctx.db, workout_repo.SESSION_COLLECTION, uid, session['id'], session)
    if session.get('occurrence_id'):
        occurrence_snapshot = workout_repo.get_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, session['occurrence_id'])
        if occurrence_snapshot.exists:
            occurrence = occurrence_snapshot.to_dict()
            occurrence['status'] = 'planned'
            occurrence['session_id'] = ''
            occurrence['revision'] = int(occurrence.get('revision', 0) or 0) + 1
            occurrence['updated_at'] = session['updated_at']
            workout_repo.set_record(app_ctx.db, workout_repo.OCCURRENCE_COLLECTION, uid, occurrence['id'], occurrence)
    return app_ctx.jsonify({'ok': True})


def list_bodyweight(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    entries = _collection(app_ctx, workout_repo.BODYWEIGHT_COLLECTION, decoded['uid'], 500)
    return app_ctx.jsonify({'entries': sorted(entries, key=lambda item: str(item.get('date', '')))})


def upsert_bodyweight(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    payload = _json_payload(request)
    try:
        entry_date = date.fromisoformat(str(payload.get('date') or date.today().isoformat())).isoformat()
        weight = max(20, min(float(payload.get('weight_kg')), 400))
    except (TypeError, ValueError):
        return app_ctx.jsonify({'error': 'A valid date and bodyweight are required.'}), 400
    entry = {'id': entry_date, 'uid': uid, 'date': entry_date, 'weight_kg': weight, 'updated_at': models.utc_iso(app_ctx.time.time())}
    workout_repo.set_record(app_ctx.db, workout_repo.BODYWEIGHT_COLLECTION, uid, entry_date, entry)
    profile = _profile(app_ctx, uid)
    profile['bodyweight_kg'] = weight
    profile = models.sanitize_profile({}, profile, uid=uid, now_ts=app_ctx.time.time())
    workout_repo.set_profile(app_ctx.db, uid, profile)
    return app_ctx.jsonify({'ok': True, 'entry': entry, 'profile': _public_profile(profile)})


def statistics(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    profile = _profile(app_ctx, uid)
    _, _, occurrences = _active_cycle_data(app_ctx, uid, profile)
    return app_ctx.jsonify(models.build_statistics(
        _all_sessions(app_ctx, uid),
        occurrences,
        _collection(app_ctx, workout_repo.BODYWEIGHT_COLLECTION, uid, 500),
        include_warmups=bool((profile.get('settings') or {}).get('warmup_sets_in_statistics')),
    ))


def create_share(app_ctx, request):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    uid = decoded['uid']
    guard = _write_guard(app_ctx, uid)
    if guard:
        return guard
    payload = _json_payload(request)
    kind = str(payload.get('kind', '') or '').strip().lower()
    source_id = models.safe_id(payload.get('source_id'), prefix='')
    if kind not in {'routine', 'workout'} or not source_id:
        return app_ctx.jsonify({'error': 'Select a routine or completed workout to share.'}), 400
    exercises, routines = _exercise_and_routine_data(app_ctx, uid)
    exercise_lookup = {item['id']: item for item in exercises}
    if kind == 'routine':
        source = next((item for item in routines if item['id'] == source_id and not item.get('archived')), None)
        if not source:
            return app_ctx.jsonify({'error': 'Routine not found'}), 404
        snapshot = models.routine_share_snapshot(source, exercise_lookup)
    else:
        source_snapshot = workout_repo.get_record(app_ctx.db, workout_repo.SESSION_COLLECTION, uid, source_id)
        if not source_snapshot.exists or source_snapshot.to_dict().get('status') != 'completed':
            return app_ctx.jsonify({'error': 'Completed workout not found'}), 404
        snapshot = models.session_share_snapshot(source_snapshot.to_dict())
    previous_token = str(payload.get('token', '') or '').strip()
    if previous_token:
        previous = workout_repo.get_share(app_ctx.db, previous_token)
        if previous.exists and previous.to_dict().get('uid') == uid:
            revoked = previous.to_dict()
            revoked['revoked'] = True
            revoked['updated_at'] = models.utc_iso(app_ctx.time.time())
            workout_repo.set_share(app_ctx.db, previous_token, revoked)
    token = secrets.token_urlsafe(32)
    now = models.utc_iso(app_ctx.time.time())
    share = {
        'token': token,
        'id': token,
        'uid': uid,
        'owner_uid': uid,
        'kind': kind,
        'source_id': source_id,
        'snapshot': snapshot,
        'revoked': False,
        'created_at': now,
        'updated_at': now,
    }
    workout_repo.set_share(app_ctx.db, token, share)
    return app_ctx.jsonify({'ok': True, 'share': {'token': token, 'kind': kind, 'source_id': source_id, 'url': f'/workout-shares/{token}'}}), 201


def revoke_share(app_ctx, request, token):
    decoded, error, status = _auth(app_ctx, request)
    if error is not None:
        return error, status
    guard = _write_guard(app_ctx, decoded['uid'])
    if guard:
        return guard
    share_snapshot = workout_repo.get_share(app_ctx.db, str(token or '').strip())
    if not share_snapshot.exists or share_snapshot.to_dict().get('uid') != decoded['uid']:
        return app_ctx.jsonify({'error': 'Share not found'}), 404
    share = share_snapshot.to_dict()
    share['revoked'] = True
    share['updated_at'] = models.utc_iso(app_ctx.time.time())
    workout_repo.set_share(app_ctx.db, token, share)
    return app_ctx.jsonify({'ok': True})


def resolve_public_share(app_ctx, token):
    safe_token = str(token or '').strip()
    if len(safe_token) < 20 or len(safe_token) > 128:
        return None
    snapshot = workout_repo.get_share(app_ctx.db, safe_token)
    if not snapshot.exists:
        return None
    share = snapshot.to_dict()
    if share.get('revoked') or not isinstance(share.get('snapshot'), dict):
        return None
    return {'share': share['snapshot'], 'created_at': share.get('created_at', '')}


def public_share(app_ctx, token):
    share = resolve_public_share(app_ctx, token)
    if share is None:
        return app_ctx.jsonify({'error': 'Share not found'}), 404
    return app_ctx.jsonify(share)
