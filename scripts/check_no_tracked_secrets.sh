#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

blocked=(
  "firebase-credentials.json"
  ".env"
  "context_dump.txt"
)

failed=0

for path in "${blocked[@]}"; do
  if git ls-files --error-unmatch "${path}" >/dev/null 2>&1; then
    if git diff --cached --name-only --diff-filter=D | grep -Fxq "${path}"; then
      continue
    fi
    if git diff --name-only --diff-filter=D | grep -Fxq "${path}"; then
      continue
    fi
    echo "Blocked tracked file detected: ${path}"
    failed=1
  fi
done

if [ "${failed}" -ne 0 ]; then
  echo "Remove blocked files from git tracking before merge."
  exit 1
fi

echo "No blocked secret/debug files are tracked."
