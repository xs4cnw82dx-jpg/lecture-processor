"""Loopback-hardened Flask API for the local Physio companion."""

from __future__ import annotations

import hmac
import json
import secrets
from pathlib import Path
from urllib.parse import urlsplit

from flask import Blueprint, Flask, Response, jsonify, make_response, render_template, request, session
from werkzeug.exceptions import BadRequest

from .config import CompanionConfig
from .jobs import QueueFull
from .media import InvalidRange, iter_file_range, parse_byte_range
from .service import CompanionService
from .sources import SourceConflict, SourceNotFound, SourceTooLarge


SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1"}


def _hostname(value: str) -> str | None:
    try:
        return urlsplit(f"//{value}").hostname
    except ValueError:
        return None


def _same_origin() -> bool:
    origin = request.headers.get("Origin")
    if not origin:
        return True
    try:
        parsed = urlsplit(origin)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"} or parsed.username or parsed.password:
        return False
    return parsed.netloc.casefold() == request.host.casefold()


def _json_object() -> dict:
    payload = request.get_json(silent=False)
    if not isinstance(payload, dict):
        raise BadRequest("A JSON object is required")
    return payload


def _bool_arg(name: str, default: bool = False) -> bool:
    raw = request.args.get(name)
    if raw is None:
        return default
    return raw.casefold() in {"1", "true", "yes", "on"}


def _error(message: str, status: int, *, code: str = "request_error", **extra):
    return jsonify({"error": {"code": code, "message": message, **extra}}), status


def _ranged_file_response(path: Path, mime_type: str, *, head_only: bool = False) -> Response:
    size = path.stat().st_size
    try:
        start, end, partial = parse_byte_range(request.headers.get("Range"), size)
    except InvalidRange:
        response = make_response("", 416)
        response.headers["Content-Range"] = f"bytes */{size}"
        return response
    length = max(0, end - start + 1)
    response = Response(
        iter_file_range(path, start, length) if not head_only else None,
        status=206 if partial else 200,
        mimetype=mime_type,
        direct_passthrough=True,
    )
    response.headers["Accept-Ranges"] = "bytes"
    response.headers["Content-Length"] = str(length)
    response.headers["Content-Disposition"] = "inline"
    if partial:
        response.headers["Content-Range"] = f"bytes {start}-{end}/{size}"
    return response


