"""Private Supabase asset storage through server-only credentials."""
from __future__ import annotations

import io
import os
import urllib.error
import urllib.parse
import urllib.request
import warnings

from PIL import Image, ImageOps, UnidentifiedImageError

from lecture_processor.domains.books.model import BookError

MAX_BYTES = min(10, int(os.getenv('BOOK_IMAGE_MAX_MB', '10'))) * 1024 * 1024
BOOK_BYTES = int(os.getenv('BOOK_ASSETS_MAX_MB', '25')) * 1024 * 1024
GLOBAL_BYTES = int(os.getenv('BOOK_STORAGE_MAX_MB', '750')) * 1024 * 1024
MONTHLY_BYTES = int(os.getenv('BOOK_TRANSFER_MAX_MB', '4096')) * 1024 * 1024


def configured():
    return bool(os.getenv('BOOK_STORAGE_URL') and os.getenv('BOOK_STORAGE_KEY'))


def request(method, path, data=None, content_type='application/octet-stream'):
    if not configured():
        raise BookError('Image cloud saving is not available yet. Your image stays safely in this browser.', 503)
    base = os.environ['BOOK_STORAGE_URL'].rstrip('/')
    if not base.startswith('https://'):
        raise BookError('Image storage is unavailable. Please try again later.', 503)
    bucket = os.getenv('BOOK_STORAGE_BUCKET', 'book-images')
    url = base + '/storage/v1/object/' + urllib.parse.quote(bucket, safe='') + '/' + urllib.parse.quote(path, safe='/')
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'Bearer ' + os.environ['BOOK_STORAGE_KEY'],
        'apikey': os.environ['BOOK_STORAGE_KEY'],
        'Content-Type': content_type,
        'x-upsert': 'false',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as response:
            return response.read(MAX_BYTES + 1)
    except urllib.error.HTTPError as error:
        if method == 'DELETE' and error.code == 404:
            return b''
        raise BookError('Image storage could not finish this request. Please retry; your original is safe.', 503) from error
    except (urllib.error.URLError, TimeoutError) as error:
        raise BookError('Image storage could not be reached. Please retry; your original is safe.', 503) from error


def validate_image(data):
    if len(data) > MAX_BYTES:
        raise BookError('This image is larger than 10 MB. Choose a smaller file.')
    try:
        with warnings.catch_warnings():
            warnings.simplefilter('error', Image.DecompressionBombWarning)
            image = Image.open(io.BytesIO(data))
            if image.format not in ('PNG', 'JPEG', 'WEBP'):
                raise BookError('Choose a PNG, JPEG or WebP image.')
            if image.width * image.height > 32_000_000 or min(image.size) < 1:
                raise BookError('This image is too large. Resize it to at most 32 megapixels.')
            image.load()
            image = ImageOps.exif_transpose(image)
            # Keep the supplied bytes as the original; the preview has no camera metadata.
            preview = image.convert('RGBA' if 'A' in image.getbands() or 'transparency' in image.info else 'RGB')
            preview.thumbnail((1600, 1600))
            output = io.BytesIO()
            preview.save(output, 'WEBP', quality=88)
            return image.size, output.getvalue(), Image.MIME[Image.open(io.BytesIO(data)).format]
    except (UnidentifiedImageError, OSError, Image.DecompressionBombError, Image.DecompressionBombWarning) as error:
        raise BookError('This file is not a supported image. Choose a PNG, JPEG or WebP.') from error
