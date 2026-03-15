from flask import Blueprint, request

from lecture_processor.runtime.container import get_runtime
from lecture_processor.services import physio_api_service

physio_bp = Blueprint("physio_api", __name__)


@physio_bp.route("/api/physio/transcriptions", methods=["POST"])
def create_physio_transcription():
    runtime = get_runtime()
    return physio_api_service.create_transcription_job(runtime, request)


@physio_bp.route("/api/physio/soap", methods=["POST"])
def generate_physio_soap():
    runtime = get_runtime()
    return physio_api_service.generate_soap(runtime, request)


@physio_bp.route("/api/physio/rps", methods=["POST"])
def generate_physio_rps():
    runtime = get_runtime()
    return physio_api_service.generate_rps(runtime, request)


@physio_bp.route("/api/physio/reasoning", methods=["POST"])
def generate_physio_reasoning():
    runtime = get_runtime()
    return physio_api_service.generate_reasoning(runtime, request)


@physio_bp.route("/api/physio/knowledge/query", methods=["POST"])
def query_physio_knowledge():
    runtime = get_runtime()
    return physio_api_service.knowledge_query(runtime, request)


@physio_bp.route("/api/physio/knowledge/status", methods=["GET"])
def get_physio_knowledge_status():
    runtime = get_runtime()
    return physio_api_service.knowledge_status(runtime, request)


@physio_bp.route("/api/physio/cases", methods=["GET"])
def list_physio_cases():
    runtime = get_runtime()
    return physio_api_service.list_cases(runtime, request)


@physio_bp.route("/api/physio/cases", methods=["POST"])
def create_physio_case():
    runtime = get_runtime()
    return physio_api_service.create_case(runtime, request)


@physio_bp.route("/api/physio/cases/<case_id>", methods=["PATCH"])
def update_physio_case(case_id):
    runtime = get_runtime()
    return physio_api_service.update_case(runtime, request, case_id)


@physio_bp.route("/api/physio/cases/<case_id>/sessions", methods=["GET"])
def list_physio_case_sessions(case_id):
    runtime = get_runtime()
    return physio_api_service.list_case_sessions(runtime, request, case_id)


@physio_bp.route("/api/physio/cases/<case_id>/sessions", methods=["POST"])
def create_physio_case_session(case_id):
    runtime = get_runtime()
    return physio_api_service.create_case_session(runtime, request, case_id)


@physio_bp.route("/api/physio/cases/<case_id>/sessions", methods=["PATCH"])
def update_physio_case_session(case_id):
    runtime = get_runtime()
    return physio_api_service.update_case_session(runtime, request, case_id)


@physio_bp.route("/api/physio/export", methods=["POST"])
def export_physio_payload():
    runtime = get_runtime()
    return physio_api_service.export_payload(runtime, request)
