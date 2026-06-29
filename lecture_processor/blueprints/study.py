from flask import Blueprint, request

from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import interview_coding_service, planner_api_service, study_api_service, voice_note_service

study_bp = Blueprint('study_api', __name__)


@study_bp.route('/api/study-progress', methods=['GET'])
def get_study_progress():
    runtime = get_runtime()
    return study_api_service.get_study_progress(runtime, request)


@study_bp.route('/api/planner/settings', methods=['GET'])
def get_planner_settings():
    runtime = get_runtime()
    return planner_api_service.get_planner_settings(runtime, request)


@study_bp.route('/api/planner/settings', methods=['PUT'])
def update_planner_settings():
    runtime = get_runtime()
    return planner_api_service.update_planner_settings(runtime, request)


@study_bp.route('/api/planner/sessions', methods=['GET'])
def list_planner_sessions():
    runtime = get_runtime()
    return planner_api_service.list_planner_sessions(runtime, request)


@study_bp.route('/api/planner/sessions/<session_id>', methods=['PUT'])
def upsert_planner_session(session_id):
    runtime = get_runtime()
    return planner_api_service.upsert_planner_session(runtime, request, session_id)


@study_bp.route('/api/planner/sessions/<session_id>', methods=['DELETE'])
def delete_planner_session(session_id):
    runtime = get_runtime()
    return planner_api_service.delete_planner_session(runtime, request, session_id)


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


@study_bp.route('/api/study-packs/bulk-folder', methods=['PATCH'])
def bulk_move_study_packs():
    runtime = get_runtime()
    return study_api_service.bulk_move_study_packs(runtime, request)


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


