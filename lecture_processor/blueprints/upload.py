from flask import Blueprint, request

from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import upload_api_service

upload_bp = Blueprint('upload_api', __name__)


@upload_bp.route('/api/import-audio-url', methods=['POST'])
def import_audio_url():
    runtime = get_runtime()
    return upload_api_service.import_audio_from_url(runtime, request)


@upload_bp.route('/api/import-audio-url/release', methods=['POST'])
def release_audio_import():
    runtime = get_runtime()
    return upload_api_service.release_imported_audio(runtime, request)


@upload_bp.route('/upload', methods=['POST'])
def upload_file():
    runtime = get_runtime()
    return upload_api_service.upload_files(runtime, request)


@upload_bp.route('/api/batch/jobs', methods=['POST'])
def create_batch_job():
    runtime = get_runtime()
    return upload_api_service.create_batch_job(runtime, request)


@upload_bp.route('/api/batch/jobs', methods=['GET'])
def list_batch_jobs():
    runtime = get_runtime()
    return upload_api_service.list_batch_jobs(runtime, request)


@upload_bp.route('/api/batch/jobs/<batch_id>', methods=['GET'])
def get_batch_job_status(batch_id):
    runtime = get_runtime()
    return upload_api_service.get_batch_job_status(runtime, request, batch_id)


@upload_bp.route('/api/batch/jobs/<batch_id>/download.zip', methods=['GET'])
def download_batch_zip(batch_id):
    runtime = get_runtime()
    return upload_api_service.download_batch_zip(runtime, request, batch_id)


@upload_bp.route('/api/batch/jobs/<batch_id>/rows/<row_id>/download-docx', methods=['GET'])
def download_batch_row_docx(batch_id, row_id):
    runtime = get_runtime()
    return upload_api_service.download_batch_row_docx(runtime, request, batch_id, row_id)


@upload_bp.route('/api/batch/jobs/<batch_id>/rows/<row_id>/download-flashcards-csv', methods=['GET'])
def download_batch_row_flashcards_csv(batch_id, row_id):
    runtime = get_runtime()
    return upload_api_service.download_batch_row_flashcards_csv(runtime, request, batch_id, row_id)


@upload_bp.route('/api/tools/extract', methods=['POST'])
def tools_extract():
    runtime = get_runtime()
    return upload_api_service.tools_extract(runtime, request)


@upload_bp.route('/api/tools/export', methods=['POST'])
def tools_export():
    runtime = get_runtime()
    return upload_api_service.tools_export(runtime, request)


@upload_bp.route('/status/<job_id>')
def get_status(job_id):
    runtime = get_runtime()
    return upload_api_service.get_status(runtime, request, job_id)


@upload_bp.route('/download-docx/<job_id>')
def download_docx(job_id):
    runtime = get_runtime()
    return upload_api_service.download_docx(runtime, request, job_id)


@upload_bp.route('/download-flashcards-csv/<job_id>')
def download_flashcards_csv(job_id):
    runtime = get_runtime()
    return upload_api_service.download_flashcards_csv(runtime, request, job_id)


@upload_bp.route('/api/processing-averages')
def processing_averages():
    runtime = get_runtime()
    return upload_api_service.processing_averages(runtime, request)


@upload_bp.route('/api/processing-estimate')
def processing_estimate():
    runtime = get_runtime()
    return upload_api_service.processing_estimate(runtime, request)
