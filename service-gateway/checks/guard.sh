#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"

echo "service-gateway guard: changed files"
cat "${GUARD_CHANGED_FILES_FILE:?}"

echo "============================================================"
echo "service-gateway 约束：校验发布 bundle 契约"
echo "目的：提前发现 shprod 投影夹带无关服务、sandbox 发布契约缺失等问题"
echo "============================================================"
python3 -m unittest discover -s .ci/runtime/tests -p 'test_release_bundle_contracts.py'

if command -v go >/dev/null 2>&1; then
  echo "============================================================"
  echo "service-gateway 约束：运行 Go 单测"
  echo "命令：cd service-gateway && go test ./..."
  echo "============================================================"
  (cd service-gateway && go test ./...)
else
  echo "service-gateway 约束：未找到 go，跳过 Go 单测" >&2
fi

echo "service-gateway 约束：全部通过"
