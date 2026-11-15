"""Queued lecture downloads and short-lived, account-owned media artifacts."""

from __future__ import annotations

from datetime import datetime, timezone
import secrets
import zipfile

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.rate_limit import quotas as rate_limit_quotas
from lecture_processor.domains.runtime_jobs import recovery as runtime_job_recovery
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.upload import import_audio as upload_import_audio
from lecture_processor.runtime.job_dispatcher import JobQueueFullError
from lecture_processor.services import access_service, media_admission, upload_quota_service, upload_redaction_service

JOB_SCOPE = 'lecture_download'
DOWNLOAD_TTL_SECONDS = 30 * 60
DOWNLOAD_ERROR = 'Could not download lecture media. Please check the link and try again.'
LOW_DISK_ERROR = 'Lecture download is temporarily unavailable due to low server storage. Please try again later.'
_ACTIVE_STATUSES = {'queued', 'starting', 'processing'}


def _artifact_path(app_ctx, job_id, path):
    """Accept only this job's files directly inside the configured upload root."""
    root = app_ctx.os.path.realpath(app_ctx.UPLOAD_FOLDER)
    candidate = app_ctx.os.path.abspath(str(path or ''))
    if not app_ctx.os.path.basename(candidate).startswith(f'{job_id}_'):
        return ''
    if app_ctx.os.path.realpath(app_ctx.os.path.dirname(candidate)) != root or app_ctx.os.path.islink(candidate):
        return ''
    return app_ctx.os.path.realpath(candidate)


def _cleanup_job_files(app_ctx, job_id, keep_path='', *, filenames=None):
    root = app_ctx.os.path.realpath(app_ctx.UPLOAD_FOLDER)
    if not app_ctx.os.path.isdir(root):
        return
    if filenames is None:
        try:
            filenames = app_ctx.os.listdir(root)
        except OSError:
            app_ctx.logger.warning('Could not inspect lecture download artifacts for %s', job_id, exc_info=True)
            return
    for filename in filenames:
        if not filename.startswith(f'{job_id}_'):
            continue
        path = _artifact_path(app_ctx, job_id, app_ctx.os.path.join(root, filename))
        if not path or path == keep_path:
            continue
        try:
            app_ctx.os.remove(path)
        except FileNotFoundError:
            pass
        except Exception:
            app_ctx.logger.warning('Could not remove lecture download artifact for %s', job_id, exc_info=True)


def _download_name(kind):
    date_stamp = datetime.now(timezone.utc).strftime('%Y-%m-%d')
    extension = {'audio': 'mp3', 'video': 'mp4', 'both': 'zip'}[kind]
    name = 'media' if kind == 'both' else kind
    return f'lecture-{name}-{date_stamp}.{extension}'


def _reserved_download_bytes(app_ctx, requested_format):
    return upload_quota_service.max_audio_upload_bytes(app_ctx) * (2 if requested_format == 'both' else 1)


def _download_metadata(job):
    result = job.get('result')
    metadata = result.get('download') if isinstance(result, dict) else None
    return metadata if isinstance(metadata, dict) else {}


