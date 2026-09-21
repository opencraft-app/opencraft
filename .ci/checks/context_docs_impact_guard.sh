#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"

python3 .agents/context/scripts/validate_change_impact.py \
  --repo . \
  --changed-files-file "${GUARD_CHANGED_FILES_FILE:?}"
