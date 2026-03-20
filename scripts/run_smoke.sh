#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PYTHON_BIN="$ROOT_DIR/venv/bin/python"
DEFAULT_BASE_URL="${SMOKE_BASE_URL:-}"

if [[ ! -x "$PYTHON_BIN" ]]; then
  PYTHON_BIN="$(command -v python3 || true)"
fi

if [[ -z "$PYTHON_BIN" ]]; then
  echo "Error: no Python interpreter found."
  exit 1
fi

ARGS=("$@")
if [[ -n "$DEFAULT_BASE_URL" ]]; then
  ARGS=(--base-url "$DEFAULT_BASE_URL" "${ARGS[@]}")
fi

exec "$PYTHON_BIN" "$ROOT_DIR/scripts/smoke_test.py" "${ARGS[@]}"
