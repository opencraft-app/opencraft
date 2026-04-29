#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"

echo "admin-gateway guard: changed files"
cat "${GUARD_CHANGED_FILES_FILE:?}"

echo "============================================================"
echo "admin-gateway 约束：校验独立发布 bundle 与 CI 契约"
echo "目的：确保 admin-gateway 不再通过 service-gateway 流水线夹带发布"
echo "============================================================"
python3 -m unittest discover -s .ci/runtime/tests -p 'test_release_bundle_contracts.py'

echo "admin-gateway 约束：全部通过"
