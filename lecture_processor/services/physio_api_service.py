"""API handlers for Physio Assistant."""

from __future__ import annotations

import io
import json
import os
import re
import time
from datetime import datetime

from lecture_processor.domains.account import lifecycle as account_lifecycle
from lecture_processor.domains.ai import provider as ai_provider
from lecture_processor.domains.runtime_jobs import store as runtime_jobs_store
from lecture_processor.domains.physio import access as physio_access
from lecture_processor.domains.physio import export as physio_export
from lecture_processor.domains.physio import knowledge as physio_knowledge
from lecture_processor.domains.physio import prompts as physio_prompts
from lecture_processor.domains.physio import transcription as physio_transcription
from lecture_processor.repositories import physio_repo
from lecture_processor.runtime.job_dispatcher import JobQueueFullError


DEFAULT_BODY_REGION = "algemeen"
DEFAULT_SESSION_TYPE = "intake"
CASE_FIELDS = (
    "display_label",
    "patient_name",
    "age",
    "sex",
    "referral_source",
    "body_region",
    "primary_complaint",
    "tags",
    "notes",
)
SESSION_FIELDS = (
    "session_date",
    "session_type",
    "body_region",
    "transcript",
    "red_flags",
    "soap",
    "rps",
    "reasoning",
    "differential_diagnosis",
    "metrics",
)


def _extract_json_fragment(raw_text):
    text = str(raw_text or "").strip()
    if not text:
        return ""
    if text[:1] in {"{", "["}:
        return text
    for open_char, close_char in (("{", "}"), ("[", "]")):
        start = text.find(open_char)
        end = text.rfind(close_char)
        if start >= 0 and end > start:
            return text[start : end + 1]
    return text


def _merge_shape(shape, payload):
    if isinstance(shape, dict):
        source = payload if isinstance(payload, dict) else {}
        merged = {}
        for key, default_value in shape.items():
            merged[key] = _merge_shape(default_value, source.get(key))
        for key, value in source.items():
            if key not in merged:
                merged[str(key)] = value
        return merged
    if isinstance(shape, list):
        if not isinstance(payload, list):
            return list(shape)
        if not shape:
            return payload
        item_shape = shape[0]
        return [_merge_shape(item_shape, item) for item in payload]
    if payload is None:
        return shape
    return payload


def _generate_json_payload(prompt_text, default_shape, *, operation_name, runtime):
    types_module = getattr(runtime, "types", None)
    config = None
    if types_module is not None and hasattr(types_module, "GenerateContentConfig"):
        try:
            config = types_module.GenerateContentConfig(
                max_output_tokens=65536,
                response_mime_type="application/json",
            )
        except Exception:
            config = types_module.GenerateContentConfig(max_output_tokens=65536)
    response = ai_provider.run_with_provider_retry(
        operation_name,
        lambda: runtime.client.models.generate_content(
            model=getattr(runtime, "MODEL_TOOLS", "gemini-3.1-flash-lite-preview"),
            contents=[prompt_text],
            config=config or {"max_output_tokens": 65536},
        ),
        runtime=runtime,
    )
    raw_text = str(getattr(response, "text", "") or "").strip()
    try:
        payload = json.loads(_extract_json_fragment(raw_text))
    except Exception:
        payload = default_shape
    return _merge_shape(default_shape, payload)


def _generate_array_payload(prompt_text, *, operation_name, runtime):
    types_module = getattr(runtime, "types", None)
    config = None
    if types_module is not None and hasattr(types_module, "GenerateContentConfig"):
        try:
            config = types_module.GenerateContentConfig(
                max_output_tokens=32768,
                response_mime_type="application/json",
            )
        except Exception:
            config = types_module.GenerateContentConfig(max_output_tokens=32768)
    response = ai_provider.run_with_provider_retry(
        operation_name,
        lambda: runtime.client.models.generate_content(
            model=getattr(runtime, "MODEL_TOOLS", "gemini-3.1-flash-lite-preview"),
            contents=[prompt_text],
            config=config or {"max_output_tokens": 32768},
        ),
        runtime=runtime,
    )
    raw_text = str(getattr(response, "text", "") or "").strip()
    try:
        payload = json.loads(_extract_json_fragment(raw_text))
    except Exception:
        payload = []
    return payload if isinstance(payload, list) else []