def cleanup_expired_downloads(app_ctx):
    """Periodic cleanup also handles failed jobs recovered after a restart."""
    with app_ctx.JOBS_LOCK:
        jobs = {job_id: dict(job) for job_id, job in app_ctx.jobs.items()}
    now = app_ctx.time.time()
    # Completed jobs need not be loaded after a restart. Find only our old
    # artifacts, then check their durable job before cleaning; another process
    # may still own a live download during a deployment overlap.
    root = app_ctx.os.path.realpath(app_ctx.UPLOAD_FOLDER)
    if not app_ctx.os.path.isdir(root):
        return
    try:
        filenames = app_ctx.os.listdir(root)
    except OSError:
        app_ctx.logger.warning('Could not inspect expired lecture downloads', exc_info=True)
        return
    files_by_job = {}
    for filename in filenames:
        job_id, separator, _suffix = filename.partition('_')
        if separator:
            files_by_job.setdefault(job_id, []).append(filename)

    for job_id, job_files in files_by_job.items():
        job = jobs.get(job_id)
        if job is None:
            try:
                if str(app_ctx.uuid.UUID(job_id)) != job_id:
                    continue
                expired_artifact = False
                for filename in job_files:
                    if not filename.startswith(f'{job_id}_tooldownload'):
                        continue
                    path = _artifact_path(app_ctx, job_id, app_ctx.os.path.join(root, filename))
                    if not path:
                        continue
                    try:
                        expired_artifact = app_ctx.os.path.getmtime(path) + DOWNLOAD_TTL_SECONDS <= now
                    except FileNotFoundError:
                        continue
                    if expired_artifact:
                        break
                if not expired_artifact:
                    continue
                if app_ctx.db is not None:
                    doc = app_ctx.repositories.runtime_jobs.get_doc(app_ctx.db, app_ctx.RUNTIME_JOBS_COLLECTION, job_id)
                    if doc.exists:
                        job = doc.to_dict() or {}
                if job is None:
                    job = {'job_scope': JOB_SCOPE, 'status': 'error'}
            except (ValueError, FileNotFoundError):
                continue
            except Exception:
                app_ctx.logger.warning('Could not inspect expired lecture download %s', job_id, exc_info=True)
                continue
        if job.get('job_scope') != JOB_SCOPE:
            continue
        if job.get('status') in _ACTIVE_STATUSES:
            continue
        metadata = _download_metadata(job)
        if job.get('status') == 'complete' and float(metadata.get('expires_at', 0) or 0) > now:
            continue
        _cleanup_job_files(app_ctx, job_id, filenames=job_files)


def _set_active_job_fields(app_ctx, job_id, **fields):
    applied = False

    def update(job):
        nonlocal applied
        if job.get('job_scope') == JOB_SCOPE and job.get('status') in _ACTIVE_STATUSES:
            job.update(fields)
            applied = True

    runtime_jobs_store.mutate_job(job_id, update, runtime=app_ctx)
    return applied


def _finish_error(app_ctx, job_id, message=DOWNLOAD_ERROR):
    _set_active_job_fields(app_ctx, job_id, status='error', error=message,
                           step_description='Lecture download failed.', finished_at=app_ctx.time.time())


def _require_active_account(app_ctx, job_id, uid):
    job = runtime_jobs_store.get_job_snapshot(job_id, runtime=app_ctx) or {}
    if job.get('status') not in _ACTIVE_STATUSES or job.get('job_scope') != JOB_SCOPE:
        raise RuntimeError('Download job is no longer active.')
    allowed, _message = account_lifecycle.ensure_account_allows_writes(uid, runtime=app_ctx)
    if not allowed:
        raise RuntimeError('Download account is no longer available.')


def _run_lecture_download(app_ctx, *, job_id, uid, fetch_target, requested_format, quota_reservation, media_lease):
    # Quota helpers can construct Flask JSON responses on their failure paths.
    with app_ctx.app.app_context():
        _run_lecture_download_in_context(app_ctx, job_id, uid, fetch_target, requested_format, quota_reservation, media_lease)


