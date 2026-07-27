#!/usr/bin/env python3
"""Install or remove the per-user macOS LaunchAgent for Physio companion."""

from __future__ import annotations

import argparse
import plistlib
import secrets
import subprocess
import sys
import time
import urllib.request
import webbrowser
from pathlib import Path


LABEL = "com.lectureprocessor.physio"


def ensure_owner_token(app_support: Path) -> str:
    token_path = app_support / "owner-token"
    app_support.mkdir(parents=True, exist_ok=True)
    if token_path.is_file():
        token = token_path.read_text(encoding="utf-8").strip()
        if len(token) >= 32:
            return token
    token = secrets.token_urlsafe(48)
    token_path.write_text(token, encoding="utf-8")
    try:
        token_path.chmod(0o600)
    except OSError:
        pass
    return token


def open_authorized_workspace(owner_token: str, *, timeout_seconds: float = 10.0) -> bool:
    health_url = "http://127.0.0.1:8765/healthz"
    deadline = time.monotonic() + max(0.0, timeout_seconds)
    while time.monotonic() < deadline:
        try:
            with urllib.request.urlopen(health_url, timeout=0.5) as response:
                if response.status == 200:
                    webbrowser.open(f"http://127.0.0.1:8765/physio#owner_token={owner_token}")
                    return True
        except OSError:
            time.sleep(0.2)
    return False


def launch_agent_payload(repo: Path, python: Path, app_support: Path) -> dict:
    return {
        "Label": LABEL,
        "ProgramArguments": [str(python), str(repo / "scripts/run_physio_companion.py"), "--no-browser"],
        "WorkingDirectory": str(repo),
        "RunAtLoad": True,
        "KeepAlive": {"SuccessfulExit": False},
        "ThrottleInterval": 10,
        "ProcessType": "Interactive",
        "EnvironmentVariables": {
            "PATH": f"{python.parent}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        },
        "StandardOutPath": str(app_support / "companion.log"),
        "StandardErrorPath": str(app_support / "companion-error.log"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--uninstall", action="store_true")
    parser.add_argument("--start", action="store_true", help="Bootstrap the LaunchAgent immediately")
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[1]
    # Preserve a virtualenv executable instead of resolving its symlink to a
    # dependency-free system/Homebrew interpreter.
    python = Path(sys.executable).absolute()
    app_support = Path.home() / "Library/Application Support/Lecture Processor/Physio"
    plist_path = Path.home() / "Library/LaunchAgents" / f"{LABEL}.plist"
    domain = f"gui/{Path.home().stat().st_uid}"

    if args.uninstall:
        if args.start:
            subprocess.run(["launchctl", "bootout", domain, str(plist_path)], check=False)
        if plist_path.exists():
            plist_path.unlink()
        print(f"Removed {plist_path}")
        return 0

    app_support.mkdir(parents=True, exist_ok=True)
    owner_token = ensure_owner_token(app_support)
    plist_path.parent.mkdir(parents=True, exist_ok=True)
    with plist_path.open("wb") as handle:
        plistlib.dump(launch_agent_payload(repo, python, app_support), handle, sort_keys=True)
    if args.start:
        subprocess.run(["launchctl", "bootout", domain, str(plist_path)], check=False, capture_output=True)
        subprocess.run(["launchctl", "bootstrap", domain, str(plist_path)], check=True)
        if not open_authorized_workspace(owner_token):
            print("Companion started, but its browser page was not ready yet. Run the launcher again to open it.")
    print(f"Installed {plist_path}{' and started it' if args.start else ''}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
