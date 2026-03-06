from flask import Blueprint, request

from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import admin_api_service

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
