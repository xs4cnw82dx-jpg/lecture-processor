"""Reporting resources exclusive to authenticated Academy authors."""
from flask import Blueprint
from google.api_core.exceptions import GoogleAPICallError

from lecture_processor.blueprints.elearning import _handle_elearning_error, _handle_unavailable
from lecture_processor.domains.elearning.model import ElearningError
from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import elearning_service

academy_reports = Blueprint('academy_reports', __name__, url_prefix='/api/elearning/expeditions')
academy_reports.register_error_handler(ElearningError, _handle_elearning_error)
academy_reports.register_error_handler(GoogleAPICallError, _handle_unavailable)
academy_reports.register_error_handler(RuntimeError, _handle_unavailable)


@academy_reports.get('/<expedition_id>/responses/export.xlsx')
def response_workbook(expedition_id):
    return elearning_service.export_responses_csv(get_runtime(), expedition_id, 'xlsx')


@academy_reports.get('/<expedition_id>/outline-results')
def outline_results(expedition_id):
    return elearning_service.outline_results(get_runtime(), expedition_id)