def _normalize_string(value, limit=2000):
    return str(value or "").strip()[:limit]


def _normalize_case_payload(uid, payload, *, existing=None, now_ts=0.0):
    source = payload if isinstance(payload, dict) else {}
    base = dict(existing or {})
    normalized = {
        "uid": uid,
        "display_label": _normalize_string(source.get("display_label") or base.get("display_label"), 120),
        "patient_name": _normalize_string(source.get("patient_name") or base.get("patient_name"), 120),
        "age": _normalize_string(source.get("age") or base.get("age"), 16),
        "sex": _normalize_string(source.get("sex") or base.get("sex"), 40),
        "referral_source": _normalize_string(source.get("referral_source") or base.get("referral_source"), 160),
        "body_region": _normalize_string(source.get("body_region") or base.get("body_region") or DEFAULT_BODY_REGION, 80),
        "primary_complaint": _normalize_string(source.get("primary_complaint") or base.get("primary_complaint"), 300),
        "notes": _normalize_string(source.get("notes") or base.get("notes"), 2000),
        "updated_at": float(now_ts or 0),
    }
    raw_tags = source.get("tags", base.get("tags", []))
    if isinstance(raw_tags, str):
        tags = [item.strip() for item in raw_tags.split(",") if item.strip()]
    elif isinstance(raw_tags, list):
        tags = [str(item or "").strip() for item in raw_tags if str(item or "").strip()]
    else:
        tags = []
    normalized["tags"] = tags[:20]
    normalized["created_at"] = float(base.get("created_at", now_ts or 0) or now_ts or 0)
    return normalized


def _normalize_session_date(value):
    text = _normalize_string(value, 32)
    if not text:
        return ""
    for fmt in ("%Y-%m-%d", "%d-%m-%Y", "%Y/%m/%d"):
        try:
            return datetime.strptime(text, fmt).strftime("%Y-%m-%d")
        except ValueError:
            continue
    return text


def _session_date_ts(value, *, fallback_ts=0.0):
    try:
        return datetime.strptime(_normalize_session_date(value), "%Y-%m-%d").timestamp()
    except Exception:
        try:
            return float(fallback_ts or 0.0)
        except Exception:
            return float(time.time())


def _normalize_metrics(raw_metrics):
    source = raw_metrics if isinstance(raw_metrics, dict) else {}
    normalized = {}
    for key in ("nprs_before", "nprs_after", "psk", "notes"):
        value = source.get(key)
        if value in (None, ""):
            continue
        normalized[str(key)] = _normalize_string(value, 120)
    return normalized


def _normalize_session_payload(uid, case_id, payload, *, existing=None, now_ts=0.0):
    source = payload if isinstance(payload, dict) else {}
    base = dict(existing or {})
    normalized = {
        "uid": uid,
        "case_id": case_id,
        "session_date": _normalize_session_date(source.get("session_date") or base.get("session_date")),
        "session_type": _normalize_string(source.get("session_type") or base.get("session_type") or DEFAULT_SESSION_TYPE, 80),
        "body_region": _normalize_string(source.get("body_region") or base.get("body_region") or DEFAULT_BODY_REGION, 80),
        "transcript": _normalize_string(source.get("transcript") or base.get("transcript"), 180000),
        "red_flags": source.get("red_flags") if isinstance(source.get("red_flags"), list) else base.get("red_flags", []),
        "soap": source.get("soap") if isinstance(source.get("soap"), dict) else base.get("soap", {}),
        "rps": source.get("rps") if isinstance(source.get("rps"), dict) else base.get("rps", {}),
        "reasoning": source.get("reasoning") if isinstance(source.get("reasoning"), dict) else base.get("reasoning", {}),
        "differential_diagnosis": source.get("differential_diagnosis") if isinstance(source.get("differential_diagnosis"), dict) else base.get("differential_diagnosis", {}),
        "metrics": _normalize_metrics(source.get("metrics", base.get("metrics", {}))),
        "updated_at": float(now_ts or 0),
    }
    normalized["session_date_ts"] = _session_date_ts(
        normalized.get("session_date"),
        fallback_ts=now_ts,
    )
    normalized["created_at"] = float(base.get("created_at", now_ts or 0) or now_ts or 0)
    return normalized


