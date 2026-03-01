from flask import Blueprint

admin_bp = Blueprint('admin_api', __name__)


@admin_bp.route('/api/admin/overview', methods=['GET'])
def admin_overview():
    from lecture_processor import legacy_app

    return legacy_app.admin_overview_impl()


@admin_bp.route('/api/admin/export', methods=['GET'])
def admin_export():
    from lecture_processor import legacy_app

    return legacy_app.admin_export_impl()
