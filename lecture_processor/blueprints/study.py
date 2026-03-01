from flask import Blueprint

study_bp = Blueprint('study_api', __name__)


@study_bp.route('/api/study-progress', methods=['GET'])
def get_study_progress():
    from lecture_processor import legacy_app

    return legacy_app.get_study_progress_impl()


@study_bp.route('/api/study-progress', methods=['PUT'])
def update_study_progress():
    from lecture_processor import legacy_app

    return legacy_app.update_study_progress_impl()


@study_bp.route('/api/study-progress/summary', methods=['GET'])
def get_study_progress_summary():
    from lecture_processor import legacy_app

    return legacy_app.get_study_progress_summary_impl()


@study_bp.route('/api/study-packs', methods=['GET'])
def get_study_packs():
    from lecture_processor import legacy_app

    return legacy_app.get_study_packs_impl()


@study_bp.route('/api/study-packs', methods=['POST'])
def create_study_pack():
    from lecture_processor import legacy_app

    return legacy_app.create_study_pack_impl()


@study_bp.route('/api/study-packs/<pack_id>', methods=['GET'])
def get_study_pack(pack_id):
    from lecture_processor import legacy_app

    return legacy_app.get_study_pack_impl(pack_id)


@study_bp.route('/api/study-packs/<pack_id>', methods=['PATCH'])
def update_study_pack(pack_id):
    from lecture_processor import legacy_app

    return legacy_app.update_study_pack_impl(pack_id)


@study_bp.route('/api/study-packs/<pack_id>', methods=['DELETE'])
def delete_study_pack(pack_id):
    from lecture_processor import legacy_app

    return legacy_app.delete_study_pack_impl(pack_id)


@study_bp.route('/api/study-folders', methods=['GET'])
def get_study_folders():
    from lecture_processor import legacy_app

    return legacy_app.get_study_folders_impl()


@study_bp.route('/api/study-packs/<pack_id>/audio-url', methods=['GET'])
def get_study_pack_audio_url(pack_id):
    from lecture_processor import legacy_app

    return legacy_app.get_study_pack_audio_url_impl(pack_id)


@study_bp.route('/api/study-packs/<pack_id>/audio', methods=['GET'])
def stream_study_pack_audio(pack_id):
    from lecture_processor import legacy_app

    return legacy_app.stream_study_pack_audio_impl(pack_id)


@study_bp.route('/api/audio-stream/<token>', methods=['GET'])
def stream_audio_token(token):
    from lecture_processor import legacy_app

    return legacy_app.stream_audio_token_impl(token)


@study_bp.route('/api/study-folders', methods=['POST'])
def create_study_folder():
    from lecture_processor import legacy_app

    return legacy_app.create_study_folder_impl()


@study_bp.route('/api/study-folders/<folder_id>', methods=['PATCH'])
def update_study_folder(folder_id):
    from lecture_processor import legacy_app

    return legacy_app.update_study_folder_impl(folder_id)


@study_bp.route('/api/study-folders/<folder_id>', methods=['DELETE'])
def delete_study_folder(folder_id):
    from lecture_processor import legacy_app

    return legacy_app.delete_study_folder_impl(folder_id)


@study_bp.route('/api/study-packs/<pack_id>/export-flashcards-csv', methods=['GET'])
def export_study_pack_flashcards_csv(pack_id):
    from lecture_processor import legacy_app

    return legacy_app.export_study_pack_flashcards_csv_impl(pack_id)


@study_bp.route('/api/study-packs/<pack_id>/export-notes', methods=['GET'])
def export_study_pack_notes(pack_id):
    from lecture_processor import legacy_app

    return legacy_app.export_study_pack_notes_impl(pack_id)


@study_bp.route('/api/study-packs/<pack_id>/export-pdf', methods=['GET'])
def export_study_pack_pdf(pack_id):
    from lecture_processor import legacy_app

    return legacy_app.export_study_pack_pdf_impl(pack_id)
