from flask import Blueprint, request

from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import admin_api_service, workout_service

admin_bp = Blueprint('admin_api', __name__)


@admin_bp.route('/api/admin/overview', methods=['GET'])
def admin_overview():
    runtime = get_runtime()
    return admin_api_service.admin_overview(runtime, request)


@admin_bp.route('/api/admin/export', methods=['GET'])
def admin_export():
    runtime = get_runtime()
    return admin_api_service.admin_export(runtime, request)


@admin_bp.route('/api/admin/prompts', methods=['GET'])
def admin_prompts():
    runtime = get_runtime()
    return admin_api_service.admin_prompts(runtime, request)


@admin_bp.route('/api/admin/model-pricing', methods=['GET'])
def admin_model_pricing():
    runtime = get_runtime()
    return admin_api_service.admin_model_pricing(runtime, request)


@admin_bp.route('/api/admin/cost-analysis', methods=['POST'])
def admin_cost_analysis():
    runtime = get_runtime()
    return admin_api_service.admin_cost_analysis(runtime, request)


@admin_bp.route('/api/admin/cost-analysis/export', methods=['POST'])
def admin_cost_analysis_export():
    runtime = get_runtime()
    return admin_api_service.admin_cost_analysis_export(runtime, request)


@admin_bp.route('/api/admin/batch-jobs', methods=['GET'])
def admin_batch_jobs():
    runtime = get_runtime()
    return admin_api_service.admin_batch_jobs(runtime, request)


@admin_bp.route('/api/admin/users/search', methods=['GET'])
def admin_user_search():
    runtime = get_runtime()
    return admin_api_service.admin_user_search(runtime, request)


@admin_bp.route('/api/admin/users/<uid>/credits/grant', methods=['POST'])
def admin_grant_user_credits(uid):
    runtime = get_runtime()
    return admin_api_service.admin_grant_user_credits(runtime, request, uid)


@admin_bp.route('/api/admin/users/<uid>/credits/unlimited', methods=['PATCH'])
def admin_update_user_unlimited(uid):
    runtime = get_runtime()
    return admin_api_service.admin_update_user_unlimited(runtime, request, uid)


@admin_bp.route('/api/admin/credit-grants', methods=['GET'])
def admin_credit_grants():
    runtime = get_runtime()
    return admin_api_service.admin_credit_grants(runtime, request)


@admin_bp.route('/api/admin/maintenance/study-audio/cleanup-stale', methods=['POST'])
def admin_cleanup_stale_study_audio():
    runtime = get_runtime()
    return admin_api_service.admin_cleanup_stale_study_audio(runtime, request)


@admin_bp.route('/api/admin/workout/bootstrap', methods=['GET'])
def workout_bootstrap():
    return workout_service.bootstrap(get_runtime(), request)


@admin_bp.route('/api/admin/workout/profile', methods=['PUT'])
def workout_update_profile():
    return workout_service.update_profile(get_runtime(), request)


@admin_bp.route('/api/admin/workout/start-tests', methods=['PUT'])
def workout_update_start_tests():
    return workout_service.update_start_tests(get_runtime(), request)


@admin_bp.route('/api/admin/workout/cycles', methods=['POST'])
def workout_start_cycle():
    return workout_service.start_cycle(get_runtime(), request)


@admin_bp.route('/api/admin/workout/cycles/reset', methods=['POST'])
def workout_reset_cycle():
    return workout_service.reset_cycle(get_runtime(), request)


@admin_bp.route('/api/admin/workout/program/restore', methods=['POST'])
def workout_restore_program():
    return workout_service.restore_baseline(get_runtime(), request)


@admin_bp.route('/api/admin/workout/exercises', methods=['GET'])
def workout_list_exercises():
    return workout_service.list_exercises(get_runtime(), request)


@admin_bp.route('/api/admin/workout/exercises', methods=['POST'])
def workout_create_exercise():
    return workout_service.create_exercise(get_runtime(), request)


@admin_bp.route('/api/admin/workout/exercises/<exercise_id>', methods=['PATCH'])
def workout_update_exercise(exercise_id):
    return workout_service.update_exercise(get_runtime(), request, exercise_id)


@admin_bp.route('/api/admin/workout/routines', methods=['GET'])
def workout_list_routines():
    return workout_service.list_routines(get_runtime(), request)


@admin_bp.route('/api/admin/workout/routines', methods=['POST'])
def workout_create_routine():
    return workout_service.create_routine(get_runtime(), request)


@admin_bp.route('/api/admin/workout/routines/<routine_id>', methods=['PATCH'])
def workout_update_routine(routine_id):
    return workout_service.update_routine(get_runtime(), request, routine_id)


@admin_bp.route('/api/admin/workout/routines/<routine_id>', methods=['DELETE'])
def workout_delete_routine(routine_id):
    return workout_service.delete_routine(get_runtime(), request, routine_id)


@admin_bp.route('/api/admin/workout/routines/<routine_id>/duplicate', methods=['POST'])
def workout_duplicate_routine(routine_id):
    return workout_service.duplicate_routine(get_runtime(), request, routine_id)


@admin_bp.route('/api/admin/workout/occurrences', methods=['GET'])
def workout_list_occurrences():
    return workout_service.list_occurrences(get_runtime(), request)


@admin_bp.route('/api/admin/workout/occurrences/<occurrence_id>', methods=['PATCH'])
def workout_update_occurrence(occurrence_id):
    return workout_service.update_occurrence(get_runtime(), request, occurrence_id)


@admin_bp.route('/api/admin/workout/sessions', methods=['GET'])
def workout_list_sessions():
    return workout_service.list_sessions(get_runtime(), request)


@admin_bp.route('/api/admin/workout/sessions', methods=['POST'])
def workout_start_session():
    return workout_service.start_session(get_runtime(), request)


@admin_bp.route('/api/admin/workout/sessions/<session_id>', methods=['PATCH'])
def workout_update_session(session_id):
    return workout_service.update_session(get_runtime(), request, session_id)


@admin_bp.route('/api/admin/workout/sessions/<session_id>/finish', methods=['POST'])
def workout_finish_session(session_id):
    return workout_service.finish_session(get_runtime(), request, session_id)


@admin_bp.route('/api/admin/workout/sessions/<session_id>/discard', methods=['POST'])
def workout_discard_session(session_id):
    return workout_service.discard_session(get_runtime(), request, session_id)


@admin_bp.route('/api/admin/workout/bodyweight', methods=['GET'])
def workout_list_bodyweight():
    return workout_service.list_bodyweight(get_runtime(), request)


@admin_bp.route('/api/admin/workout/bodyweight', methods=['PUT'])
def workout_upsert_bodyweight():
    return workout_service.upsert_bodyweight(get_runtime(), request)


@admin_bp.route('/api/admin/workout/statistics', methods=['GET'])
def workout_statistics():
    return workout_service.statistics(get_runtime(), request)


@admin_bp.route('/api/admin/workout/shares', methods=['POST'])
def workout_create_share():
    return workout_service.create_share(get_runtime(), request)


@admin_bp.route('/api/admin/workout/shares/<token>', methods=['DELETE'])
def workout_revoke_share(token):
    return workout_service.revoke_share(get_runtime(), request, token)


@admin_bp.route('/api/workout-shares/<token>', methods=['GET'])
def workout_public_share(token):
    return workout_service.public_share(get_runtime(), token)
