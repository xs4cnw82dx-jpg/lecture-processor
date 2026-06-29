"""Audio import routes extracted from upload API service."""

from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.upload import import_audio as upload_import_audio
from lecture_processor.runtime.job_dispatcher import JobQueueFullError

from lecture_processor.services import upload_batch_support, upload_quota_service, upload_redaction_service


def _audio_import_job_store(app_ctx):
    return getattr(app_ctx, 'AUDIO_IMPORT_JOBS', {})


def _audio_import_job_lock(app_ctx):
    return getattr(app_ctx, 'AUDIO_IMPORT_JOB_LOCK', getattr(app_ctx, 'AUDIO_IMPORT_LOCK', None))


def _audio_import_job_ttl(app_ctx):
    return int(getattr(app_ctx, 'AUDIO_IMPORT_JOB_TTL_SECONDS', 2 * 60 * 60) or (2 * 60 * 60))


def _cleanup_expired_audio_import_jobs(app_ctx):
    store = _audio_import_job_store(app_ctx)
    lock = _audio_import_job_lock(app_ctx)
    if lock is None:
        return
    now_ts = app_ctx.time.time()
    ttl = _audio_import_job_ttl(app_ctx)
    with lock:
        for job_id, job in list(store.items()):
            status = str(job.get('status', '') or '')
            updated_at = float(job.get('updated_at', job.get('created_at', 0)) or 0)
            if status not in {'queued', 'processing'} and now_ts - updated_at > ttl:
                store.pop(job_id, None)


def _set_audio_import_job(app_ctx, job_id, **updates):
    store = _audio_import_job_store(app_ctx)
    lock = _audio_import_job_lock(app_ctx)
    now_ts = app_ctx.time.time()
    if lock is None:
        return {}
    with lock:
        job = dict(store.get(job_id, {}))
        job.setdefault('job_id', job_id)
        job.setdefault('created_at', now_ts)
        job.update(updates)
        job['updated_at'] = now_ts
        store[job_id] = job
        return dict(job)


def _get_audio_import_job(app_ctx, uid, job_id):
    _cleanup_expired_audio_import_jobs(app_ctx)
    store = _audio_import_job_store(app_ctx)
    lock = _audio_import_job_lock(app_ctx)
    if lock is None:
        return None
    safe_job_id = str(job_id or '').strip()
    safe_uid = str(uid or '').strip()
    with lock:
        job = dict(store.get(safe_job_id, {}))
    if not job or str(job.get('uid', '') or '') != safe_uid:
        return None
    return job


def _audio_import_job_payload(job):
    status = str((job or {}).get('status', 'queued') or 'queued')
    payload = {
        'ok': status == 'complete',
        'job_id': str((job or {}).get('job_id', '') or ''),
        'status': status,
        'step_description': str((job or {}).get('step_description', '') or ''),
        'created_at': (job or {}).get('created_at', 0),
        'updated_at': (job or {}).get('updated_at', 0),
    }
    if status == 'complete':
        payload.update({
            'audio_import_token': str((job or {}).get('audio_import_token', '') or ''),
            'file_name': str((job or {}).get('file_name', '') or ''),
            'size_bytes': int((job or {}).get('size_bytes', 0) or 0),
            'expires_in_seconds': int((job or {}).get('expires_in_seconds', 0) or 0),
        })
    if status == 'error':
        payload['error'] = str((job or {}).get('error', '') or 'Could not import audio from URL.')
    return payload


def _run_audio_import_job(app_ctx, job_id, uid, fetch_target, prefix, quota_reservation):
    audio_path = ''
    _set_audio_import_job(
        app_ctx,
        job_id,
        status='processing',
        step_description='Importing audio from URL...',
    )
    try:
        audio_path, output_name, size_bytes = app_ctx.download_audio_from_video_url(fetch_target, prefix)
        actual_size = int(size_bytes or app_ctx.get_saved_file_size(audio_path) or 0)
        quota_error, _quota_error_status = upload_quota_service.adjust_reserved_upload_bytes(
            app_ctx,
            quota_reservation,
            actual_size,
            context='Audio URL import',
        )
        if quota_error is not None:
            app_ctx.cleanup_files([audio_path], [])
            _set_audio_import_job(
                app_ctx,
                job_id,
                status='error',
                step_description='Audio import failed.',
                error='Imported audio could not be stored because the upload quota or server storage limit was reached.',
            )
            return
        token = upload_import_audio.register_audio_import_token(
            uid,
            audio_path,
            upload_redaction_service.redact_source_url(upload_import_audio.resolved_url(fetch_target)),
            output_name,
            runtime=app_ctx,
        )
        upload_quota_service.mark_audio_import_token_quota(
            uid,
            token,
            actual_size,
            runtime=app_ctx,
        )
        upload_quota_service.commit_upload_quota(quota_reservation)
        _set_audio_import_job(
            app_ctx,
            job_id,
            status='complete',
            step_description='Audio import ready.',
            audio_import_token=token,
            file_name=output_name,
            size_bytes=actual_size,
            expires_in_seconds=app_ctx.AUDIO_IMPORT_TOKEN_TTL_SECONDS,
        )
    except Exception as error:
        if audio_path:
            app_ctx.cleanup_files([audio_path], [])
        app_ctx.logger.error(
            'Error importing audio from URL for user %s: %s',
            uid,
            upload_redaction_service.redact_exception(error, max_chars=500),
        )
        _set_audio_import_job(
            app_ctx,
            job_id,
            status='error',
            step_description='Audio import failed.',
            error='Could not import audio from URL. Please check that the URL is accessible and try again.',
        )
    finally:
        upload_quota_service.release_uncommitted_upload_quota(app_ctx, quota_reservation)


