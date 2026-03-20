"""Shared helpers for upload batch and audio-import routes."""

import json

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.billing import credits as billing_credits
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.upload import import_audio as upload_import_audio


def sanitize_study_pack_title(raw_title, max_chars=120):
    text = str(raw_title or '').strip()
    if not text:
        return ''
    collapsed = ' '.join(text.split())
    return collapsed[:max_chars].strip()


def require_ai_processing_ready(app_ctx):
    if getattr(app_ctx, 'client', None) is not None:
        return None
    app_ctx.logger.error('AI processing requested while Gemini client is not configured.')
    return app_ctx.jsonify({'error': 'AI processing is temporarily unavailable right now. Please try again later.'}), 503


def account_write_guard_response(app_ctx, uid):
    allowed, message = account_lifecycle.ensure_account_allows_writes(uid, runtime=app_ctx)
    if allowed:
        return None
    return app_ctx.jsonify({'error': message, 'status': 'account_deletion_in_progress'}), 409


def attempt_credit_refund(app_ctx, uid, credit_type, expected_floor=None):
    if not uid or not credit_type:
        return False, ''

    expected_floor_value = None
    if expected_floor is not None:
        try:
            expected_floor_value = max(0, int(expected_floor))
        except Exception:
            expected_floor_value = None

    for attempt in range(1, 4):
        try:
            refunded = bool(billing_credits.refund_credit(uid, credit_type, runtime=app_ctx))
        except Exception:
            refunded = False
        if refunded:
            if credit_type == 'slides_credits' and expected_floor_value is not None:
                try:
                    latest_user = app_ctx.get_or_create_user(uid, '')
                    latest_balance = int(latest_user.get('slides_credits', 0) or 0)
                    if latest_balance < expected_floor_value:
                        app_ctx.logger.warning(
                            "Refund reported success but balance verification failed for %s (balance=%s expected>=%s)",
                            uid,
                            latest_balance,
                            expected_floor_value,
                        )
                        if attempt < 3:
                            app_ctx.time.sleep(0.08 * attempt)
                            continue
                except Exception:
                    pass
            return True, 'refund_credit'
        if attempt < 3:
            app_ctx.time.sleep(0.08 * attempt)

    if credit_type == 'slides_credits':
        for fallback_attempt in range(1, 3):
            try:
                refunded = bool(billing_credits.refund_slides_credits(uid, 1, runtime=app_ctx))
                if not refunded:
                    if fallback_attempt < 2:
                        app_ctx.time.sleep(0.08 * fallback_attempt)
                    continue
                try:
                    user_ref = app_ctx.users_repo.doc_ref(app_ctx.db, uid)
                    user_ref.update({'total_processed': app_ctx.firestore.Increment(-1)})
                except Exception:
                    pass
                return True, 'fallback_slides_refund'
            except Exception:
                if fallback_attempt < 2:
                    app_ctx.time.sleep(0.08 * fallback_attempt)

    return False, ''


def queue_full_message():
    return 'The server is busy right now. Please try again in a minute.'


def queue_full_response(app_ctx, *, job_id='', batch_id=''):
    retry_after_seconds = 15
    payload = {
        'error': queue_full_message(),
        'status': 'queue_full',
        'retry_after_seconds': retry_after_seconds,
    }
    if job_id:
        payload['job_id'] = str(job_id)
    if batch_id:
        payload['batch_id'] = str(batch_id)
    try:
        queue_stats = app_ctx.get_background_queue_stats()
    except Exception:
        queue_stats = {}
    if isinstance(queue_stats, dict) and queue_stats:
        payload['queue'] = {
            'running': int(queue_stats.get('running', 0) or 0),
            'queued': int(queue_stats.get('queued', 0) or 0),
            'capacity': int(queue_stats.get('capacity', 0) or 0),
        }
    response = app_ctx.jsonify(payload)
    response.status_code = 503
    response.headers['Retry-After'] = str(retry_after_seconds)
    return response


def handle_runtime_job_queue_full(
    app_ctx,
    *,
    job_id,
    uid,
    cleanup_paths,
    credit_type='',
    expected_credit_floor=None,
    extra_slides_credits=0,
):
    message = queue_full_message()
    refund_methods = []
    credit_refunded = False
    if credit_type:
        refunded, method = attempt_credit_refund(
            app_ctx,
            uid,
            credit_type,
            expected_floor=expected_credit_floor,
        )
        if refunded:
            credit_refunded = True
            if method:
                refund_methods.append(method)
    if int(extra_slides_credits or 0) > 0:
        try:
            extras_refunded = bool(
                billing_credits.refund_slides_credits(
                    uid,
                    int(extra_slides_credits or 0),
                    runtime=app_ctx,
                )
            )
        except Exception:
            extras_refunded = False
        if extras_refunded:
            credit_refunded = True
            refund_methods.append('refund_slides_credits')
    runtime_jobs_store.update_job_fields(
        job_id,
        runtime=app_ctx,
        status='error',
        error=message,
        failed_stage='queued',
        provider_error_code='queue_full',
        step_description='Queue full',
        credit_refunded=credit_refunded,
        credit_refund_method=', '.join(refund_methods),
    )
    app_ctx.cleanup_files(list(cleanup_paths or []), [])
    return queue_full_response(app_ctx, job_id=job_id)


def parse_batch_rows_payload(request):
    rows_raw = str(request.form.get('rows', '') or '').strip()
    if not rows_raw:
        return []
    try:
        parsed = json.loads(rows_raw)
    except Exception:
        return None
    if not isinstance(parsed, list):
        return None
    rows = []
    for item in parsed:
        if not isinstance(item, dict):
            continue
        rows.append(dict(item))
    return rows


def parse_checkbox_value(raw_value):
    return str(raw_value or '').strip().lower() in {'1', 'true', 'yes', 'on'}


def batch_user_guard(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return None, None, app_ctx.jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not auth_policy.is_email_allowed(email, runtime=app_ctx):
        return None, None, app_ctx.jsonify({'error': 'Email not allowed'}), 403
    return uid, decoded_token, None, None


def get_batch_with_permission(app_ctx, request, batch_id, *, batch_orchestrator_module):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return None, None, app_ctx.jsonify({'error': 'Unauthorized'}), 401
    batch = batch_orchestrator_module.get_batch(batch_id, runtime=app_ctx)
    if not batch:
        return None, None, app_ctx.jsonify({'error': 'Batch not found'}), 404
    uid = decoded_token.get('uid', '')
    if batch.get('uid', '') != uid and not app_ctx.is_admin_user(decoded_token):
        return None, None, app_ctx.jsonify({'error': 'Forbidden'}), 403
    return batch, decoded_token, None, None


def validate_import_token_or_release(uid, token, runtime=None, consume=False):
    return upload_import_audio.get_audio_import_token_path(
        uid,
        token,
        consume=consume,
        runtime=runtime,
    )