def _run_lecture_download_in_context(app_ctx, job_id, uid, fetch_target, requested_format, quota_reservation, media_lease):
    response_path = ''
    published = False
    prefix = f'{job_id}_tooldownload'
    try:
        _require_active_account(app_ctx, job_id, uid)
        _set_active_job_fields(app_ctx, job_id, status='processing', step_description='Preparing lecture media...')
        if requested_format == 'audio':
            path, _name, _size = app_ctx.download_audio_from_video_url(fetch_target, prefix)
            mimetype = 'audio/mpeg'
        else:
            path, _name, _size = app_ctx.download_video_from_video_url(fetch_target, prefix)
            mimetype = 'video/mp4'
        response_path = _artifact_path(app_ctx, job_id, path)
        if not response_path or not app_ctx.os.path.isfile(response_path):
            raise RuntimeError('Invalid lecture download artifact.')
        downloaded_paths = [response_path]
        _require_active_account(app_ctx, job_id, uid)
        if requested_format == 'both':
            audio_path, converted = app_ctx.convert_audio_to_mp3_with_ytdlp(response_path)
            audio_path = _artifact_path(app_ctx, job_id, audio_path)
            if not converted or not audio_path or audio_path == response_path or not app_ctx.os.path.isfile(audio_path):
                raise RuntimeError('Could not create the MP3 version of this lecture.')
            audio_size = int(app_ctx.get_saved_file_size(audio_path) or 0)
            if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES or not app_ctx.file_looks_like_audio(audio_path):
                raise RuntimeError('Invalid converted lecture audio.')
            downloaded_paths.append(audio_path)
            _require_active_account(app_ctx, job_id, uid)
        actual_bytes = sum(int(app_ctx.get_saved_file_size(path) or 0) for path in downloaded_paths)
        quota_error, _status = upload_quota_service.adjust_reserved_upload_bytes(
            app_ctx, quota_reservation, actual_bytes, context='Lecture media download',
            analytics_limit_name='lecture_download', low_disk_error=LOW_DISK_ERROR,
        )
        if quota_error is not None:
            raise RuntimeError('Lecture download exceeded the storage or quota limit.')
        if requested_format == 'both':
            # The archive temporarily coexists with both inputs, but it must not
            # count a second time against the account's daily download allowance.
            disk_ok, _free, _needed = rate_limit_quotas.has_sufficient_upload_disk_space(actual_bytes + 1024, runtime=app_ctx)
            if not disk_ok:
                raise RuntimeError('Insufficient room for the lecture archive.')
            zip_path = app_ctx.os.path.join(app_ctx.os.path.realpath(app_ctx.UPLOAD_FOLDER), f'{prefix}_bundle.zip')
            with zipfile.ZipFile(zip_path, 'w', compression=zipfile.ZIP_STORED) as archive:
                archive.write(downloaded_paths[0], arcname='lecture-video.mp4')
                archive.write(downloaded_paths[1], arcname='lecture-audio.mp3')
            response_path = zip_path
            mimetype = 'application/zip'
        _require_active_account(app_ctx, job_id, uid)
        finished_at = app_ctx.time.time()
        metadata = {
            'token': secrets.token_urlsafe(32),
            'expires_at': finished_at + min(DOWNLOAD_TTL_SECONDS, int(app_ctx.JOB_TTL_SECONDS)),
            'size_bytes': int(app_ctx.get_saved_file_size(response_path) or 0),
            'mimetype': mimetype,
        }
        published = _set_active_job_fields(
            app_ctx, job_id, status='complete', step_description='Lecture download ready.',
            finished_at=finished_at, export_path=response_path, download_name=_download_name(requested_format),
            result={'download': metadata},
        )
        if published:
            upload_quota_service.commit_upload_quota(quota_reservation)
    except Exception as error:
        app_ctx.logger.error('Lecture download failed for job %s: %s', job_id,
                             upload_redaction_service.redact_exception(error, max_chars=500))
        _finish_error(app_ctx, job_id)
    finally:
        try:
            _cleanup_job_files(app_ctx, job_id, keep_path=response_path if published else '')
            upload_quota_service.release_uncommitted_upload_quota(app_ctx, quota_reservation)
        finally:
            media_lease.release()