def import_audio_from_url(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not auth_policy.is_email_allowed(email, runtime=app_ctx):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403
    deletion_guard = upload_batch_support.account_write_guard_response(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard

    allowed_import, retry_after = rate_limiter.check_rate_limit(
        key=f"audio_import:{rate_limiter.normalize_rate_limit_key_part(uid, fallback='anon_uid', runtime=app_ctx)}",
        limit=app_ctx.VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS,
        runtime=app_ctx,
    )
    if not allowed_import:
        return rate_limiter.build_rate_limited_response(
            'Too many video import attempts right now. Please wait and try again.',
            retry_after,
            runtime=app_ctx,
        )

    data = request.get_json(silent=True) or {}
    fetch_target, error_message = upload_import_audio.validate_video_import_fetch_target(
        data.get('url', ''),
        runtime=app_ctx,
    )
    if not fetch_target:
        return app_ctx.jsonify({'error': error_message}), 400

    upload_import_audio.cleanup_expired_audio_import_tokens(runtime=app_ctx)
    prefix = f"urlimport_{app_ctx.uuid.uuid4().hex}"
    quota_reservation, quota_response, quota_status = upload_quota_service.reserve_upload_quota(
        app_ctx,
        uid,
        upload_quota_service.max_audio_upload_bytes(app_ctx),
        context='Audio URL import',
    )
    if quota_response is not None:
        return quota_response, quota_status

    job_id = str(app_ctx.uuid.uuid4())
    _cleanup_expired_audio_import_jobs(app_ctx)
    _set_audio_import_job(
        app_ctx,
        job_id,
        uid=uid,
        status='queued',
        step_description='Audio import queued...',
        source_url=upload_redaction_service.redact_source_url(upload_import_audio.resolved_url(fetch_target)),
    )
    try:
        app_ctx.submit_background_job(
            _run_audio_import_job,
            app_ctx,
            job_id,
            uid,
            fetch_target,
            prefix,
            quota_reservation,
        )
    except JobQueueFullError:
        upload_quota_service.release_uncommitted_upload_quota(app_ctx, quota_reservation)
        _set_audio_import_job(
            app_ctx,
            job_id,
            status='error',
            step_description='Audio import queue is full.',
            error='Audio import is busy right now. Please wait and try again.',
        )
        return app_ctx.jsonify({'error': 'Audio import is busy right now. Please wait and try again.'}), 503
    except Exception as error:
        upload_quota_service.release_uncommitted_upload_quota(app_ctx, quota_reservation)
        app_ctx.logger.error(
            'Could not queue audio import for user %s: %s',
            uid,
            upload_redaction_service.redact_exception(error, max_chars=500),
        )
        _set_audio_import_job(
            app_ctx,
            job_id,
            status='error',
            step_description='Audio import could not be queued.',
            error='Could not start audio import right now. Please try again.',
        )
        return app_ctx.jsonify({'error': 'Could not start audio import right now. Please try again.'}), 500

    return app_ctx.jsonify({
        'ok': False,
        'job_id': job_id,
        'status': 'queued',
        'step_description': 'Audio import queued...',
    }), 202


def get_imported_audio_status(app_ctx, request, job_id):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    job = _get_audio_import_job(app_ctx, uid, job_id)
    if not job:
        return app_ctx.jsonify({'error': 'Audio import job not found.'}), 404
    return app_ctx.jsonify(_audio_import_job_payload(job))


def release_imported_audio(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Unauthorized'}), 401
    uid = decoded_token['uid']
    payload = request.get_json(silent=True) or {}
    token = str(payload.get('audio_import_token', '') or '').strip()
    if token:
        upload_import_audio.release_audio_import_token(uid, token, runtime=app_ctx)
    return app_ctx.jsonify({'ok': True})
