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
        return {"emails": [], "allow_local_dev": False}
    if not isinstance(data, dict):
        return {"emails": [], "allow_local_dev": False}
    raw_emails = data.get("emails", [])
    emails = sorted({str(item or "").strip().lower() for item in raw_emails if str(item or "").strip()})
    return {
        "emails": emails,
        "allow_local_dev": bool(data.get("allow_local_dev", False)),
    }


def _env_truthy(env, key):
    return str(getattr(env, "getenv", os.getenv)(key, "") or "").strip().lower() in {"1", "true", "yes", "on"}


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
    local_dev_enabled = bool(file_config.get("allow_local_dev", False)) or _env_truthy(getattr(resolved_runtime, "os", os), "PHYSIO_ALLOW_LOCAL_DEV")
    if environment in {"development", "dev", "local", "test"} and local_dev_enabled:
        return {"allowed": True, "reason": "local_dev"}

    return {"allowed": False, "reason": "owner_only"}


def ensure_physio_access(decoded_token, runtime=None):
    payload = build_physio_access_payload(decoded_token, runtime=runtime)
    return bool(payload.get("allowed")), payload
