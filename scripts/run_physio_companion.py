#!/usr/bin/env python3
"""Run the private Physio companion on the IPv4 loopback interface."""

from __future__ import annotations

import argparse
import os
import secrets
import shutil
import sys
import webbrowser
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from lecture_processor.physio_companion import CompanionConfig, create_companion_app


APP_SUPPORT = Path.home() / "Library/Application Support/Lecture Processor/Physio"
CODEX_APP_BINARY = Path("/Applications/ChatGPT.app/Contents/Resources/codex")


def _stable_secret(app_support: Path, filename: str = "companion-secret") -> str:
    path = app_support / filename
    app_support.mkdir(parents=True, exist_ok=True)
    if path.is_file():
        return path.read_text(encoding="utf-8").strip()
    secret = secrets.token_urlsafe(48)
    path.write_text(secret, encoding="utf-8")
    try:
        path.chmod(0o600)
    except OSError:
        pass
    return secret


def _binary(env_name: str, fallback_name: str, app_path: Path | None = None) -> str | None:
    configured = (os.getenv(env_name, "") or "").strip()
    if configured:
        return configured
    discovered = shutil.which(fallback_name)
    if discovered:
        return discovered
    virtualenv_sibling = Path(sys.executable).absolute().parent / fallback_name
    if virtualenv_sibling.is_file():
        return str(virtualenv_sibling)
    if app_path and app_path.is_file():
        return str(app_path)
    return None


def build_config(vault: Path, app_support: Path) -> CompanionConfig:
    codex = _binary("PHYSIO_CODEX_BINARY", "codex", CODEX_APP_BINARY)
    if not codex:
        codex = "codex"
    return CompanionConfig(
        vault_path=vault,
        app_support_path=app_support,
        secret_key=_stable_secret(app_support),
        owner_token=_stable_secret(app_support, "owner-token"),
        codex_binary=codex,
        codex_extra_args=("--ignore-user-config",),
    )


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1", choices=("127.0.0.1", "localhost"))
    parser.add_argument("--port", type=int, default=8765)
    parser.add_argument("--vault", type=Path, default=Path.home() / "Documents/Physio Knowledge Vault")
    parser.add_argument("--app-support", type=Path, default=APP_SUPPORT)
    parser.add_argument("--no-browser", action="store_true", help="Do not open the authorized workspace URL")
    args = parser.parse_args()
    if not 1024 <= args.port <= 65535:
        parser.error("port must be between 1024 and 65535")
    config = build_config(args.vault, args.app_support)
    app = create_companion_app(config)
    if not args.no_browser:
        webbrowser.open(f"http://{args.host}:{args.port}/physio#owner_token={config.owner_token}")
    app.run(host=args.host, port=args.port, debug=False, use_reloader=False, threaded=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
