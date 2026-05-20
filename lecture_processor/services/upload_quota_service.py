"""Central upload byte quota and disk-safety helpers for service handlers."""

from dataclasses import dataclass

from lecture_processor.domains.analytics import events as analytics_events
from lecture_processor.domains.rate_limit import limiter as rate_limiter
from lecture_processor.domains.rate_limit import quotas as rate_limit_quotas


LOW_DISK_ERROR = 'Upload temporarily unavailable due to low server storage. Please try again later.'
DAILY_QUOTA_ERROR = 'Daily upload quota reached for your account. Please try again tomorrow.'


@dataclass
class UploadQuotaReservation:
    uid: str
    requested_bytes: int = 0
    reserved_bytes: int = 0
    active: bool = False
    committed: bool = False


def safe_int(value, default=0):
    try:
        return int(value or default)
    except Exception:
        return int(default or 0)


def nonnegative_bytes(value):
    return max(0, safe_int(value, 0))


def request_content_length(request):
    return nonnegative_bytes(getattr(request, 'content_length', 0))


def max_audio_upload_bytes(app_ctx):
    return nonnegative_bytes(getattr(app_ctx, 'MAX_AUDIO_UPLOAD_BYTES', 0))


def reserve_upload_quota(
    app_ctx,
    uid,
    requested_bytes,
    *,
    context='Upload',
    analytics_limit_name='upload',
    low_disk_error=LOW_DISK_ERROR,
    daily_quota_error=DAILY_QUOTA_ERROR,
):
    """Reserve bytes after a low-disk check. Returns (reservation, response, status)."""
    requested = nonnegative_bytes(requested_bytes)
    reservation = UploadQuotaReservation(
        uid=str(uid or ''),
        requested_bytes=requested,
        reserved_bytes=0,
        active=False,
        committed=False,
    )

    disk_ok, free_bytes, needed_bytes = rate_limit_quotas.has_sufficient_upload_disk_space(
        requested,
        runtime=app_ctx,
    )
    if not disk_ok:
        app_ctx.logger.warning(
            '%s rejected due to low disk space: free=%s needed=%s uid=%s',
            context,
            free_bytes,
            needed_bytes,
            uid,
        )
        return reservation, app_ctx.jsonify({'error': low_disk_error}), 503

    reserved_daily, daily_retry_after = rate_limit_quotas.reserve_daily_upload_bytes(
        uid,
        requested,
        runtime=app_ctx,
    )
    if not reserved_daily:
        analytics_events.log_rate_limit_hit(analytics_limit_name, daily_retry_after, runtime=app_ctx)
        return (
            reservation,
            rate_limiter.build_rate_limited_response(
                daily_quota_error,
                daily_retry_after,
                runtime=app_ctx,
            ),
            429,
        )

    reservation.reserved_bytes = requested
    reservation.active = True
    return reservation, None, 0


def adjust_reserved_upload_bytes(
    app_ctx,
    reservation,
    actual_bytes,
    *,
    context='Upload',
    analytics_limit_name='upload',
    low_disk_error=LOW_DISK_ERROR,
    daily_quota_error=DAILY_QUOTA_ERROR,
):
    """Adjust a successful preflight reservation to the bytes actually saved."""
    if not isinstance(reservation, UploadQuotaReservation) or not reservation.active:
        return None, 0
    actual = nonnegative_bytes(actual_bytes)
    current = nonnegative_bytes(reservation.reserved_bytes)
    if actual == current:
        return None, 0
    if actual < current:
        release_daily_upload_bytes(app_ctx, reservation, current - actual)
        reservation.reserved_bytes = actual
        return None, 0

    extra = actual - current
    disk_ok, free_bytes, needed_bytes = rate_limit_quotas.has_sufficient_upload_disk_space(
        extra,
        runtime=app_ctx,
    )
    if not disk_ok:
        app_ctx.logger.warning(
            '%s rejected after save due to low disk space: free=%s needed=%s uid=%s',
            context,
            free_bytes,
            needed_bytes,
            reservation.uid,
        )
        return app_ctx.jsonify({'error': low_disk_error}), 503

    reserved_daily, daily_retry_after = rate_limit_quotas.reserve_daily_upload_bytes(
        reservation.uid,
        extra,
        runtime=app_ctx,
    )
    if not reserved_daily:
        analytics_events.log_rate_limit_hit(analytics_limit_name, daily_retry_after, runtime=app_ctx)
        return (
            rate_limiter.build_rate_limited_response(
                daily_quota_error,
                daily_retry_after,
                runtime=app_ctx,
            ),
            429,
        )
    reservation.reserved_bytes = actual
    return None, 0


def release_daily_upload_bytes(app_ctx, reservation, byte_count=None):
    if not isinstance(reservation, UploadQuotaReservation):
        return False
    if not reservation.uid:
        return False
    amount = reservation.reserved_bytes if byte_count is None else nonnegative_bytes(byte_count)
    if amount <= 0:
        return True
    released = rate_limit_quotas.release_daily_upload_bytes(
        reservation.uid,
        amount,
        runtime=app_ctx,
    )
    if byte_count is None:
        reservation.reserved_bytes = 0
        reservation.active = False
    return released


def release_uncommitted_upload_quota(app_ctx, reservation):
    if not isinstance(reservation, UploadQuotaReservation):
        return False
    if reservation.committed:
        return True
    return release_daily_upload_bytes(app_ctx, reservation)


def commit_upload_quota(reservation):
    if isinstance(reservation, UploadQuotaReservation):
        reservation.committed = True
        reservation.active = False


def mark_audio_import_token_quota(uid, token, bytes_charged, *, runtime=None):
    resolved_runtime = runtime
    if resolved_runtime is None:
        return False
    safe_token = str(token or '').strip()
    if not safe_token:
        return False
    charged = nonnegative_bytes(bytes_charged)
    with resolved_runtime.AUDIO_IMPORT_LOCK:
        entry = resolved_runtime.AUDIO_IMPORT_TOKENS.get(safe_token)
        if not entry or str(entry.get('uid', '') or '') != str(uid or ''):
            return False
        entry['quota_bytes_charged'] = charged
    return True


def audio_import_token_quota_bytes(uid, token, *, runtime=None):
    resolved_runtime = runtime
    if resolved_runtime is None:
        return 0
    safe_token = str(token or '').strip()
    if not safe_token:
        return 0
    with resolved_runtime.AUDIO_IMPORT_LOCK:
        entry = resolved_runtime.AUDIO_IMPORT_TOKENS.get(safe_token) or {}
        if str(entry.get('uid', '') or '') != str(uid or ''):
            return 0
        return nonnegative_bytes(entry.get('quota_bytes_charged', 0))


def chargeable_import_token_bytes(app_ctx, uid, token, actual_size):
    charged = audio_import_token_quota_bytes(uid, token, runtime=app_ctx)
    return max(0, nonnegative_bytes(actual_size) - charged)
