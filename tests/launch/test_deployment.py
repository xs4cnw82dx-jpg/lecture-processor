from pathlib import Path

import pytest

from tests.runtime_test_support import get_test_core

core = get_test_core()

pytestmark = pytest.mark.usefixtures("disable_sentry")


def test_discontinued_gemini_flash_lite_preview_model_is_not_reintroduced():
    repo_root = Path(__file__).resolve().parents[2]
    blocked_model = "gemini-3.1-flash-lite-" + "preview"
    scanned_suffixes = {".py", ".js", ".html", ".json", ".md", ".yaml", ".yml"}
    ignored_dirs = {".git", ".venv", "venv", "venv_py39_backup", "node_modules", ".pytest_cache", "__pycache__"}
    offenders = []

    for path in repo_root.rglob("*"):
        if any(part in ignored_dirs for part in path.parts):
            continue
        if not path.is_file() or path.suffix not in scanned_suffixes:
            continue
        if blocked_model in path.read_text(encoding="utf-8", errors="ignore"):
            offenders.append(str(path.relative_to(repo_root)))

    assert offenders == []


def test_render_public_base_url_matches_production_host():
    render_yaml = Path("render.yaml").read_text(encoding="utf-8")

    assert 'value: "https://lectureprocessor.com"' in render_yaml
    assert 'value: "https://lecture-processor-1.onrender.com"' not in render_yaml


def test_build_admin_deployment_info_detects_render_host(monkeypatch):
    monkeypatch.setenv("RENDER", "true")
    monkeypatch.setenv("RENDER_SERVICE_NAME", "lecture-processor")
    monkeypatch.setenv("RENDER_SERVICE_ID", "srv-123")
    monkeypatch.setenv("RENDER_EXTERNAL_HOSTNAME", "lecture-processor-1.onrender.com")
    monkeypatch.setenv("RENDER_GIT_BRANCH", "main")
    monkeypatch.setenv("RENDER_GIT_COMMIT", "abcdef1234567890")
    monkeypatch.setattr(core, "PUBLIC_BASE_URL", "https://lectureprocessor.com")

    info = core.build_admin_deployment_info("lecture-processor-1.onrender.com")
    assert info["runtime"] == "render"
    assert info["service_name"] == "lecture-processor"
    assert info["git_commit_short"] == "abcdef123456"
    assert info["host_matches_render"] is True
    assert info["host_status"] == "render-default"

    custom = core.build_admin_deployment_info("lectureprocessor.com")
    assert custom["host_matches_render"] is False
    assert custom["host_status"] == "custom-domain"

    mismatch = core.build_admin_deployment_info("other-host.onrender.com")
    assert mismatch["host_matches_render"] is False
    assert mismatch["host_status"] == "mismatch"


def test_build_admin_runtime_checks_reports_tool_and_stripe_state(monkeypatch):
    monkeypatch.setattr(core.stripe, "api_key", "sk_test_123")
    monkeypatch.setattr(core, "STRIPE_PUBLISHABLE_KEY", "pk_test_123")
    monkeypatch.setattr(core, "STRIPE_WEBHOOK_SECRET", "whsec_test_123")
    monkeypatch.setattr(core, "get_soffice_binary", lambda: "/usr/bin/soffice")
    monkeypatch.setattr(core, "get_ffmpeg_binary", lambda: "/usr/bin/ffmpeg")
    monkeypatch.setattr(core.shutil, "which", lambda name: "/usr/bin/yt-dlp" if name == "yt-dlp" else "")
    monkeypatch.setattr(core, "db", object())
    monkeypatch.setattr(core, "client", object())

    checks = core.build_admin_runtime_checks()
    assert checks["stripe_secret_mode"] == "test"
    assert checks["stripe_publishable_mode"] == "test"
    assert checks["stripe_keys_match"] is True
    assert checks["stripe_webhook_configured"] is True
    assert checks["pptx_conversion_available"] is True
    assert checks["video_import_available"] is True
    assert checks["firebase_ready"] is True
    assert checks["gemini_ready"] is True


def test_admin_overview_and_export_forbid_non_admin(client, monkeypatch):
    revocation_checks = []

    def _verify_token(_request, check_revoked=False):
        revocation_checks.append(check_revoked)
        return {"uid": "u-non-admin", "email": "user@gmail.com"}

    monkeypatch.setattr(core, "verify_firebase_token", _verify_token)
    monkeypatch.setattr(core, "is_admin_user", lambda _decoded: False)
    assert client.get("/api/admin/overview", headers={"Authorization": "Bearer dev"}).status_code == 403
    assert client.get("/api/admin/export?type=jobs", headers={"Authorization": "Bearer dev"}).status_code == 403
    assert revocation_checks == [True, True]
