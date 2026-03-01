from flask import Blueprint

auth_bp = Blueprint('auth_api', __name__)


@auth_bp.route('/api/session/login', methods=['POST'])
def create_admin_session():
    from lecture_processor import legacy_app

    return legacy_app.create_admin_session_impl()


@auth_bp.route('/api/session/logout', methods=['POST'])
def clear_admin_session():
    from lecture_processor import legacy_app

    return legacy_app.clear_admin_session_impl()


@auth_bp.route('/api/verify-email', methods=['POST'])
def verify_email():
    from lecture_processor import legacy_app

    return legacy_app.verify_email_impl()


@auth_bp.route('/api/dev/sentry-test', methods=['POST'])
def dev_sentry_test():
    from lecture_processor import legacy_app

    return legacy_app.dev_sentry_test_impl()


@auth_bp.route('/api/analytics/event', methods=['POST'])
@auth_bp.route('/api/lp-event', methods=['POST'])
def ingest_analytics_event():
    from lecture_processor import legacy_app

    return legacy_app.ingest_analytics_event_impl()


@auth_bp.route('/api/auth/user', methods=['GET'])
def get_user():
    from lecture_processor import legacy_app

    return legacy_app.get_user_impl()


@auth_bp.route('/api/user-preferences', methods=['GET'])
def get_user_preferences():
    from lecture_processor import legacy_app

    return legacy_app.get_user_preferences_impl()


@auth_bp.route('/api/user-preferences', methods=['PUT'])
def update_user_preferences():
    from lecture_processor import legacy_app

    return legacy_app.update_user_preferences_impl()
