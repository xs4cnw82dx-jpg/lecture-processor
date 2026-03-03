from flask import Blueprint, request

from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import auth_api_service

auth_bp = Blueprint('auth_api', __name__)


@auth_bp.route('/api/session/login', methods=['POST'])
def create_admin_session():
    runtime = get_runtime()
    return auth_api_service.create_admin_session(runtime, request)


@auth_bp.route('/api/session/logout', methods=['POST'])
def clear_admin_session():
    runtime = get_runtime()
    return auth_api_service.clear_admin_session(runtime, request)


@auth_bp.route('/api/verify-email', methods=['POST'])
def verify_email():
    runtime = get_runtime()
    return auth_api_service.verify_email(runtime, request)


@auth_bp.route('/api/dev/sentry-test', methods=['POST'])
def dev_sentry_test():
    runtime = get_runtime()
    return auth_api_service.dev_sentry_test(runtime, request)


@auth_bp.route('/api/analytics/event', methods=['POST'])
@auth_bp.route('/api/lp-event', methods=['POST'])
def ingest_analytics_event():
    runtime = get_runtime()
    return auth_api_service.ingest_analytics_event(runtime, request)


@auth_bp.route('/api/auth/user', methods=['GET'])
def get_user():
    runtime = get_runtime()
    return auth_api_service.get_user(runtime, request)


@auth_bp.route('/api/user-preferences', methods=['GET'])
def get_user_preferences():
    runtime = get_runtime()
    return auth_api_service.get_user_preferences(runtime, request)


@auth_bp.route('/api/user-preferences', methods=['PUT'])
def update_user_preferences():
    runtime = get_runtime()
    return auth_api_service.update_user_preferences(runtime, request)