def _require_ready_runtime(app_ctx):
    if getattr(app_ctx, "client", None) is None:
        return app_ctx.jsonify({"error": "AI processing is tijdelijk niet beschikbaar."}), 503
    return None


def _parse_payload(request):
    return request.get_json(silent=True) or {}


def _case_context_for_uid(app_ctx, uid, case_id):
    if not case_id:
        return {}
    doc = physio_repo.get_physio_case_doc(app_ctx.db, case_id)
    if not getattr(doc, "exists", False):
        return {}
    payload = doc.to_dict() or {}
    if str(payload.get("uid", "") or "").strip() != str(uid or "").strip():
        return {}
    payload.setdefault("case_id", case_id)
    return payload


def create_transcription_job(app_ctx, request):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    write_guard = account_lifecycle.ensure_account_allows_writes(decoded_token["uid"], runtime=app_ctx)
    if not write_guard[0]:
        return app_ctx.jsonify({"error": write_guard[1], "status": "account_deletion_in_progress"}), 409
    unavailable = _require_ready_runtime(app_ctx)
    if unavailable is not None:
        return unavailable

    uploaded_audio = request.files.get("audio") or request.files.get("file")
    if not uploaded_audio or not str(uploaded_audio.filename or "").strip():
        return app_ctx.jsonify({"error": "Audio file is required."}), 400
    if not app_ctx.allowed_file(uploaded_audio.filename, app_ctx.ALLOWED_AUDIO_EXTENSIONS):
        return app_ctx.jsonify({"error": "Invalid audio file."}), 400
    mime_type = str(uploaded_audio.mimetype or "").strip().lower()
    if mime_type not in app_ctx.ALLOWED_AUDIO_MIME_TYPES:
        return app_ctx.jsonify({"error": "Invalid audio content type."}), 400

    job_id = str(app_ctx.uuid.uuid4())
    safe_name = app_ctx.secure_filename(uploaded_audio.filename)
    audio_path = app_ctx.os.path.join(app_ctx.UPLOAD_FOLDER, f"{job_id}_{safe_name}")
    uploaded_audio.save(audio_path)
    audio_size = app_ctx.get_saved_file_size(audio_path)
    if audio_size <= 0 or audio_size > app_ctx.MAX_AUDIO_UPLOAD_BYTES:
        app_ctx.cleanup_files([audio_path], [])
        return app_ctx.jsonify({"error": "Audio exceeds server limit (max 500MB) or is empty."}), 400
    if not app_ctx.file_looks_like_audio(audio_path):
        app_ctx.cleanup_files([audio_path], [])
        return app_ctx.jsonify({"error": "Uploaded audio file is invalid or unsupported."}), 400

    now_ts = app_ctx.time.time()
    runtime_jobs_store.set_job(
        job_id,
        {
            "status": "starting",
            "step": 0,
            "step_description": "Starten...",
            "total_steps": 2,
            "mode": "physio-transcription",
            "user_id": decoded_token["uid"],
            "user_email": decoded_token.get("email", ""),
            "started_at": now_ts,
            "result": None,
            "transcript": None,
            "error": None,
            "failed_stage": "",
            "provider_error_code": "",
            "retry_attempts": 0,
            "study_pack_title": "Physio transcript",
            "file_size_mb": round(audio_size / (1024 * 1024), 2),
            "study_features": "none",
            "billing_mode": "internal",
        },
        runtime=app_ctx,
    )
    try:
        app_ctx.submit_background_job(
            physio_transcription.process_physio_transcription,
            job_id,
            audio_path,
            runtime=app_ctx,
        )
    except JobQueueFullError:
        app_ctx.cleanup_files([audio_path], [])
        runtime_jobs_store.delete_job(job_id, runtime=app_ctx)
        return app_ctx.jsonify({"error": "The server is busy. Please retry in a moment."}), 503
    return app_ctx.jsonify({"ok": True, "job_id": job_id})


