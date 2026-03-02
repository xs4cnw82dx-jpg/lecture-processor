from flask import Blueprint

upload_bp = Blueprint('upload_api', __name__)


@upload_bp.route('/api/import-audio-url', methods=['POST'])
def import_audio_url():
    from lecture_processor import legacy_app

    return legacy_app.import_audio_from_url_impl()


@upload_bp.route('/api/import-audio-url/release', methods=['POST'])
def release_audio_import():
    from lecture_processor import legacy_app

    return legacy_app.release_imported_audio_impl()


@upload_bp.route('/upload', methods=['POST'])
def upload_file():
    from lecture_processor import legacy_app

    return legacy_app.upload_files_impl()


@upload_bp.route('/status/<job_id>')
def get_status(job_id):
    from lecture_processor import legacy_app

    return legacy_app.get_status_impl(job_id)


@upload_bp.route('/download-docx/<job_id>')
def download_docx(job_id):
    from lecture_processor import legacy_app

    return legacy_app.download_docx_impl(job_id)


@upload_bp.route('/download-flashcards-csv/<job_id>')
def download_flashcards_csv(job_id):
    from lecture_processor import legacy_app

    return legacy_app.download_flashcards_csv_impl(job_id)


@upload_bp.route('/api/processing-averages')
def processing_averages():
    from lecture_processor import legacy_app

    return legacy_app.processing_averages_impl()
