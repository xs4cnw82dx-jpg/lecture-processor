"""Signed-in navigation and dashboard endpoints for the standalone Academy."""
from flask import Blueprint, jsonify, request
from google.api_core.exceptions import GoogleAPICallError

from lecture_processor.blueprints.elearning import _handle_elearning_error, _handle_unavailable
from lecture_processor.domains.elearning.model import ElearningError
from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import academy_overview

overview_bp = Blueprint('academy_overview', __name__, url_prefix='/api/academy')
overview_bp.register_error_handler(ElearningError, _handle_elearning_error)
overview_bp.register_error_handler(GoogleAPICallError, _handle_unavailable)
overview_bp.register_error_handler(RuntimeError, _handle_unavailable)


@overview_bp.get('/navigation')
def navigation():
    return jsonify(academy_overview.navigation(get_runtime()))


@overview_bp.get('/overview')
def overview():
    return jsonify(academy_overview.dashboard(get_runtime(), request.args))
