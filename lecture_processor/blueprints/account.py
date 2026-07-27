from flask import Blueprint, request

from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import account_data_service

account_bp = Blueprint('account_api', __name__)


@account_bp.route('/api/account/export', methods=['GET'])
def export_account_data():
    runtime = get_runtime()
    return account_data_service.export_account_data(runtime, request)


@account_bp.route('/api/account/export-bundle', methods=['POST'])
def export_account_bundle():
    runtime = get_runtime()
    return account_data_service.export_account_bundle(runtime, request)


@account_bp.route('/api/account/exports/<job_id>', methods=['GET'])
def get_account_export_status(job_id):
    runtime = get_runtime()
    return account_data_service.get_account_export_status(runtime, request, job_id)


@account_bp.route('/api/account/exports/<job_id>/download', methods=['GET'])
def download_account_export(job_id):
    runtime = get_runtime()
    return account_data_service.download_account_export(runtime, request, job_id)


@account_bp.route('/api/account/delete', methods=['POST'])
def delete_account_data():
    runtime = get_runtime()
    return account_data_service.delete_account_data(runtime, request)