def generate_soap(app_ctx, request):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    unavailable = _require_ready_runtime(app_ctx)
    if unavailable is not None:
        return unavailable
    payload = _parse_payload(request)
    transcript = _normalize_string(payload.get("transcript"), 180000)
    if not transcript:
        return app_ctx.jsonify({"error": "Transcript is required."}), 400
    case_context = payload.get("case_context")
    if not isinstance(case_context, dict):
        case_context = _case_context_for_uid(app_ctx, decoded_token["uid"], payload.get("case_id"))
    soap = _generate_json_payload(
        physio_prompts.soap_prompt(
            transcript,
            body_region=_normalize_string(payload.get("body_region"), 80),
            session_type=_normalize_string(payload.get("session_type"), 80),
            case_context=case_context,
        ),
        physio_prompts.SOAP_RESPONSE_SHAPE,
        operation_name="physio_generate_soap",
        runtime=app_ctx,
    )
    return app_ctx.jsonify({"soap": soap, "warnings": []})


def generate_rps(app_ctx, request):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    unavailable = _require_ready_runtime(app_ctx)
    if unavailable is not None:
        return unavailable
    payload = _parse_payload(request)
    transcript = _normalize_string(payload.get("transcript"), 180000)
    if not transcript:
        return app_ctx.jsonify({"error": "Transcript is required."}), 400
    case_context = payload.get("case_context")
    if not isinstance(case_context, dict):
        case_context = _case_context_for_uid(app_ctx, decoded_token["uid"], payload.get("case_id"))
    rps = _generate_json_payload(
        physio_prompts.rps_prompt(
            transcript,
            body_region=_normalize_string(payload.get("body_region"), 80),
            session_type=_normalize_string(payload.get("session_type"), 80),
            case_context=case_context,
        ),
        physio_prompts.RPS_RESPONSE_SHAPE,
        operation_name="physio_generate_rps",
        runtime=app_ctx,
    )
    return app_ctx.jsonify({"rps": rps})


def generate_reasoning(app_ctx, request):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    unavailable = _require_ready_runtime(app_ctx)
    if unavailable is not None:
        return unavailable
    payload = _parse_payload(request)
    transcript = _normalize_string(payload.get("transcript"), 180000)
    if not transcript:
        return app_ctx.jsonify({"error": "Transcript is required."}), 400
    body_region = _normalize_string(payload.get("body_region"), 80)
    session_type = _normalize_string(payload.get("session_type"), 80)
    case_context = payload.get("case_context")
    if not isinstance(case_context, dict):
        case_context = _case_context_for_uid(app_ctx, decoded_token["uid"], payload.get("case_id"))
    reasoning = _generate_json_payload(
        physio_prompts.reasoning_prompt(
            transcript,
            body_region=body_region,
            session_type=session_type,
            case_context=case_context,
        ),
        physio_prompts.REASONING_RESPONSE_SHAPE,
        operation_name="physio_generate_reasoning",
        runtime=app_ctx,
    )
    differential = _generate_json_payload(
        physio_prompts.differential_prompt(
            transcript,
            body_region=body_region,
            session_type=session_type,
            case_context=case_context,
        ),
        physio_prompts.DIFFERENTIAL_RESPONSE_SHAPE,
        operation_name="physio_generate_differential",
        runtime=app_ctx,
    )
    red_flags = _generate_array_payload(
        physio_prompts.red_flags_prompt(
            transcript,
            body_region=body_region,
            session_type=session_type,
            case_context=case_context,
        ),
        operation_name="physio_generate_red_flags",
        runtime=app_ctx,
    )
    return app_ctx.jsonify(
        {
            "seven_step": reasoning,
            "differential_diagnosis": differential,
            "red_flags": red_flags,
        }
    )


