"""Business logic handlers for auth/account APIs."""

from datetime import timedelta
import time

from lecture_processor.services import account_data_service
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.auth import session as auth_session
from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.shared import parsing as shared_parsing


def create_admin_session(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    if not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403

    id_token = auth_session._extract_bearer_token(request, runtime=app_ctx)
    if not id_token:
        return app_ctx.jsonify({'error': 'Missing ID token'}), 400

    try:
        session_cookie = app_ctx.auth.create_session_cookie(
            id_token,
            expires_in=timedelta(seconds=app_ctx.ADMIN_SESSION_DURATION_SECONDS),
        )
        response = app_ctx.jsonify({'ok': True})
        response.set_cookie(
            app_ctx.ADMIN_SESSION_COOKIE_NAME,
            session_cookie,
            max_age=app_ctx.ADMIN_SESSION_DURATION_SECONDS,
            httponly=True,
            secure=bool(request.is_secure or app_ctx.os.getenv('RENDER')),
            samesite='Lax',
            path='/',
        )
        return response
    except Exception as e:
        app_ctx.logger.error(f"Error creating admin session cookie: {e}")
        return app_ctx.jsonify({'error': 'Could not create admin session'}), 500


def clear_admin_session(app_ctx, request):
    response = app_ctx.jsonify({'ok': True})
    response.set_cookie(
        app_ctx.ADMIN_SESSION_COOKIE_NAME,
        '',
        expires=0,
        max_age=0,
        httponly=True,
        secure=bool(request.is_secure or app_ctx.os.getenv('RENDER')),
        samesite='Lax',
        path='/',
    )
    return response


def verify_email(app_ctx, request):
    client_ip = app_ctx.get_client_ip(request)
    allowed_rl, retry_after_rl = rate_limiter.check_rate_limit(
        key=f"verify_email:{client_ip}",
        limit=20,
        window_seconds=60,
        runtime=app_ctx,
    )
    if not allowed_rl:
        return rate_limiter.build_rate_limited_response(
            'Too many verification requests. Please wait.',
            retry_after_rl,
            runtime=app_ctx,
        )
    payload = request.get_json(silent=True) or {}
    email = payload.get('email', '')
    if auth_policy.is_email_allowed(email, runtime=app_ctx):
        return app_ctx.jsonify({'allowed': True})
    return app_ctx.jsonify({
        'allowed': False,
        'message': 'Please use your university email or a major email provider (Gmail, Outlook, iCloud, Yahoo).',
    })


def dev_sentry_test(app_ctx, request):
    if not app_ctx.is_dev_environment():
        return app_ctx.jsonify({'error': 'Not found'}), 404
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    if not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403
    if not app_ctx.sentry_sdk or not app_ctx.SENTRY_BACKEND_DSN:
        return app_ctx.jsonify({'error': 'Sentry backend DSN is not configured'}), 400

    payload = request.get_json(silent=True) or {}
    note = str(payload.get('message', 'Manual backend Sentry test')).strip()[:120]
    try:
        raise RuntimeError(f"Sentry dev test trigger: {note}")
    except Exception as exc:
        event_id = app_ctx.sentry_sdk.capture_exception(exc)
        return app_ctx.jsonify({
            'ok': True,
            'event_id': event_id,
            'message': 'Sentry test event captured from backend',
        })


def ingest_analytics_event(app_ctx, request):
    data = request.get_json(silent=True) or {}
    decoded_token = app_ctx.verify_firebase_token(request)
    uid = decoded_token.get('uid', '') if decoded_token else ''
    email = decoded_token.get('email', '') if decoded_token else ''
    session_id = analytics_events.sanitize_analytics_session_id(
        data.get('session_id', ''),
        runtime=app_ctx,
    )
    if not session_id and uid:
        session_id = uid[:80]

    actor_token = uid or session_id or app_ctx.get_client_ip(request)
    actor_key = rate_limiter.normalize_rate_limit_key_part(actor_token, fallback='anon', runtime=app_ctx)
    allowed_analytics, retry_after = rate_limiter.check_rate_limit(
        key=f"analytics:{actor_key}",
        limit=app_ctx.ANALYTICS_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.ANALYTICS_RATE_LIMIT_WINDOW_SECONDS,
        runtime=app_ctx,
    )
    if not allowed_analytics:
        analytics_events.log_rate_limit_hit('analytics', retry_after, runtime=app_ctx)
        return rate_limiter.build_rate_limited_response(
            'Too many analytics events from this client. Please retry shortly.',
            retry_after,
            runtime=app_ctx,
        )

    event_name = analytics_events.sanitize_analytics_event_name(data.get('event', ''), runtime=app_ctx)
    if not event_name:
        return app_ctx.jsonify({'error': 'Invalid event name'}), 400

    properties = analytics_events.sanitize_analytics_properties(data.get('properties', {}), runtime=app_ctx)
    properties['path'] = str(data.get('path', '') or '').strip()[:80]
    properties['page'] = str(data.get('page', '') or '').strip()[:40]

    ok = analytics_events.log_analytics_event(
        event_name,
        source='frontend',
        uid=uid,
        email=email,
        session_id=session_id,
        properties=properties,
        runtime=app_ctx,
    )
    if not ok:
        return app_ctx.jsonify({'error': 'Could not store event'}), 500
    return app_ctx.jsonify({'ok': True})


def get_user(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not auth_policy.is_email_allowed(email, runtime=app_ctx):
        return app_ctx.jsonify({'error': 'Email not allowed', 'message': 'Please use your university email.'}), 403
    user = app_ctx.get_or_create_user(uid, email)
    preferences = shared_parsing.build_user_preferences_payload(user, runtime=app_ctx)
    return app_ctx.jsonify({
        'uid': user['uid'], 'email': user['email'],
        'credits': {
            'lecture_standard': user.get('lecture_credits_standard', 0),
            'lecture_extended': user.get('lecture_credits_extended', 0),
            'slides': user.get('slides_credits', 0),
            'interview_short': user.get('interview_credits_short', 0),
            'interview_medium': user.get('interview_credits_medium', 0),
            'interview_long': user.get('interview_credits_long', 0),
        },
        'total_processed': user.get('total_processed', 0),
        'has_created_study_pack': bool(user.get('has_created_study_pack', bool(user.get('total_processed', 0)))),
        'is_admin': app_ctx.is_admin_user(decoded_token),
        'preferences': preferences,
    })


def get_user_preferences(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not auth_policy.is_email_allowed(email, runtime=app_ctx):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403
    user = app_ctx.get_or_create_user(uid, email)
    return app_ctx.jsonify({'preferences': shared_parsing.build_user_preferences_payload(user, runtime=app_ctx)})


def update_user_preferences(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not auth_policy.is_email_allowed(email, runtime=app_ctx):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403

    payload = request.get_json(silent=True) or {}
    user = app_ctx.get_or_create_user(uid, email)

    raw_key = payload.get('output_language', user.get('preferred_output_language', app_ctx.DEFAULT_OUTPUT_LANGUAGE_KEY))
    raw_custom = payload.get('output_language_custom', user.get('preferred_output_language_custom', ''))
    pref_key = shared_parsing.sanitize_output_language_pref_key(raw_key, runtime=app_ctx)
    pref_custom = shared_parsing.sanitize_output_language_pref_custom(raw_custom, runtime=app_ctx)

    if pref_key == 'other' and not pref_custom:
        return app_ctx.jsonify({'error': 'Custom language is required when output language is Other.'}), 400
    if pref_key != 'other':
        pref_custom = ''

    updates = {
        'preferred_output_language': pref_key,
        'preferred_output_language_custom': pref_custom,
        'updated_at': time.time(),
    }
    if 'onboarding_completed' in payload:
        updates['onboarding_completed'] = bool(payload.get('onboarding_completed'))

    try:
        app_ctx.users_repo.set_doc(app_ctx.db, uid, updates, merge=True)
        user.update(updates)
        return app_ctx.jsonify({'ok': True, 'preferences': shared_parsing.build_user_preferences_payload(user, runtime=app_ctx)})
    except Exception as e:
        app_ctx.logger.error(f"Error updating preferences for user {uid}: {e}")
        return app_ctx.jsonify({'error': 'Could not save preferences'}), 500


def export_account_data(app_ctx, request):
    return account_data_service.export_account_data(app_ctx, request)


def export_account_bundle(app_ctx, request):
    return account_data_service.export_account_bundle(app_ctx, request)


def delete_account_data(app_ctx, request):
    return account_data_service.delete_account_data(app_ctx, request)
