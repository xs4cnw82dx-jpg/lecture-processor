"""Permanent retirement stubs for the former hosted Physio API."""

from flask import Blueprint, jsonify


physio_bp = Blueprint("physio_api", __name__)


def _retired_response():
    return jsonify({
        "error": "The hosted Physio API has been retired.",
        "code": "physio_local_companion_required",
        "local_workspace": "/physio",
    }), 410


@physio_bp.route("/api/physio/transcriptions", methods=["POST"])
def create_physio_transcription():
    return _retired_response()


@physio_bp.route("/api/physio/soap", methods=["POST"])
def generate_physio_soap():
    return _retired_response()


@physio_bp.route("/api/physio/rps", methods=["POST"])
def generate_physio_rps():
    return _retired_response()


@physio_bp.route("/api/physio/reasoning", methods=["POST"])
def generate_physio_reasoning():
    return _retired_response()


@physio_bp.route("/api/physio/jobs/<job_id>", methods=["GET"])
def get_physio_generation_job(job_id):
    del job_id
    return _retired_response()


@physio_bp.route("/api/physio/knowledge/query", methods=["POST"])
def query_physio_knowledge():
    return _retired_response()


@physio_bp.route("/api/physio/knowledge/status", methods=["GET"])
def get_physio_knowledge_status():
    return _retired_response()


@physio_bp.route("/api/physio/cases", methods=["GET"])
def list_physio_cases():
    return _retired_response()


@physio_bp.route("/api/physio/cases", methods=["POST"])
def create_physio_case():
    return _retired_response()


@physio_bp.route("/api/physio/cases/<case_id>", methods=["PATCH"])
def update_physio_case(case_id):
    del case_id
    return _retired_response()


@physio_bp.route("/api/physio/cases/<case_id>/sessions", methods=["GET"])
def list_physio_case_sessions(case_id):
    del case_id
    return _retired_response()


@physio_bp.route("/api/physio/cases/<case_id>/sessions", methods=["POST"])
def create_physio_case_session(case_id):
    del case_id
    return _retired_response()


@physio_bp.route("/api/physio/cases/<case_id>/sessions", methods=["PATCH"])
def update_physio_case_session(case_id):
    del case_id
    return _retired_response()


@physio_bp.route("/api/physio/export", methods=["POST"])
def export_physio_payload():
    return _retired_response()
