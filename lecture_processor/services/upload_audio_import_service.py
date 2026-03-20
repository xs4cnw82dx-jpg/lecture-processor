"""Audio import routes extracted from upload API service."""

from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.upload import import_audio as upload_import_audio

from lecture_processor.services import upload_batch_support


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
    safe_url, error_message = upload_import_audio.validate_video_import_url(
        data.get('url', ''),
        runtime=app_ctx,
    )
    if not safe_url:
        return app_ctx.jsonify({'error': error_message}), 400

    upload_import_audio.cleanup_expired_audio_import_tokens(runtime=app_ctx)
    prefix = f"urlimport_{app_ctx.uuid.uuid4().hex}"
    try:
        audio_path, output_name, size_bytes = app_ctx.download_audio_from_video_url(safe_url, prefix)
        token = upload_import_audio.register_audio_import_token(
            uid,
            audio_path,
            safe_url,
            output_name,
            runtime=app_ctx,
        )
        return app_ctx.jsonify({
            'ok': True,
            'audio_import_token': token,
            'file_name': output_name,
            'size_bytes': int(size_bytes),
            'expires_in_seconds': app_ctx.AUDIO_IMPORT_TOKEN_TTL_SECONDS,
        })
    except Exception as error:
        app_ctx.logger.error(f"Error importing audio from URL for user {uid}: {error}")
        return app_ctx.jsonify({'error': 'Could not import audio from URL. Please check that the URL is accessible and try again.'}), 400


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
