from flask import Blueprint, jsonify, request
from werkzeug.exceptions import InternalServerError

from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import payments_api_service

payments_bp = Blueprint('payments_api', __name__)


@payments_bp.errorhandler(InternalServerError)
def unexpected_payment_error(_error):
    # Flask records the original exception before invoking the 500 handler.
    return jsonify(error='Payments are temporarily unavailable. Please try again.'), 500


@payments_bp.route('/api/config', methods=['GET'])
def get_config():
    runtime = get_runtime()
    return payments_api_service.get_config(runtime)


@payments_bp.route('/api/create-checkout-session', methods=['POST'])
def create_checkout_session():
    runtime = get_runtime()
    return payments_api_service.create_checkout_session(runtime, request)


@payments_bp.route('/api/confirm-checkout-session', methods=['GET'])
def confirm_checkout_session():
    runtime = get_runtime()
    return payments_api_service.confirm_checkout_session(runtime, request)


@payments_bp.route('/api/stripe-webhook', methods=['POST'])
def stripe_webhook():
    runtime = get_runtime()
    return payments_api_service.stripe_webhook(runtime, request)


@payments_bp.route('/api/purchase-history', methods=['GET'])
def purchase_history():
    runtime = get_runtime()
    return payments_api_service.get_purchase_history(runtime, request)
