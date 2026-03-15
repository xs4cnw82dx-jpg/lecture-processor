"""Access control helpers for Physio Assistant."""

from __future__ import annotations

import json
import os

from lecture_processor.runtime.container import get_runtime


PHYSIO_ALLOWLIST_CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))),
    "config",
    "physio_allowed_emails.json",
)


def _resolve_runtime(runtime=None):
    if runtime is not None:
        return runtime
    return get_runtime()


def _load_allowed_emails(path):
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except Exception:
        return {"emails": [], "allow_local_dev": True}
    if not isinstance(data, dict):
        return {"emails": [], "allow_local_dev": True}
    raw_emails = data.get("emails", [])
    emails = sorted({str(item or "").strip().lower() for item in raw_emails if str(item or "").strip()})
    return {
        "emails": emails,
        "allow_local_dev": bool(data.get("allow_local_dev", True)),
    }


def build_physio_access_payload(decoded_token, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    token = decoded_token if isinstance(decoded_token, dict) else {}
    email = str(token.get("email", "") or "").strip().lower()
    uid = str(token.get("uid", "") or "").strip()
    if not email and not uid:
        return {"allowed": False, "reason": "auth_required"}
    if resolved_runtime.is_admin_user(token):
        return {"allowed": True, "reason": "admin"}

    env_emails = {
        item.strip().lower()
        for item in str(getattr(resolved_runtime, "os", os).getenv("PHYSIO_ALLOWED_EMAILS", "") or "").split(",")
        if item.strip()
    }
    file_config = _load_allowed_emails(PHYSIO_ALLOWLIST_CONFIG_PATH)
    allowed_emails = set(file_config.get("emails", [])) | env_emails
    if email and email in allowed_emails:
        return {"allowed": True, "reason": "allowlist"}

    environment = str(getattr(resolved_runtime.settings, "environment", "") or "").strip().lower()
    if environment in {"development", "dev", "local", "test"} and file_config.get("allow_local_dev", True):
        return {"allowed": True, "reason": "local_dev"}

    return {"allowed": False, "reason": "owner_only"}


def ensure_physio_access(request, runtime=None):
    resolved_runtime = _resolve_runtime(runtime)
    decoded_token = resolved_runtime.verify_firebase_token(request)
    if not decoded_token:
        return None, resolved_runtime.jsonify({"error": "Please sign in to continue."}), 401
    payload = build_physio_access_payload(decoded_token, runtime=resolved_runtime)
    if not payload.get("allowed"):
        return decoded_token, resolved_runtime.jsonify({
            "error": "Physio Assistant is private and only available to the configured owner account.",
            "reason": payload.get("reason", "owner_only"),
        }), 403
    return decoded_token, None, None
