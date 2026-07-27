#!/usr/bin/env python3
"""Fail CI when generated/private Physio data or oversized files enter Git."""

from __future__ import annotations

import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MAX_TRACKED_BYTES = 10 * 1024 * 1024
PRIVATE_PHYSIO_PREFIXES = ("physio_library/index/", "physio_library/sources/")
ALLOWED_PLACEHOLDERS = {
    "physio_library/index/.gitkeep",
    "physio_library/sources/.gitkeep",
}


def tracked_paths() -> list[str]:
    result = subprocess.run(
        ["git", "ls-files", "-z"],
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return [item.decode("utf-8") for item in result.stdout.split(b"\0") if item]


def find_violations(paths: list[str]) -> list[str]:
    violations: list[str] = []
    for relative in paths:
        if relative.startswith(PRIVATE_PHYSIO_PREFIXES) and relative not in ALLOWED_PLACEHOLDERS:
            violations.append(f"private/generated Physio data is tracked: {relative}")
        path = ROOT / relative
        try:
            size = path.stat().st_size
        except OSError:
            continue
        if size > MAX_TRACKED_BYTES:
            violations.append(f"tracked file exceeds 10 MiB ({size} bytes): {relative}")
    return violations


def main() -> int:
    violations = find_violations(tracked_paths())
    if violations:
        print("Repository hygiene check failed:")
        for violation in violations:
            print(f"- {violation}")
        return 1
    print("Repository hygiene check passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
