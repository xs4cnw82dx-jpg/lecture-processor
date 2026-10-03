"""Planner session/settings APIs with synced backend persistence."""

from __future__ import annotations

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.study import progress as study_progress
from lecture_processor.domains import planner as planner_models
from lecture_processor.services import access_service


def _require_user(app_ctx, request):
    return access_service.require_allowed_user(app_ctx, request)


def _account_write_guard(app_ctx, uid):
    allowed, message = account_lifecycle.ensure_account_allows_writes(uid, runtime=app_ctx)
    if allowed:
        return None
    return app_ctx.jsonify({'error': message, 'status': 'account_deletion_in_progress'}), 409


def get_planner_settings(app_ctx, request):
    decoded_token, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    snapshot = app_ctx.repositories.planner.get_planner_settings(app_ctx.db, uid)
    payload = planner_models.sanitize_settings_payload(snapshot.to_dict() if snapshot.exists else {}, runtime=app_ctx)
    payload['updated_at'] = float((snapshot.to_dict() if snapshot.exists else {}).get('updated_at', 0) or 0)
    return app_ctx.jsonify(payload)


def update_planner_settings(app_ctx, request):
    decoded_token, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = _account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return app_ctx.jsonify({'error': 'Invalid payload'}), 400
    existing = app_ctx.repositories.planner.get_planner_settings(app_ctx.db, uid)
    merged = planner_models.merge_settings(
        existing.to_dict() if existing.exists else {},
        payload,
        now_ts=app_ctx.time.time(),
        runtime=app_ctx,
    )
    merged['uid'] = uid
    app_ctx.repositories.planner.set_planner_settings(app_ctx.db, uid, merged, merge=False)
    return app_ctx.jsonify({'ok': True, 'settings': planner_models.sanitize_settings_payload(merged, runtime=app_ctx), 'updated_at': merged['updated_at']})


def list_planner_sessions(app_ctx, request):
    decoded_token, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    try:
        limit = int(request.args.get('limit', 200) or 200)
    except Exception:
        limit = 200
    limit = max(1, min(200, limit))
    future_only = str(request.args.get('future_only', '0') or '0').strip().lower() in {'1', 'true', 'yes', 'on'}
    tzinfo, _timezone_name = study_progress.resolve_user_timezone(uid, runtime=app_ctx)
    now = study_progress.to_timezone_now(None, tzinfo, runtime=app_ctx)
    today = now.strftime('%Y-%m-%d')
    earliest_time = now.strftime('%H:%M:%S')
    records = app_ctx.repositories.planner.list_planner_sessions_by_uid(
        app_ctx.db,
        uid,
        limit if future_only else 400,
        start_date=today if future_only else None,
        start_time=earliest_time if future_only else None,
        planned_only=future_only,
    )
    sessions = []
    for record in records:
        safe_payload, error = planner_models.sanitize_session_payload(
            record,
            session_id=record.get('id', ''),
            existing=record,
            now_ts=float(record.get('updated_at', 0) or app_ctx.time.time()),
            runtime=app_ctx,
        )
        if safe_payload is None or error:
            continue
        sessions.append(safe_payload)
    ordered = planner_models.sort_sessions(sessions, runtime=app_ctx)
    if future_only:
        # Repositories filter before limiting; keep the response defensive for
        # older adapters while comparing times in the user's local timezone.
        ordered = [item for item in ordered if item.get('status') == 'planned'
                   and (item.get('date', '') > today
                        or (item.get('date') == today and item.get('time', '') + ':00' >= earliest_time))]
    return app_ctx.jsonify({'sessions': ordered[:limit]})


def upsert_planner_session(app_ctx, request, session_id):
    decoded_token, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = _account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    payload = request.get_json(silent=True) or {}
    if not isinstance(payload, dict):
        return app_ctx.jsonify({'error': 'Invalid payload'}), 400
    safe_session_id = planner_models.sanitize_session_id(session_id, runtime=app_ctx)
    if not safe_session_id:
        return app_ctx.jsonify({'error': 'Invalid session id'}), 400
    existing = app_ctx.repositories.planner.get_planner_session(app_ctx.db, uid, safe_session_id)
    existing_payload = existing.to_dict() if existing.exists else {}
    if payload.get('status') == 'completed' and existing_payload.get('status') != 'completed':
        return app_ctx.jsonify({'error': 'Use Log study done or finish a tracked session.'}), 400
    if existing_payload.get('status') == 'completed' and payload.get('status', 'completed') != 'completed':
        return app_ctx.jsonify({'error': 'Use Reopen session to undo completion.'}), 400
    for protected in ('active_run_id', 'completion', 'completion_generation'):
        payload.pop(protected, None)
    if existing.exists and str(existing_payload.get('uid', '') or '') not in {'', uid}:
        return app_ctx.jsonify({'error': 'Forbidden'}), 403
    safe_payload, error = planner_models.sanitize_session_payload(
        payload,
        session_id=safe_session_id,
        existing=existing_payload,
        now_ts=app_ctx.time.time(),
        runtime=app_ctx,
    )
    if safe_payload is None:
        return app_ctx.jsonify({'error': error or 'Invalid session payload'}), 400
    safe_payload['uid'] = uid
    expected_revision = int(existing_payload.get('revision', 0) or 0)
    safe_payload['revision'] = expected_revision + 1
    from lecture_processor.repositories import planner_repo as planner_repository
    try:
        app_ctx.repositories.planner.set_planner_session_if_revision(app_ctx.db, uid, safe_session_id, safe_payload, expected_revision)
    except planner_repository.PlannerRevisionConflict:
        return app_ctx.jsonify({'error': 'This session changed in another tab.', 'code': 'revision_conflict'}), 409
    return app_ctx.jsonify({'ok': True, 'session': safe_payload})


def delete_planner_session(app_ctx, request, session_id):
    decoded_token, error_response, status = _require_user(app_ctx, request)
    if error_response is not None:
        return error_response, status
    uid = decoded_token['uid']
    deletion_guard = _account_write_guard(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard
    safe_session_id = planner_models.sanitize_session_id(session_id, runtime=app_ctx)
    if not safe_session_id:
        return app_ctx.jsonify({'error': 'Invalid session id'}), 400
    app_ctx.repositories.planner.delete_planner_session(app_ctx.db, uid, safe_session_id)
    return app_ctx.jsonify({'ok': True})
