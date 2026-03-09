from flask import Blueprint, request

from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import study_api_service

study_bp = Blueprint('study_api', __name__)


@study_bp.route('/api/study-progress', methods=['GET'])
def get_study_progress():
    runtime = get_runtime()
    return study_api_service.get_study_progress(runtime, request)


@study_bp.route('/api/study-progress', methods=['PUT'])
def update_study_progress():
    runtime = get_runtime()
    return study_api_service.update_study_progress(runtime, request)


@study_bp.route('/api/study-progress/summary', methods=['GET'])
def get_study_progress_summary():
    runtime = get_runtime()
    return study_api_service.get_study_progress_summary(runtime, request)


@study_bp.route('/api/study-packs', methods=['GET'])
def get_study_packs():
    runtime = get_runtime()
    return study_api_service.get_study_packs(runtime, request)


@study_bp.route('/api/study-packs', methods=['POST'])
def create_study_pack():
    runtime = get_runtime()
    return study_api_service.create_study_pack(runtime, request)


@study_bp.route('/api/study-packs/<pack_id>', methods=['GET'])
def get_study_pack(pack_id):
    runtime = get_runtime()
    return study_api_service.get_study_pack(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>', methods=['PATCH'])
def update_study_pack(pack_id):
    runtime = get_runtime()
    return study_api_service.update_study_pack(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>', methods=['DELETE'])
def delete_study_pack(pack_id):
    runtime = get_runtime()
    return study_api_service.delete_study_pack(runtime, request, pack_id)


@study_bp.route('/api/study-folders', methods=['GET'])
def get_study_folders():
    runtime = get_runtime()
    return study_api_service.get_study_folders(runtime, request)


@study_bp.route('/api/study-packs/<pack_id>/audio', methods=['GET'])
def stream_study_pack_audio(pack_id):
    runtime = get_runtime()
    return study_api_service.stream_study_pack_audio(runtime, request, pack_id)


@study_bp.route('/api/study-folders', methods=['POST'])
def create_study_folder():
    runtime = get_runtime()
    return study_api_service.create_study_folder(runtime, request)


@study_bp.route('/api/study-folders/<folder_id>', methods=['PATCH'])
def update_study_folder(folder_id):
    runtime = get_runtime()
    return study_api_service.update_study_folder(runtime, request, folder_id)


@study_bp.route('/api/study-folders/<folder_id>', methods=['DELETE'])
def delete_study_folder(folder_id):
    runtime = get_runtime()
    return study_api_service.delete_study_folder(runtime, request, folder_id)


@study_bp.route('/api/study-packs/<pack_id>/export-flashcards-csv', methods=['GET'])
def export_study_pack_flashcards_csv(pack_id):
    runtime = get_runtime()
    return study_api_service.export_study_pack_flashcards_csv(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>/export-notes', methods=['GET'])
def export_study_pack_notes(pack_id):
    runtime = get_runtime()
    return study_api_service.export_study_pack_notes(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>/export-pdf', methods=['GET'])
def export_study_pack_pdf(pack_id):
    runtime = get_runtime()
    return study_api_service.export_study_pack_pdf(runtime, request, pack_id)
