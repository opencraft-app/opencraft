#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"
source .ci/init.sh
ci_init_repo_root

echo "ci-runtime guard: changed files"
cat "${GUARD_CHANGED_FILES_FILE:?}"

bash .ci/runtime/check_ci_runtime.sh