def download_lecture_media(app_ctx, request):
    decoded_token = app_ctx.verify_firebase_token(request)
    if not decoded_token:
        return app_ctx.jsonify({'error': 'Please sign in to continue'}), 401
    uid = decoded_token['uid']
    if not access_service.is_email_allowed(app_ctx, decoded_token.get('email', '')):
        return app_ctx.jsonify({'error': 'Email not allowed'}), 403
    allowed_account, message = account_lifecycle.ensure_account_allows_writes(uid, runtime=app_ctx)
    if not allowed_account:
        return app_ctx.jsonify({'error': message, 'status': 'account_deletion_in_progress'}), 409
    if 'application/json' not in str(request.headers.get('Accept', '')).lower():
        return app_ctx.jsonify({'error': 'Please refresh this page before starting a download.'}), 409
    allowed, retry_after = rate_limiter.check_rate_limit(
        key=f"lecture_download:{rate_limiter.normalize_rate_limit_key_part(uid, fallback='anon_uid', runtime=app_ctx)}",
        limit=app_ctx.VIDEO_IMPORT_RATE_LIMIT_MAX_REQUESTS,
        window_seconds=app_ctx.VIDEO_IMPORT_RATE_LIMIT_WINDOW_SECONDS, runtime=app_ctx,
    )
    if not allowed:
        analytics_events.log_rate_limit_hit('lecture_download', retry_after, runtime=app_ctx)
        return rate_limiter.build_rate_limited_response(
            'Too many lecture download attempts right now. Please wait and try again.', retry_after, runtime=app_ctx,
        )
    payload = request.get_json(silent=True) or {}
    requested_format = str(payload.get('format', 'audio') or '').strip().lower()
    if requested_format not in {'audio', 'video', 'both'}:
        return app_ctx.jsonify({'error': 'Choose MP3, MP4, or both before downloading.'}), 400
    fetch_target, error_message = upload_import_audio.validate_video_import_fetch_target(payload.get('url', ''), runtime=app_ctx)
    if not fetch_target:
        return app_ctx.jsonify({'error': error_message}), 400
    cleanup_expired_downloads(app_ctx)
    media_lease, busy_status = media_admission.try_acquire(uid)
    if media_lease is None:
        return media_admission.busy_response(app_ctx, busy_status)
    quota_reservation = None
    job_id = ''
    submitted = False
    try:
        requested_bytes = _reserved_download_bytes(app_ctx, requested_format)
        if requested_format == 'both':
            disk_ok, _free, _needed = rate_limit_quotas.has_sufficient_upload_disk_space(requested_bytes * 2 + 1024, runtime=app_ctx)
            if not disk_ok:
                return app_ctx.jsonify({'error': LOW_DISK_ERROR}), 503
        quota_reservation, quota_response, quota_status = upload_quota_service.reserve_upload_quota(
            app_ctx, uid, requested_bytes, context='Lecture media download', analytics_limit_name='lecture_download',
            low_disk_error=LOW_DISK_ERROR,
        )
        if quota_response is not None:
            return quota_response, quota_status
        job_id = str(app_ctx.uuid.uuid4())
        runtime_jobs_store.set_job(job_id, {
            'job_id': job_id, 'job_scope': JOB_SCOPE, 'mode': 'lecture-download', 'user_id': uid,
            'status': 'queued', 'step_description': 'Lecture download queued...', 'started_at': app_ctx.time.time(),
        }, runtime=app_ctx)
        future = app_ctx.submit_background_job(
            _run_lecture_download, app_ctx, job_id=job_id, uid=uid, fetch_target=fetch_target,
            requested_format=requested_format, quota_reservation=quota_reservation, media_lease=media_lease,
        )
        submitted = True
        if hasattr(future, 'add_done_callback'):
            def cancelled(done):
                if done.cancelled():
                    try:
                        _finish_error(app_ctx, job_id)
                        _cleanup_job_files(app_ctx, job_id)
                        upload_quota_service.release_uncommitted_upload_quota(app_ctx, quota_reservation)
                    finally:
                        media_lease.release()
            future.add_done_callback(cancelled)
        return app_ctx.jsonify({'ok': False, 'job_id': job_id, 'status': 'queued', 'step_description': 'Lecture download queued...'}), 202
    except JobQueueFullError:
        _finish_error(app_ctx, job_id)
        return app_ctx.jsonify({'error': 'Lecture download is busy right now. Please wait and try again.'}), 503
    except Exception as error:
        _finish_error(app_ctx, job_id)
        app_ctx.logger.error('Could not queue lecture download: %s', upload_redaction_service.redact_exception(error, max_chars=500))
        return app_ctx.jsonify({'error': 'Could not start lecture download right now. Please try again.'}), 500
    finally:
        if not submitted:
            try:
                if job_id:
                    _cleanup_job_files(app_ctx, job_id)
                upload_quota_service.release_uncommitted_upload_quota(app_ctx, quota_reservation)
            finally:
                media_lease.release()


