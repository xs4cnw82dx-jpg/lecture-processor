"""Business logic handlers for auth/account APIs."""

from datetime import datetime, timezone, timedelta
import io
import json
import time


def create_admin_session(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    if not app_ctx.is_admin_user(decoded_token):
        return app_ctx.jsonify({'error': 'Forbidden'}), 403

    id_token = app_ctx._extract_bearer_token(request)
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
    client_ip = request.remote_addr or 'unknown'
    allowed_rl, retry_after_rl = app_ctx.check_rate_limit(
        key=f"verify_email:{client_ip}",
        limit=20,
        window_seconds=60,
    )
    if not allowed_rl:
        return app_ctx.build_rate_limited_response('Too many verification requests. Please wait.', retry_after_rl)
    email = request.get_json().get('email', '')
    if app_ctx.is_email_allowed(email):
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
    session_id = app_ctx.sanitize_analytics_session_id(data.get('session_id', ''))
    if not session_id and uid:
        session_id = uid[:80]

    actor_token = uid or session_id or request.headers.get('X-Forwarded-For', request.remote_addr or '')
    actor_key = app_ctx.normalize_rate_limit_key_part(actor_token, fallback='anon')
    allowed_analytics, retry_after = app_ctx.check_rate_limit(
        key=f"analytics:{actor_key}",
        limit=app_ctx.ANALYTICS_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.ANALYTICS_RATE_LIMIT_WINDOW_SECONDS,
    )
    if not allowed_analytics:
        app_ctx.log_rate_limit_hit('analytics', retry_after)
        return app_ctx.build_rate_limited_response(
            'Too many analytics events from this client. Please retry shortly.',
            retry_after,
        )

    event_name = app_ctx.sanitize_analytics_event_name(data.get('event', ''))
    if not event_name:
        return app_ctx.jsonify({'error': 'Invalid event name'}), 400

    properties = app_ctx.sanitize_analytics_properties(data.get('properties', {}))
    properties['path'] = str(data.get('path', '') or '').strip()[:80]
    properties['page'] = str(data.get('page', '') or '').strip()[:40]

    ok = app_ctx.log_analytics_event(
        event_name,
        source='frontend',
        uid=uid,
        email=email,
        session_id=session_id,
        properties=properties,
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
    if not app_ctx.is_email_allowed(email):
        return app_ctx.jsonify({'error': 'Email not allowed', 'message': 'Please use your university email.'}), 403
    user = app_ctx.get_or_create_user(uid, email)
    preferences = app_ctx.build_user_preferences_payload(user)
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
        'is_admin': app_ctx.is_admin_user(decoded_token),
        'preferences': preferences,
    })