def knowledge_query(app_ctx, request):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    unavailable = _require_ready_runtime(app_ctx)
    if unavailable is not None:
        return unavailable
    payload = _parse_payload(request)
    question = _normalize_string(payload.get("question"), 5000)
    if not question:
        return app_ctx.jsonify({"error": "Vraag is verplicht."}), 400
    case_context = _case_context_for_uid(app_ctx, decoded_token["uid"], payload.get("case_id"))
    context_text = _normalize_string(payload.get("context_text"), 8000)
    if case_context:
        case_lines = []
        for key in ("display_label", "patient_name", "primary_complaint", "notes"):
            value = _normalize_string(case_context.get(key), 600)
            if value:
                case_lines.append(f"{key}: {value}")
        if case_lines:
            context_text = (context_text + "\n" + "\n".join(case_lines)).strip()
    response_payload = physio_knowledge.query_knowledge_index(
        question,
        body_region=_normalize_string(payload.get("body_region"), 80),
        context_text=context_text,
        case_context=case_context,
        runtime=app_ctx,
    )
    return app_ctx.jsonify(response_payload)


def list_cases(app_ctx, request):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    cases = physio_repo.list_physio_cases_by_uid(app_ctx.db, decoded_token["uid"], limit=250)
    return app_ctx.jsonify({"cases": cases})


def create_case(app_ctx, request):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    allowed, message = account_lifecycle.ensure_account_allows_writes(decoded_token["uid"], runtime=app_ctx)
    if not allowed:
        return app_ctx.jsonify({"error": message, "status": "account_deletion_in_progress"}), 409
    payload = _parse_payload(request)
    now_ts = app_ctx.time.time()
    doc_ref = physio_repo.create_physio_case_doc_ref(app_ctx.db)
    case_payload = _normalize_case_payload(decoded_token["uid"], payload, now_ts=now_ts)
    case_payload["case_id"] = doc_ref.id
    physio_repo.set_physio_case(app_ctx.db, doc_ref.id, case_payload, merge=False)
    return app_ctx.jsonify({"ok": True, "case": case_payload})


def update_case(app_ctx, request, case_id):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    allowed, message = account_lifecycle.ensure_account_allows_writes(decoded_token["uid"], runtime=app_ctx)
    if not allowed:
        return app_ctx.jsonify({"error": message, "status": "account_deletion_in_progress"}), 409
    doc = physio_repo.get_physio_case_doc(app_ctx.db, case_id)
    if not getattr(doc, "exists", False):
        return app_ctx.jsonify({"error": "Case not found."}), 404
    existing = doc.to_dict() or {}
    if str(existing.get("uid", "") or "").strip() != decoded_token["uid"]:
        return app_ctx.jsonify({"error": "Forbidden"}), 403
    now_ts = app_ctx.time.time()
    case_payload = _normalize_case_payload(decoded_token["uid"], _parse_payload(request), existing=existing, now_ts=now_ts)
    case_payload["case_id"] = case_id
    physio_repo.set_physio_case(app_ctx.db, case_id, case_payload, merge=False)
    return app_ctx.jsonify({"ok": True, "case": case_payload})


def list_case_sessions(app_ctx, request, case_id):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    case_doc = physio_repo.get_physio_case_doc(app_ctx.db, case_id)
    if not getattr(case_doc, "exists", False):
        return app_ctx.jsonify({"error": "Case not found."}), 404
    case_payload = case_doc.to_dict() or {}
    if str(case_payload.get("uid", "") or "").strip() != decoded_token["uid"]:
        return app_ctx.jsonify({"error": "Forbidden"}), 403
    sessions = physio_repo.list_physio_sessions_by_case(app_ctx.db, decoded_token["uid"], case_id, limit=300)
    return app_ctx.jsonify({"sessions": sessions})