def _owned_job(app_ctx, request, job_id):
    token = app_ctx.verify_firebase_token(request)
    if not token:
        return None, (app_ctx.jsonify({'error': 'Please sign in to continue'}), 401)
    job = runtime_jobs_store.get_job_snapshot(job_id, runtime=app_ctx)
    if not job or job.get('job_scope') != JOB_SCOPE or job.get('user_id') != token['uid']:
        return None, (app_ctx.jsonify({'error': 'Lecture download not found.'}), 404)
    if (getattr(app_ctx, 'RUNTIME_JOB_RECOVERY_ENABLED', False)
            and runtime_job_recovery._runtime_job_is_stale(job, now_ts=app_ctx.time.time(), runtime=app_ctx)
            and runtime_job_recovery.recover_runtime_job_if_stale(job_id, runtime=app_ctx)):
        job = runtime_jobs_store.get_job_snapshot(job_id, runtime=app_ctx) or job
    allowed, _message = account_lifecycle.ensure_account_allows_writes(token['uid'], runtime=app_ctx)
    if not allowed:
        return None, (app_ctx.jsonify({'error': 'Lecture download is no longer available.'}), 409)
    return job, None


def get_lecture_download_status(app_ctx, request, job_id):
    job, error = _owned_job(app_ctx, request, job_id)
    if error is not None:
        return error
    status = str(job.get('status', 'error'))
    payload = {'ok': status == 'complete', 'job_id': job_id, 'status': status,
               'step_description': str(job.get('step_description', '') or '')}
    if status == 'complete':
        metadata = _download_metadata(job)
        remaining = float(metadata.get('expires_at', 0) or 0) - app_ctx.time.time()
        path = _artifact_path(app_ctx, job_id, job.get('export_path'))
        if remaining <= 0 or not path or not app_ctx.os.path.isfile(path):
            _cleanup_job_files(app_ctx, job_id)
            payload.update(ok=False, status='error', error='This download has expired. Please prepare it again.')
        else:
            payload.update(download_token=metadata.get('token', ''), file_name=job.get('download_name', ''),
                           size_bytes=int(metadata.get('size_bytes', 0)), expires_in_seconds=max(1, int(remaining)))
    elif status == 'error':
        payload['error'] = DOWNLOAD_ERROR
    response = app_ctx.jsonify(payload)
    response.headers['Cache-Control'] = 'no-store'
    return response


def download_lecture_file(app_ctx, request, job_id):
    job, error = _owned_job(app_ctx, request, job_id)
    if error is not None:
        return error
    metadata = _download_metadata(job)
    expected = str(metadata.get('token', '') or '')
    if job.get('status') != 'complete' or not expected:
        return app_ctx.jsonify({'error': 'Lecture download not found.'}), 404
    provided = request.headers.get('X-Lecture-Download-Token')
    if provided is None and 'token' in request.args:
        return app_ctx.jsonify({
            'error': 'Please refresh this page before downloading this file.',
            'error_code': 'download_page_refresh_required',
        }), 409
    provided = str(provided or '')
    if not secrets.compare_digest(provided, expected):
        return app_ctx.jsonify({'error': 'Lecture download not found.'}), 404
    if float(metadata.get('expires_at', 0) or 0) <= app_ctx.time.time():
        _cleanup_job_files(app_ctx, job_id)
        return app_ctx.jsonify({'error': 'This download has expired. Please prepare it again.'}), 410
    path = _artifact_path(app_ctx, job_id, job.get('export_path'))
    if not path or not app_ctx.os.path.isfile(path):
        return app_ctx.jsonify({'error': 'Lecture download not found.'}), 404
    # send_file opens the file before returning. Keep it for retries/ranges until
    # TTL cleanup instead of unlinking it in an after-request callback.
    try:
        response = app_ctx.send_file(path, mimetype=metadata.get('mimetype', 'application/octet-stream'),
                                     as_attachment=True, download_name=job.get('download_name'), conditional=True)
    except FileNotFoundError:
        return app_ctx.jsonify({'error': 'This download has expired. Please prepare it again.'}), 410
    response.headers['Cache-Control'] = 'private, no-store'
    return response
