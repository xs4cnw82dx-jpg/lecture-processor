from flask import Blueprint

payments_bp = Blueprint('payments_api', __name__)


@payments_bp.route('/api/config', methods=['GET'])
def get_config():
    from lecture_processor import legacy_app

    return legacy_app.get_config_impl()


@payments_bp.route('/api/create-checkout-session', methods=['POST'])
def create_checkout_session():
    from lecture_processor import legacy_app

    return legacy_app.create_checkout_session_impl()


@payments_bp.route('/api/confirm-checkout-session', methods=['GET'])
def confirm_checkout_session():
    from lecture_processor import legacy_app

    return legacy_app.confirm_checkout_session_impl()


@payments_bp.route('/api/stripe-webhook', methods=['POST'])
def stripe_webhook():
    from lecture_processor import legacy_app

    return legacy_app.stripe_webhook_impl()


@payments_bp.route('/api/purchase-history', methods=['GET'])
def purchase_history():
    from lecture_processor import legacy_app

    return legacy_app.get_purchase_history_impl()
