"""Book Studio routes; all persisted content access stays server-authorized."""
import io
import logging
import os
import threading
from urllib.parse import urlparse

from google.api_core.exceptions import GoogleAPICallError

from flask import Blueprint, abort, current_app, jsonify, render_template, request, send_file

from lecture_processor.domains.books.model import BookError
from lecture_processor.domains.books.export import generate
from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import book_service as service

books_bp = Blueprint('books', __name__)
logger = logging.getLogger(__name__)
_export_gate = threading.BoundedSemaphore(1)


@books_bp.before_request
def enabled():
    if os.getenv('BOOK_STUDIO_ENABLED', '1') == '0':
        abort(404)
    if request.path.startswith('/api/books') and request.method != 'GET':
        runtime = get_runtime()
        from lecture_processor.repositories.books_repo import invalidate
        if request.view_args and request.view_args.get('book_id'):
            invalidate(request.view_args['book_id'])
        from lecture_processor.domains.rate_limit import limiter
        heavy = request.endpoint == 'books.export_book'
        allowed, retry = limiter.check_rate_limit(key='books:' + ('export:' if heavy else 'write:') + (request.remote_addr or 'unknown'), limit=12 if heavy else 180, window_seconds=60, runtime=runtime)
        if not allowed:
            return jsonify(error='Please wait a moment before trying again.'), 429, {'Retry-After': str(retry)}
    if request.content_length and request.content_length > 80 * 1024 * 1024:
        raise BookError('This export is too large. Use smaller images or export fewer pages.', 413)


@books_bp.errorhandler(BookError)
def book_error(error):
    if error.status >= 409:
        logger.info('Book Studio request declined: status=%s endpoint=%s', error.status, request.endpoint)
    return jsonify(error=str(error)), error.status


@books_bp.errorhandler(GoogleAPICallError)
@books_bp.errorhandler(RuntimeError)
def unavailable(error):
    logger.warning('Book Studio operation unavailable: %s', type(error).__name__)
    return jsonify(error='Cloud saving is unavailable. Your draft stays on this device.'), 503


@books_bp.route('/books')
@books_bp.route('/books/<book_id>')
@books_bp.route('/books/shared/<token>')
def studio(book_id='', token=''):
    runtime = get_runtime()
    chatgpt_url = os.getenv('BOOK_CHATGPT_URL', 'https://chatgpt.com/')
    if urlparse(chatgpt_url).scheme != 'https' or urlparse(chatgpt_url).hostname not in ('chatgpt.com', 'chat.openai.com'):
        chatgpt_url = 'https://chatgpt.com/'
    return render_template('books.html', book_id=book_id, share_token=token, chatgpt_url=chatgpt_url, book_js_asset=runtime.resolve_js_asset('js/book-studio.js'))


@books_bp.route('/api/books', methods=['GET', 'POST'])
def library():
    runtime = get_runtime()
    return service.list_books(runtime) if request.method == 'GET' else service.create_book(runtime)


@books_bp.route('/api/books/share-session', methods=['POST'])
def share_session():
    return service.exchange(get_runtime())


@books_bp.route('/api/books/export', methods=['POST'])
def export_book():
    raw = service.payload()
    if raw.get('book_id'):
        _, book, _, _ = service.access(get_runtime(), raw['book_id'], 'edit')
        if raw.get('revision') != book['revision']:
            raise BookError('The book changed while the export was preparing. Save and export again.', 409)
    # Local-only books can be exported without creating an account.
    if not _export_gate.acquire(blocking=False):
        raise BookError('Another book is being prepared. Please try again in a moment.', 429)
    try:
        result, mime, extension = generate(raw)
    finally:
        _export_gate.release()
    from werkzeug.utils import secure_filename
    filename = secure_filename(str(raw.get('title', 'book'))) or 'book'
    return send_file(io.BytesIO(result), mimetype=mime, as_attachment=True, download_name=filename + '.' + extension)


@books_bp.route('/api/books/<book_id>', methods=['GET', 'PUT', 'PATCH'])
def book(book_id):
    method = {'GET': service.get_book, 'PUT': service.save_book, 'PATCH': service.update_library}[request.method]
    return method(get_runtime(), book_id)


@books_bp.route('/api/books/<book_id>/revision')
def revision(book_id):
    return service.revision(get_runtime(), book_id)


@books_bp.route('/api/books/<book_id>/lease', methods=['POST'])
def lease(book_id):
    return service.lease(get_runtime(), book_id)


@books_bp.route('/api/books/<book_id>/sharing', methods=['GET', 'POST'])
def sharing(book_id):
    return service.sharing(get_runtime(), book_id)


@books_bp.route('/api/books/<book_id>/comments', methods=['GET', 'POST'])
def comments(book_id):
    return service.comments(get_runtime(), book_id)


@books_bp.route('/api/books/<book_id>/history', methods=['GET', 'POST'])
def history(book_id):
    return service.history(get_runtime(), book_id)


@books_bp.route('/api/books/<book_id>/assets', methods=['POST'])
def upload_asset(book_id):
    return service.upload_asset(get_runtime(), book_id)


@books_bp.route('/api/books/<book_id>/assets/<asset_id>', methods=['GET', 'DELETE'])
def asset(book_id, asset_id):
    return service.get_asset(get_runtime(), book_id, asset_id) if request.method == 'GET' else service.delete_asset(get_runtime(), book_id, asset_id)


@books_bp.route('/api/books/<book_id>/backup')
def backup(book_id):
    return service.backup(get_runtime(), book_id)


@books_bp.route('/api/books/fonts')
def book_fonts():
    """Public, licensed font bundle for editable Word output."""
    from pathlib import Path
    import zipfile
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w', zipfile.ZIP_DEFLATED) as archive:
        for font in sorted((Path(current_app.static_folder) / 'fonts' / 'books').iterdir()):
            if font.suffix in ('.ttf', '.txt'):
                archive.write(font, font.name)
        archive.writestr('INSTALL.txt', 'Book Studio fonts\n\nUnzip this folder. On macOS, select the TTF files and open them with Font Book, then click Install. On Windows, select the TTF files, right-click and choose Install. Restart Word after installing.\n\nIncluded fonts: Andika, Playpen Sans, Nunito, Comic Neue, Fraunces, Nohemi Bold and General Sans Regular/Bold. License files are included. Editable Word uses regular and bold weights; continuous thickness and some effects are flattened or substituted as shown before export. Word edits do not synchronize with Book Studio.\n')
    return send_file(io.BytesIO(output.getvalue()), mimetype='application/zip', as_attachment=True, download_name='Book Studio fonts.zip', max_age=86400)