def create_companion_blueprint(
    service: CompanionService,
    *,
    url_prefix: str | None = None,
) -> Blueprint:
    blueprint = Blueprint(
        "physio_local_companion",
        __name__,
        url_prefix=url_prefix if url_prefix is not None else service.config.url_prefix,
    )

    @blueprint.before_request
    def enforce_local_security():
        host = _hostname(request.host)
        if host not in LOOPBACK_HOSTS:
            return _error("This service is available only on the local computer", 403, code="loopback_required")
        if request.headers.get("Sec-Fetch-Site", "").casefold() == "cross-site" or not _same_origin():
            return _error("Cross-origin requests are not allowed", 403, code="cross_origin")
        if session.get("physio_owner") is not True:
            return _error("Owner authorization is required", 401, code="owner_auth_required")
        if request.method not in SAFE_METHODS:
            expected = session.get("physio_csrf")
            supplied = request.headers.get("X-CSRF-Token", "")
            if not expected or not supplied or not hmac.compare_digest(expected, supplied):
                return _error("A valid CSRF token is required", 403, code="csrf")
        return None

    @blueprint.after_request
    def local_headers(response: Response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Content-Security-Policy"] = "default-src 'none'; frame-ancestors 'none'"
        response.headers.pop("Access-Control-Allow-Origin", None)
        return response

    @blueprint.get("/health")
    def health():
        return jsonify(
            {
                "status": "ok",
                "local_only": True,
                "vault": str(service.config.vault_path),
                "index": service.index.stats(),
                "codex": {"enabled": bool(service.config.codex_binary)},
            }
        )

    @blueprint.get("/csrf")
    def csrf():
        token = secrets.token_urlsafe(32)
        session["physio_csrf"] = token
        return jsonify({"csrf_token": token})

    @blueprint.post("/index/refresh")
    def refresh_index():
        return jsonify(service.refresh_index())

    @blueprint.get("/regions")
    def regions():
        return jsonify({"regions": service.index.list_regions(include_unreviewed=_bool_arg("include_unreviewed"))})

    @blueprint.get("/search")
    def search():
        query = request.args.get("q", "")
        if len(query) > 4_000:
            return _error("Search query is too long", 400, code="invalid_query")
        try:
            limit = int(request.args.get("limit", "20"))
        except ValueError:
            return _error("limit must be an integer", 400, code="invalid_query")
        results = service.index.search(
            query,
            region=request.args.get("region") or None,
            note_type=request.args.get("type") or None,
            include_unreviewed=_bool_arg("include_unreviewed"),
            limit=limit,
        )
        return jsonify({"query": query, "results": results})

    @blueprint.get("/notes/<path:note_id>")
    def note(note_id: str):
        found = service.index.get_note(note_id, include_unreviewed=_bool_arg("include_unreviewed"))
        if not found:
            found = service.sources.virtual_note(note_id)
            if found:
                return jsonify(found)
        if not found:
            return _error("Note not found", 404, code="not_found")
        for embed in found["embeds"]:
            embed["manifest_id"] = service.media.resolve_target(embed["target"])
        found["obsidian_uri"] = service.obsidian_uri(found)
        return jsonify(found)

    @blueprint.get("/graph")
    def graph():
        return jsonify(
            service.index.graph(
                note_id=request.args.get("note_id"),
                global_graph=_bool_arg("global"),
                include_unreviewed=_bool_arg("include_unreviewed"),
            )
        )

    @blueprint.get("/media")
    def media_list():
        return jsonify({"media": service.media.list_entries()})

    @blueprint.route("/media/<media_id>", methods=["GET", "HEAD"])
    def media(media_id: str):
        entry = service.media.get(media_id)
        if not entry:
            return _error("Media not found", 404, code="not_found")
        return _ranged_file_response(entry.path, entry.mime_type, head_only=request.method == "HEAD")

    @blueprint.get("/sources-manager")
    def sources_manager_list():
        try:
            offset = int(request.args.get("offset", "0"))
            limit = int(request.args.get("limit", "100"))
        except ValueError:
            raise BadRequest("offset en limit moeten gehele getallen zijn")
        managed_arg = request.args.get("managed")
        managed = None if managed_arg is None else managed_arg.casefold() in {"1", "true", "yes", "on"}
        result = service.sources.list_sources(
            category=request.args.get("category") or None,
            review_status=request.args.get("status") or None,
            query=request.args.get("q", ""),
            managed=managed,
            offset=offset,
            limit=limit,
        )
        result["categories"] = service.sources.categories
        return jsonify(result)

    @blueprint.post("/sources-manager/upload")
    def sources_manager_upload():
        upload = request.files.get("file")
        if upload is None or not upload.filename:
            raise BadRequest("Een bronbestand is verplicht")
        result = service.sources.import_stream(
            upload.stream,
            upload.filename,
            category=request.form.get("category") or None,
        )
        service.refresh_index()
        return jsonify(result), 200 if result["deduplicated"] else 201

    @blueprint.post("/sources-manager/auto-triage")
    def sources_manager_auto_triage():
        result = service.sources.auto_triage()
        service.refresh_index()
        return jsonify(result)

    @blueprint.route("/sources-manager/<source_id>/preview", methods=["GET", "HEAD"])
    def sources_manager_preview(source_id: str):
        preview = service.sources.preview_file(source_id)
        if preview is None:
            return _error("Voorvertoning niet beschikbaar", 404, code="not_found")
        return _ranged_file_response(
            preview["path"], preview["mime_type"], head_only=request.method == "HEAD"
        )

    @blueprint.route("/sources-manager/<source_id>", methods=["GET", "PATCH", "DELETE"])
    def sources_manager_item(source_id: str):
        if request.method == "GET":
            found = service.sources.get(source_id)
            if found is None:
                raise SourceNotFound("Bron niet gevonden")
            return jsonify(found)
        if request.method == "PATCH":
            result = service.sources.update(source_id, _json_object())
            service.refresh_index()
            return jsonify(result)
        if not service.sources.delete(source_id):
            raise SourceNotFound("Bron niet gevonden")
        service.refresh_index()
        return "", 204

    @blueprint.post("/sources-manager/<source_id>/review")
    def sources_manager_review(source_id: str):
        result = service.sources.set_review_status(source_id, str(_json_object().get("action", "")))
        service.refresh_index()
        return jsonify(result)

    @blueprint.route("/cases", methods=["GET", "POST"])
    def cases():
        if request.method == "GET":
            return jsonify({"cases": service.cases.list_cases()})
        created = service.cases.create_case(_json_object())
        return jsonify(created), 201

    @blueprint.route("/cases/<case_id>", methods=["GET", "PATCH", "DELETE"])
    def case(case_id: str):
        if request.method == "DELETE":
            if not service.cases.delete_case(case_id):
                return _error("Case not found", 404, code="not_found")
            return "", 204
        if request.method == "PATCH":
            found = service.cases.update_case(case_id, _json_object())
        else:
            found = service.cases.get_case(case_id)
        if not found:
            return _error("Case not found", 404, code="not_found")
        return jsonify(found)

    @blueprint.get("/cases/<case_id>/export")
    def export_case(case_id: str):
        export = service.cases.export_case(case_id)
        if not export:
            return _error("Case not found", 404, code="not_found")
        response = jsonify(export)
        response.headers["Content-Disposition"] = f'attachment; filename="physio-case-{case_id}.json"'
        return response

    @blueprint.route("/cases/<case_id>/sessions", methods=["GET", "POST"])
    def sessions(case_id: str):
        if request.method == "POST":
            result = service.cases.create_session(case_id, _json_object())
            status = 201
        else:
            listed = service.cases.list_sessions(case_id)
            result = {"sessions": listed} if listed is not None else None
            status = 200
        if result is None:
            return _error("Case not found", 404, code="not_found")
        return jsonify(result), status

    @blueprint.route("/cases/<case_id>/sessions/<session_id>", methods=["PATCH", "DELETE"])
    def session_item(case_id: str, session_id: str):
        if request.method == "DELETE":
            if not service.cases.delete_session(case_id, session_id):
                return _error("Session not found", 404, code="not_found")
            return "", 204
        result = service.cases.update_session(case_id, session_id, _json_object())
        if result is None:
            return _error("Session not found", 404, code="not_found")
        return jsonify(result)

    @blueprint.post("/jobs/deep-query")
    def deep_query():
        payload = _json_object()
        query = str(payload.get("query", ""))
        region = str(payload.get("region", "")).strip()
        note_ids = payload.get("note_ids", [])
        if not isinstance(note_ids, list):
            raise BadRequest("note_ids must be a list")
        retrieved = [
            *service.index.search(query, region=region or None, limit=10),
            *service.index.search(query, limit=10),
        ]
        note_ids = list(dict.fromkeys([
            *(str(item) for item in note_ids),
            *(str(item["note_id"]) for item in retrieved),
        ]))
        job = service.jobs.submit_deep_query(
            query,
            note_ids,
            case_context=str(payload.get("case_context", "")),
            case_id=str(payload.get("case_id", "")),
            region=region,
        )
        return jsonify(job), 202

    @blueprint.post("/jobs/documentation")
    def documentation():
        payload = _json_object()
        note_ids = payload.get("note_ids", [])
        if not isinstance(note_ids, list):
            raise BadRequest("note_ids must be a list")
        job = service.jobs.submit_documentation(
            str(payload.get("case_id", "")),
            str(payload.get("document_type", "")),
            [str(item) for item in note_ids],
        )
        return jsonify(job), 202

    @blueprint.route("/jobs/<job_id>", methods=["GET", "DELETE"])
    def job(job_id: str):
        result = service.jobs.cancel(job_id) if request.method == "DELETE" else service.jobs.get(job_id)
        if result is None:
            return _error("Job not found", 404, code="not_found")
        return jsonify(result)

    @blueprint.errorhandler(QueueFull)
    def queue_error(_exc: QueueFull):
        return _error("The local Codex queue is full", 429, code="queue_full")

    @blueprint.errorhandler(SourceNotFound)
    def source_not_found(_exc: SourceNotFound):
        return _error("Bron niet gevonden", 404, code="source_not_found")

    @blueprint.errorhandler(SourceConflict)
    def source_conflict(exc: SourceConflict):
        return _error(str(exc), 409, code="source_conflict")

    @blueprint.errorhandler(SourceTooLarge)
    def source_too_large(exc: SourceTooLarge):
        return _error(str(exc), 413, code="source_too_large")

    @blueprint.errorhandler(ValueError)
    @blueprint.errorhandler(BadRequest)
    def invalid_request(exc):
        return _error(str(exc), 400, code="invalid_request")

    @blueprint.errorhandler(KeyError)
    def missing_resource(_exc: KeyError):
        return _error("Referenced local resource not found", 404, code="not_found")

    return blueprint


def create_companion_app(
    config: CompanionConfig | None = None,
    *,
    service: CompanionService | None = None,
    refresh_index: bool = True,
) -> Flask:
    config = config or CompanionConfig()
    service = service or CompanionService(config, refresh_index=refresh_index)
    repository_root = Path(__file__).resolve().parents[2]
    app = Flask(
        "physio_companion",
        template_folder=str(repository_root / "templates"),
        static_folder=str(repository_root / "static"),
        static_url_path="/static",
    )
    app.config.update(
        SECRET_KEY=config.secret_key,
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SAMESITE="Strict",
        SESSION_COOKIE_SECURE=False,
        MAX_CONTENT_LENGTH=config.max_source_bytes + 1024 * 1024,
        PERMANENT_SESSION_LIFETIME=30 * 24 * 60 * 60,
    )

    @app.before_request
    def standalone_loopback_guard():
        if _hostname(request.host) not in LOOPBACK_HOSTS:
            return _error("This service is available only on the local computer", 403, code="loopback_required")
        if request.headers.get("Sec-Fetch-Site", "").casefold() == "cross-site" or not _same_origin():
            return _error("Cross-origin requests are not allowed", 403, code="cross_origin")
        public_bootstrap_path = (
            request.path in {"/physio", "/healthz", "/owner-session"}
            or request.path.startswith("/static/")
        )
        if not public_bootstrap_path and session.get("physio_owner") is not True:
            return _error("Owner authorization is required", 401, code="owner_auth_required")
        return None

    @app.get("/physio")
    def local_physio_workspace():
        return render_template("physio_local.html")

    @app.post("/owner-session")
    def establish_owner_session():
        payload = request.get_json(silent=True) or {}
        supplied = str(payload.get("owner_token", "") or "")
        if not supplied or not hmac.compare_digest(supplied, config.owner_token):
            return _error("Owner authorization failed", 403, code="owner_auth_failed")
        session.clear()
        session["physio_owner"] = True
        session.permanent = True
        return jsonify({"ok": True})

    @app.get("/healthz")
    def standalone_health():
        return jsonify({"status": "ok", "local_only": True})

    @app.after_request
    def standalone_local_headers(response: Response):
        response.headers["Cache-Control"] = "no-store"
        response.headers["X-Content-Type-Options"] = "nosniff"
        response.headers["Referrer-Policy"] = "no-referrer"
        response.headers["Cross-Origin-Opener-Policy"] = "same-origin"
        response.headers["Cross-Origin-Resource-Policy"] = "same-origin"
        if request.path == "/physio":
            response.headers["Content-Security-Policy"] = (
                "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; "
                "connect-src 'self'; frame-src 'self'; font-src 'self'; frame-ancestors 'none'; "
                "base-uri 'none'; form-action 'self'"
            )
        response.headers.pop("Access-Control-Allow-Origin", None)
        return response

    app.register_blueprint(create_companion_blueprint(service))
    app.extensions["physio_companion"] = service
    service.start_watcher()
    return app