def create_case_session(app_ctx, request, case_id):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    allowed, message = account_lifecycle.ensure_account_allows_writes(decoded_token["uid"], runtime=app_ctx)
    if not allowed:
        return app_ctx.jsonify({"error": message, "status": "account_deletion_in_progress"}), 409
    case_doc = physio_repo.get_physio_case_doc(app_ctx.db, case_id)
    if not getattr(case_doc, "exists", False):
        return app_ctx.jsonify({"error": "Case not found."}), 404
    case_payload = case_doc.to_dict() or {}
    if str(case_payload.get("uid", "") or "").strip() != decoded_token["uid"]:
        return app_ctx.jsonify({"error": "Forbidden"}), 403
    now_ts = app_ctx.time.time()
    doc_ref = physio_repo.create_physio_session_doc_ref(app_ctx.db)
    session_payload = _normalize_session_payload(
        decoded_token["uid"],
        case_id,
        _parse_payload(request),
        now_ts=now_ts,
    )
    session_payload["session_id"] = doc_ref.id
    physio_repo.set_physio_session(app_ctx.db, doc_ref.id, session_payload, merge=False)
    return app_ctx.jsonify({"ok": True, "session": session_payload})


def update_case_session(app_ctx, request, case_id):
    decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    allowed, message = account_lifecycle.ensure_account_allows_writes(decoded_token["uid"], runtime=app_ctx)
    if not allowed:
        return app_ctx.jsonify({"error": message, "status": "account_deletion_in_progress"}), 409
    payload = _parse_payload(request)
    session_id = _normalize_string(payload.get("session_id"), 120)
    if not session_id:
        return app_ctx.jsonify({"error": "session_id is required."}), 400
    session_doc = physio_repo.get_physio_session_doc(app_ctx.db, session_id)
    if not getattr(session_doc, "exists", False):
        return app_ctx.jsonify({"error": "Session not found."}), 404
    existing = session_doc.to_dict() or {}
    if str(existing.get("uid", "") or "").strip() != decoded_token["uid"]:
        return app_ctx.jsonify({"error": "Forbidden"}), 403
    if str(existing.get("case_id", "") or "").strip() != str(case_id or "").strip():
        return app_ctx.jsonify({"error": "Case mismatch."}), 400
    now_ts = app_ctx.time.time()
    session_payload = _normalize_session_payload(
        decoded_token["uid"],
        case_id,
        payload,
        existing=existing,
        now_ts=now_ts,
    )
    session_payload["session_id"] = session_id
    physio_repo.set_physio_session(app_ctx.db, session_id, session_payload, merge=False)
    return app_ctx.jsonify({"ok": True, "session": session_payload})


def export_payload(app_ctx, request):
    _decoded_token, error_response, status_code = physio_access.ensure_physio_access(request, runtime=app_ctx)
    if error_response is not None:
        return error_response, status_code
    payload = _parse_payload(request)
    export_kind = _normalize_string(payload.get("kind"), 80) or "Physio Export"
    export_format = _normalize_string(payload.get("format"), 20).lower() or "docx"
    title = _normalize_string(payload.get("title"), 180) or export_kind
    data = payload.get("data")
    if not isinstance(data, (dict, list)):
        return app_ctx.jsonify({"error": "Structured export data is required."}), 400
    safe_base = re.sub(r"[^a-zA-Z0-9_-]+", "-", title).strip("-").lower() or "physio-export"
    if export_format == "docx":
        file_bytes = physio_export.build_physio_docx_bytes(export_kind, data, title=title, runtime=app_ctx)
        return app_ctx.send_file(
            io.BytesIO(file_bytes),
            as_attachment=True,
            download_name=f"{safe_base}.docx",
            mimetype="application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        )
    if export_format == "pdf":
        file_bytes = physio_export.build_physio_pdf_bytes(export_kind, data, title=title, runtime=app_ctx)
        return app_ctx.send_file(
            io.BytesIO(file_bytes),
            as_attachment=True,
            download_name=f"{safe_base}.pdf",
            mimetype="application/pdf",
        )
    return app_ctx.jsonify({"error": "Unsupported export format."}), 400
