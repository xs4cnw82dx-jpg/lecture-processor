from flask import Blueprint, request

from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import auth_api_service

account_bp = Blueprint('account_api', __name__)


@account_bp.route('/api/account/export', methods=['GET'])
def export_account_data():
    runtime = get_runtime()
    return auth_api_service.export_account_data(runtime, request)


@account_bp.route('/api/account/export-bundle', methods=['POST'])
def export_account_bundle():
    runtime = get_runtime()
    return auth_api_service.export_account_bundle(runtime, request)


@account_bp.route('/api/account/delete', methods=['POST'])
def delete_account_data():
    runtime = get_runtime()
    return auth_api_service.delete_account_data(runtime, request)