@study_bp.route('/api/study-packs/<pack_id>/audio-token', methods=['POST'])
def create_study_pack_audio_token(pack_id):
    runtime = get_runtime()
    return study_api_service.create_study_pack_audio_token(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>/audio-stream', methods=['GET'])
def stream_study_pack_audio_with_token(pack_id):
    runtime = get_runtime()
    return study_api_service.stream_study_pack_audio_with_token(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>/share', methods=['GET'])
def get_study_pack_share(pack_id):
    runtime = get_runtime()
    return study_api_service.get_study_pack_share(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>/share', methods=['PUT'])
def update_study_pack_share(pack_id):
    runtime = get_runtime()
    return study_api_service.update_study_pack_share(runtime, request, pack_id)


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


@study_bp.route('/api/study-folders/<folder_id>/share', methods=['GET'])
def get_study_folder_share(folder_id):
    runtime = get_runtime()
    return study_api_service.get_study_folder_share(runtime, request, folder_id)


@study_bp.route('/api/study-folders/<folder_id>/share', methods=['PUT'])
def update_study_folder_share(folder_id):
    runtime = get_runtime()
    return study_api_service.update_study_folder_share(runtime, request, folder_id)


@study_bp.route('/api/shared/<share_token>', methods=['GET'])
def get_public_study_share(share_token):
    runtime = get_runtime()
    return study_api_service.get_public_study_share(runtime, request, share_token)


@study_bp.route('/api/shared/<share_token>/packs/<pack_id>', methods=['GET'])
def get_public_shared_folder_pack(share_token, pack_id):
    runtime = get_runtime()
    return study_api_service.get_public_shared_folder_pack(runtime, request, share_token, pack_id)


@study_bp.route('/api/study-packs/<pack_id>/export-flashcards-csv', methods=['GET'])
def export_study_pack_flashcards_csv(pack_id):
    runtime = get_runtime()
    return study_api_service.export_study_pack_flashcards_csv(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>/export-notes', methods=['GET'])
def export_study_pack_notes(pack_id):
    runtime = get_runtime()
    return study_api_service.export_study_pack_notes(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>/export-source', methods=['GET'])
def export_study_pack_source(pack_id):
    runtime = get_runtime()
    return study_api_service.export_study_pack_source(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>/export-pdf', methods=['GET'])
def export_study_pack_pdf(pack_id):
    runtime = get_runtime()
    return study_api_service.export_study_pack_pdf(runtime, request, pack_id)


@study_bp.route('/api/study-packs/<pack_id>/export-annotated-pdf', methods=['POST'])
def export_study_pack_annotated_pdf(pack_id):
    runtime = get_runtime()
    return study_api_service.export_study_pack_annotated_pdf(runtime, request, pack_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>', methods=['GET'])
def get_interview_coding_state(pack_id):
    runtime = get_runtime()
    return interview_coding_service.get_coding_state(runtime, request, pack_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/codes', methods=['POST'])
def create_interview_code(pack_id):
    runtime = get_runtime()
    return interview_coding_service.create_code(runtime, request, pack_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/codes/<code_id>', methods=['PATCH'])
def update_interview_code(pack_id, code_id):
    runtime = get_runtime()
    return interview_coding_service.update_code(runtime, request, pack_id, code_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/codes/<code_id>', methods=['DELETE'])
def delete_interview_code(pack_id, code_id):
    runtime = get_runtime()
    return interview_coding_service.delete_code(runtime, request, pack_id, code_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/codes/<code_id>/merge', methods=['POST'])
def merge_interview_code(pack_id, code_id):
    runtime = get_runtime()
    return interview_coding_service.merge_code(runtime, request, pack_id, code_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/quotations', methods=['POST'])
def create_interview_quotation(pack_id):
    runtime = get_runtime()
    return interview_coding_service.create_quotation(runtime, request, pack_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/quotations/<quotation_id>', methods=['PATCH'])
def update_interview_quotation(pack_id, quotation_id):
    runtime = get_runtime()
    return interview_coding_service.update_quotation(runtime, request, pack_id, quotation_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/quotations/<quotation_id>', methods=['DELETE'])
def delete_interview_quotation(pack_id, quotation_id):
    runtime = get_runtime()
    return interview_coding_service.delete_quotation(runtime, request, pack_id, quotation_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/ai-runs', methods=['POST'])
def start_interview_ai_coding_run(pack_id):
    runtime = get_runtime()
    return interview_coding_service.start_ai_coding_run(runtime, request, pack_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/ai-runs/<run_id>/accept', methods=['POST'])
def accept_interview_ai_coding_run(pack_id, run_id):
    runtime = get_runtime()
    return interview_coding_service.accept_ai_coding_run(runtime, request, pack_id, run_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/ai-runs/<run_id>/reject', methods=['POST'])
def reject_interview_ai_coding_run(pack_id, run_id):
    runtime = get_runtime()
    return interview_coding_service.reject_ai_coding_run(runtime, request, pack_id, run_id)


@study_bp.route('/api/interview-coding/packs/<pack_id>/export-pdf', methods=['GET'])
def export_interview_coding_pdf(pack_id):
    runtime = get_runtime()
    return interview_coding_service.export_coding_pdf(runtime, request, pack_id)


@study_bp.route('/api/voice-notes', methods=['POST'])
def create_voice_note():
    runtime = get_runtime()
    return voice_note_service.create_voice_note(runtime, request)


@study_bp.route('/api/voice-notes/jobs/<job_id>', methods=['GET'])
def get_voice_note_job_status(job_id):
    runtime = get_runtime()
    return voice_note_service.get_voice_note_job_status(runtime, request, job_id)


@study_bp.route('/api/voice-notes/<pack_id>/metadata', methods=['PATCH'])
def update_voice_note_metadata(pack_id):
    runtime = get_runtime()
    return voice_note_service.update_voice_note_metadata(runtime, request, pack_id)


@study_bp.route('/api/voice-notes/<pack_id>/study-tools', methods=['POST'])
def regenerate_voice_note_study_tools(pack_id):
    runtime = get_runtime()
    return voice_note_service.regenerate_voice_note_study_tools(runtime, request, pack_id)
