#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

blocked=(
  "firebase-credentials.json"
  ".env"
  ".env.*"
  "context_dump.txt"
)

failed=0

for path in "${blocked[@]}"; do
  while IFS= read -r tracked_path; do
    if [ -z "${tracked_path}" ]; then
      continue
    fi
    if git diff --cached --name-only --diff-filter=D | grep -Fxq "${path}"; then
      continue
    fi
    if git diff --cached --name-only --diff-filter=D | grep -Fxq "${tracked_path}"; then
      continue
    fi
    if git diff --name-only --diff-filter=D | grep -Fxq "${path}"; then
      continue
    fi
    if git diff --name-only --diff-filter=D | grep -Fxq "${tracked_path}"; then
      continue
    fi
    echo "Blocked tracked file detected: ${tracked_path}"
    failed=1
  done < <(git ls-files -- "${path}")
done

if [ "${failed}" -ne 0 ]; then
  echo "Remove blocked files from git tracking before merge."
  exit 1
fi

echo "No blocked secret/debug files are tracked."
