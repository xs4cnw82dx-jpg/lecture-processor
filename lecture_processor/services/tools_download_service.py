"""Direct download handlers for lecture media tools."""

from __future__ import annotations

from datetime import datetime, timezone
import zipfile

from flask import after_this_request

from lecture_processor.domains.auth import policy as auth_policy
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.upload import import_audio as upload_import_audio

from lecture_processor.services import upload_batch_support


def _is_email_allowed(app_ctx, email: str) -> bool:
    checker = getattr(app_ctx, 'is_email_allowed', None)
    if callable(checker):
        try:
            return bool(checker(email))
        except TypeError:
            return bool(checker(email, runtime=app_ctx))
    return auth_policy.is_email_allowed(email, runtime=app_ctx)


def _cleanup_local_paths(app_ctx, paths):
    seen = set()
    for raw_path in paths or ():
        path = str(raw_path or '').strip()
        if not path or path in seen:
            continue
        seen.add(path)
        try:
            if app_ctx.os.path.exists(path):
                app_ctx.os.remove(path)
        except Exception:
            app_ctx.logger.warning('Could not remove temporary lecture download artifact: %s', path, exc_info=True)


def _download_name(kind: str) -> str:
    date_stamp = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    if kind == 'audio':
        return f'lecture-audio-{date_stamp}.mp3'
    if kind == 'video':
        return f'lecture-video-{date_stamp}.mp4'
    return f'lecture-media-{date_stamp}.zip'


def download_lecture_media(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401

    uid = decoded_token['uid']
    email = decoded_token.get('email', '')
    if not _is_email_allowed(app_ctx, email):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403
    deletion_guard = upload_batch_support.account_write_guard_response(app_ctx, uid)
    if deletion_guard is not None:
        return deletion_guard

    allowed, retry_after = rate_limiter.check_rate_limit(
        key=f"lecture_download:{rate_limiter.normalize_rate_limit_key_part(uid, fallback='anon_uid', runtime=app_ctx)}",
        limit=app_ctx.VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS,
        runtime=app_ctx,
    )
    if not allowed:
        return rate_limiter.build_rate_limited_response(
            'Too many lecture download attempts right now. Please wait and try again.',
            retry_after,
            runtime=app_ctx,
        )

    payload = request.get_json(silent=True) or {}
    requested_format = str(payload.get('format', 'audio') or '').strip().lower()
    if requested_format not in {'audio', 'video', 'both'}:
        return app_ctx.jsonify({'error': 'Choose MP3, MP4, or both before downloading.'}), 400

    safe_url, error_message = upload_import_audio.validate_video_import_url(
        payload.get('url', ''),
        runtime=app_ctx,
    )
    if not safe_url:
        return app_ctx.jsonify({'error': error_message}), 400

    prefix = f"tooldownload_{app_ctx.uuid.uuid4().hex}"
    cleanup_paths = []
    response_path = ''
    mimetype = 'application/octet-stream'
    download_name = _download_name(requested_format)

    try:
        if requested_format == 'audio':
            response_path, _internal_name, _size_bytes = app_ctx.download_audio_from_video_url(safe_url, prefix)
            response_path = app_ctx.os.path.abspath(response_path)
            cleanup_paths.append(response_path)
            mimetype = 'audio/mpeg'
        elif requested_format == 'video':
            response_path, _internal_name, _size_bytes = app_ctx.download_video_from_video_url(safe_url, prefix)
            response_path = app_ctx.os.path.abspath(response_path)
            cleanup_paths.append(response_path)
            mimetype = 'video/mp4'
        else:
            video_path, _internal_name, _size_bytes = app_ctx.download_video_from_video_url(safe_url, prefix)
            video_path = app_ctx.os.path.abspath(video_path)
            cleanup_paths.append(video_path)
            audio_path, converted = app_ctx.convert_audio_to_mp3_with_ytdlp(video_path)
            if not converted or not audio_path or audio_path == video_path or not app_ctx.os.path.exists(audio_path):
                raise RuntimeError('Could not create the MP3 version of this lecture.')
            audio_path = app_ctx.os.path.abspath(audio_path)
            cleanup_paths.append(audio_path)

            audio_size = int(app_ctx.get_saved_file_size(audio_path) or 0)
            if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
                raise RuntimeError('Downloaded MP3 exceeds server limit (max 500MB) or is empty.')
            if not app_ctx.file_looks_like_audio(audio_path):
                raise RuntimeError('Downloaded MP3 is invalid or unsupported.')

            zip_path = app_ctx.os.path.abspath(app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f'{prefix}_bundle.zip'))
            with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_DEFLATED) as archive:
                archive.write(video_path, arcname='lecture-video.mp4')
                archive.write(audio_path, arcname='lecture-audio.mp3')
            cleanup_paths.append(zip_path)
            response_path = zip_path
            mimetype = 'application/zip'

        @after_this_request
        def _remove_temp_files(response):
            _cleanup_local_paths(app_ctx, cleanup_paths)
            return response

        return app_ctx.send_file(
            response_path,
            mimetype=mimetype,
            as_attachment=True,
            download_name=download_name,
        )
    except RuntimeError as error:
        _cleanup_local_paths(app_ctx, cleanup_paths)
        return app_ctx.jsonify({'error': str(error)}), 400
    except Exception:
        _cleanup_local_paths(app_ctx, cleanup_paths)
        app_ctx.logger.exception('Lecture downloader failed for user %s', uid)
        return app_ctx.jsonify({'error': 'Could not download lecture media right now. Please try again.'}), 500
