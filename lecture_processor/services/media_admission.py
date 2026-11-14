"""Compatibility imports for shared media admission."""

from lecture_processor.domains.upload.media_admission import (
    BUSY_MESSAGE,
    RETRY_AFTER_SECONDS,
    _MediaLease,
    busy_response,
    try_acquire,
)

__all__ = ['BUSY_MESSAGE', 'RETRY_AFTER_SECONDS', '_MediaLease', 'busy_response', 'try_acquire']