def get_user_preferences(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not app_ctx.is_email_allowed(email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403
    user = app_ctx.get_or_create_user(uid, email)
    return app_ctx.jsonify({'preferences': app_ctx.build_user_preferences_payload(user)})


def update_user_preferences(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not app_ctx.is_email_allowed(email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403

    payload = request.get_json(silent=True) or {}
    user = app_ctx.get_or_create_user(uid, email)

    raw_key = payload.get('output_language', user.get('preferred_output_language', app_ctx.DEFAULT_OUTPUT_LANGUAGE_KEY))
    raw_custom = payload.get('output_language_custom', user.get('preferred_output_language_custom', ''))
    pref_key = app_ctx.sanitize_output_language_pref_key(raw_key)
    pref_custom = app_ctx.sanitize_output_language_pref_custom(raw_custom)

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
        return app_ctx.jsonify({'ok': True, 'preferences': app_ctx.build_user_preferences_payload(user)})
    except Exception as e:
        app_ctx.logger.error(f"Error updating preferences for user {uid}: {e}")
        return app_ctx.jsonify({'error': 'Could not save preferences'}), 500


def export_account_data(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    try:
        payload = app_ctx.collect_user_export_payload(uid, email)
        date_str = datetime.now(timezone.utc).strftime('%Y-%m-%d')
        filename = f"lecture-processor-account-export-{date_str}.json"
        data_bytes = json.dumps(payload, ensure_ascii=False, indent=2, default=str).encode('utf-8')
        file_obj = io.BytesIO(data_bytes)
        file_obj.seek(0)
        return app_ctx.send_file(
            file_obj,
            mimetype='application/json',
            as_attachment=True,
            download_name=filename,
        )
    except Exception as e:
        app_ctx.logger.error(f"Error exporting account data for {uid}: {e}")
        return app_ctx.jsonify({'error': 'Could not export account data'}), 500


def delete_account_data(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    email = str(decoded_token.get('email', '') or '').strip().lower()
    payload = request.get_json(silent=True) or {}

    confirm_text = str(payload.get('confirm_text', '') or '').strip().upper()
    if confirm_text != 'DELETE MY ACCOUNT':
        return app_ctx.jsonify({'error': 'Invalid confirmation text. Type DELETE MY ACCOUNT exactly.'}), 400

    confirm_email = str(payload.get('confirm_email', '') or '').strip().lower()
    if email and confirm_email != email:
        return app_ctx.jsonify({'error': 'Confirmation email does not match your account email.'}), 400

    active_jobs = app_ctx.count_active_jobs_for_user(uid)
    if active_jobs > 0:
        return app_ctx.jsonify({
            'error': f'Cannot delete account while {active_jobs} processing job(s) are still active. Please wait until processing finishes.'
        }), 409

    try:
        deleted = {}
        truncated = {}
        warnings_list = []
        job_ids = set()

        job_log_docs, job_logs_truncated = app_ctx.list_docs_by_uid('job_logs', uid, app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        truncated['job_logs'] = job_logs_truncated
        for item in job_log_docs:
            jid = str(item.get('job_id', '') or item.get('_id', '')).strip()
            if jid:
                job_ids.add(jid)

        deleted_job_logs, _ = app_ctx.delete_docs_by_uid('job_logs', uid, app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        deleted['job_logs'] = deleted_job_logs

        anonymized_purchases, purchases_truncated = app_ctx.anonymize_purchase_docs_by_uid(uid, app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        deleted_analytics, analytics_truncated = app_ctx.delete_docs_by_uid('analytics_events', uid, app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        deleted_folders, folders_truncated = app_ctx.delete_docs_by_uid('study_folders', uid, app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        deleted_card_states, card_states_truncated = app_ctx.delete_docs_by_uid('study_card_states', uid, app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION)
        truncated['purchases'] = purchases_truncated
        truncated['analytics_events'] = analytics_truncated
        truncated['study_folders'] = folders_truncated
        truncated['study_card_states'] = card_states_truncated
        deleted['purchases_anonymized'] = anonymized_purchases
        deleted['analytics_events'] = deleted_analytics
        deleted['study_folders'] = deleted_folders
        deleted['study_card_states'] = deleted_card_states

        study_pack_docs = app_ctx.study_repo.list_study_packs_by_uid(app_ctx.db, uid, app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION + 1)
        truncated['study_packs'] = len(study_pack_docs) > app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION
        study_pack_docs = study_pack_docs[:app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION]

        deleted_study_packs = 0
        deleted_pack_audio_files = 0
        deleted_pack_progress_states = 0
        for doc in study_pack_docs:
            pack = doc.to_dict() or {}
            pack_id = doc.id
            job_id = str(pack.get('source_job_id', '') or '').strip()
            if job_id:
                job_ids.add(job_id)

            if app_ctx.remove_pack_audio_file(pack):
                deleted_pack_audio_files += 1

            try:
                app_ctx.get_study_card_state_doc(uid, pack_id).delete()
                deleted_pack_progress_states += 1
            except Exception:
                pass

            try:
                doc.reference.delete()
                deleted_study_packs += 1
            except Exception as e:
                warnings_list.append(f"Could not delete study pack {pack_id}: {e}")

        deleted['study_packs'] = deleted_study_packs
        deleted['study_pack_audio_files'] = deleted_pack_audio_files
        deleted['study_pack_progress_states'] = deleted_pack_progress_states

        try:
            app_ctx.get_study_progress_doc(uid).delete()
            deleted['study_progress_doc'] = 1
        except Exception:
            deleted['study_progress_doc'] = 0

        try:
            app_ctx.users_repo.delete_doc(app_ctx.db, uid)
            deleted['user_profile_doc'] = 1
        except Exception:
            deleted['user_profile_doc'] = 0

        removed_in_memory_jobs = 0
        with app_ctx.JOBS_LOCK:
            for jid, job_data in list(app_ctx.jobs.items()):
                if str(job_data.get('user_id', '') or '') != uid:
                    continue
                job_ids.add(jid)
                try:
                    del app_ctx.jobs[jid]
                    removed_in_memory_jobs += 1
                except Exception:
                    pass
        deleted['in_memory_jobs'] = removed_in_memory_jobs

        deleted['upload_artifacts'] = app_ctx.remove_upload_artifacts_for_job_ids(job_ids)

        auth_user_deleted = False
        try:
            app_ctx.auth.delete_user(uid)
            auth_user_deleted = True
        except Exception as e:
            warnings_list.append(f"Could not delete Firebase Auth user: {e}")

        return app_ctx.jsonify({
            'ok': True,
            'auth_user_deleted': auth_user_deleted,
            'deleted': deleted,
            'truncated': truncated,
            'warnings': warnings_list,
        })
    except Exception as e:
        app_ctx.logger.error(f"Error deleting account data for {uid}: {e}")
        return app_ctx.jsonify({'error': 'Could not delete account data'}), 500
