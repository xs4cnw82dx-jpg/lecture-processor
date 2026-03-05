"""Business logic handlers for auth/account APIs."""

from datetime import datetime, timezone, timedelta
import io
import json
import time
import zipfile

from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.auth import session as auth_session
from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.shared import parsing as shared_parsing
from lecture_processor.domains.study import audio as study_audio
from lecture_processor.domains.study import export as study_export


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
    client_ip = request.remote_addr or 'unknown'
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

    actor_token = uid or session_id or request.headers.get('X-Forwarded-For', request.remote_addr or '')
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
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    try:
        payload = account_lifecycle.collect_user_export_payload(uid, email, runtime=app_ctx)
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


def export_account_bundle(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    payload = request.get_json(silent=True) or {}
    scope = str(payload.get('scope', 'account') or 'account').strip().lower()
    if scope != 'account':
        return app_ctx.jsonify({'error': 'Only account scope is supported.'}), 400

    include = account_lifecycle.normalize_export_bundle_include(payload.get('include', {}), runtime=app_ctx)
    if not account_lifecycle.has_export_bundle_selection(include, runtime=app_ctx):
        return app_ctx.jsonify({'error': 'Select at least one export option.'}), 400

    packs = []
    if any(
        include.get(key)
        for key in (
            'flashcards_csv',
            'practice_tests_csv',
            'lecture_notes_docx',
            'lecture_notes_pdf_marked',
            'lecture_notes_pdf_unmarked',
        )
    ):
        docs = app_ctx.study_repo.list_study_packs_by_uid(
            app_ctx.db,
            uid,
            app_ctx.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION + 1,
        )
        packs = docs[: app_ctx.ACCOUNT_EXPORT_MAX_DOCS_PER_COLLECTION]

    folder_map = {
        'flashcards_csv': 'flashcards_csv',
        'practice_tests_csv': 'practice_tests_csv',
        'lecture_notes_docx': 'lecture_notes_docx',
        'lecture_notes_pdf_marked': 'lecture_notes_pdf_marked',
        'lecture_notes_pdf_unmarked': 'lecture_notes_pdf_unmarked',
        'account_json': 'account_json',
    }

    archive_bytes = io.BytesIO()
    try:
        with zipfile.ZipFile(archive_bytes, mode='w', compression=zipfile.ZIP_DEFLATED) as archive:
            for key, folder in folder_map.items():
                if include.get(key):
                    archive.writestr(folder + '/', '')

            for doc in packs:
                pack = doc.to_dict() or {}
                pack_id = str(pack.get('study_pack_id', '') or doc.id or '').strip() or str(doc.id)
                safe_title = study_export.sanitize_export_filename(
                    pack.get('title', '') or pack_id,
                    fallback=pack_id,
                )

                if include.get('flashcards_csv'):
                    csv_bytes = study_export.build_flashcards_csv_bytes(pack, runtime=app_ctx)
                    if csv_bytes:
                        archive.writestr(f'flashcards_csv/{safe_title}-{pack_id}.csv', csv_bytes)

                if include.get('practice_tests_csv'):
                    test_bytes = study_export.build_practice_test_csv_bytes(pack, runtime=app_ctx)
                    if test_bytes:
                        archive.writestr(f'practice_tests_csv/{safe_title}-{pack_id}.csv', test_bytes)

                if include.get('lecture_notes_docx'):
                    docx_bytes = study_export.build_notes_docx_bytes(pack, runtime=app_ctx)
                    if docx_bytes:
                        archive.writestr(f'lecture_notes_docx/{safe_title}-{pack_id}.docx', docx_bytes)

                if include.get('lecture_notes_pdf_marked'):
                    pdf_marked = study_export.build_notes_pdf_bytes(pack, include_answers=True, runtime=app_ctx)
                    if pdf_marked:
                        archive.writestr(f'lecture_notes_pdf_marked/{safe_title}-{pack_id}-marked.pdf', pdf_marked)

                if include.get('lecture_notes_pdf_unmarked'):
                    pdf_unmarked = study_export.build_notes_pdf_bytes(pack, include_answers=False, runtime=app_ctx)
                    if pdf_unmarked:
                        archive.writestr(f'lecture_notes_pdf_unmarked/{safe_title}-{pack_id}-unmarked.pdf', pdf_unmarked)

            if include.get('account_json'):
                account_payload = account_lifecycle.collect_user_export_payload(uid, email, runtime=app_ctx)
                account_bytes = json.dumps(account_payload, ensure_ascii=False, indent=2, default=str).encode('utf-8')
                archive.writestr('account_json/account-export.json', account_bytes)
    except RuntimeError as error:
        return app_ctx.jsonify({'error': str(error)}), 500
    except Exception as error:
        app_ctx.logger.error(f"Error building export bundle for {uid}: {error}")
        return app_ctx.jsonify({'error': 'Could not build export bundle'}), 500

    archive_bytes.seek(0)
    filename = f"lecture-processor-export-{datetime.now(timezone.utc).strftime('%Y-%m-%d')}.zip"
    return app_ctx.send_file(
        archive_bytes,
        mimetype='application/zip',
        as_attachment=True,
        download_name=filename,
    )


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

    active_jobs = account_lifecycle.count_active_jobs_for_user(uid, runtime=app_ctx)
    if active_jobs > 0:
        return app_ctx.jsonify({
            'error': f'Cannot delete account while {active_jobs} processing job(s) are still active. Please wait until processing finishes.'
        }), 409

    try:
        deleted = {}
        truncated = {}
        warnings_list = []
        job_ids = set()

        job_log_docs, job_logs_truncated = account_lifecycle.list_docs_by_uid(
            'job_logs',
            uid,
            app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION,
            runtime=app_ctx,
        )
        truncated['job_logs'] = job_logs_truncated
        for item in job_log_docs:
            jid = str(item.get('job_id', '') or item.get('_id', '')).strip()
            if jid:
                job_ids.add(jid)

        deleted_job_logs, _ = account_lifecycle.delete_docs_by_uid(
            'job_logs',
            uid,
            app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION,
            runtime=app_ctx,
        )
        deleted['job_logs'] = deleted_job_logs

        anonymized_purchases, purchases_truncated = account_lifecycle.anonymize_purchase_docs_by_uid(
            uid,
            app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION,
            runtime=app_ctx,
        )
        deleted_analytics, analytics_truncated = account_lifecycle.delete_docs_by_uid(
            'analytics_events',
            uid,
            app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION,
            runtime=app_ctx,
        )
        deleted_folders, folders_truncated = account_lifecycle.delete_docs_by_uid(
            'study_folders',
            uid,
            app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION,
            runtime=app_ctx,
        )
        deleted_card_states, card_states_truncated = account_lifecycle.delete_docs_by_uid(
            'study_card_states',
            uid,
            app_ctx.ACCOUNT_DELETE_MAX_DOCS_PER_COLLECTION,
            runtime=app_ctx,
        )
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

            if study_audio.remove_pack_audio_file(pack, runtime=app_ctx):
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

        deleted['upload_artifacts'] = account_lifecycle.remove_upload_artifacts_for_job_ids(job_ids, runtime=app_ctx)

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
