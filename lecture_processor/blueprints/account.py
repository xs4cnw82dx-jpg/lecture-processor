from flask import Blueprint

account_bp = Blueprint('account_api', __name__)


@account_bp.route('/api/account/export', methods=['GET'])
def export_account_data():
    from lecture_processor import legacy_app

    return legacy_app.export_account_data_impl()


@account_bp.route('/api/account/delete', methods=['POST'])
def delete_account_data():
    from lecture_processor import legacy_app

    return legacy_app.delete_account_data_impl()
