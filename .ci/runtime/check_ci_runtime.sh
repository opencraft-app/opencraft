#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_ROOT"
source .ci/init.sh
ci_init_repo_root
ci_require_commands bash git python3

echo "============================================================"
echo "CI runtime 约束：开始静态 shell 语法检查"
echo "检查对象：init/runtime shell + 已注册 guard shell"
echo "============================================================"
bash -n \
  .ci/init.sh \
  .ci/runtime/build_and_promote_to_gitops.sh \
  .ci/runtime/check_ci_runtime.sh \
  .ci/runtime/gitops_promotion_bootstrap.sh \
  .ci/runtime/pin_image_to_gitops.sh \
  .ci/runtime/promote_bundle_image_to_gitops.sh \
  .ci/runtime/smoke_materialized_runtime.sh \
  .ci/checks/guard.sh \
  service-gateway/checks/guard.sh \
  admin-gateway/checks/guard.sh \
  frontend/checks/guard.sh

echo "============================================================"
echo "CI runtime 约束：开始 Python 编译检查"
echo "检查对象：contracts / gitops / gates / guards / commands"
echo "============================================================"
python3 -m py_compile $(find \
  .ci/runtime/contracts \
  .ci/runtime/gitops \
  .ci/runtime/gates \
  .ci/runtime/guards \
  .ci/runtime/commands \
  -name '*.py' | sort)

echo "============================================================"
echo "CI runtime 约束：校验生产 Argo sync 必须保持人工"
echo "============================================================"
python3 .ci/runtime/commands/validate_prod_manual_sync.py --repo-root "$REPO_ROOT"

echo "============================================================"
echo "CI runtime 约束：运行 runtime 单测"
echo "============================================================"
python3 -m unittest discover -s .ci/runtime/tests

echo "============================================================"
echo "CI runtime 约束：运行 materialized runtime smoke"
echo "============================================================"
bash .ci/runtime/smoke_materialized_runtime.sh

echo "============================================================"
echo "CI runtime 约束：解析 Stream YAML 与 guards.yaml"
echo "============================================================"
python3 -c 'from pathlib import Path; import yaml; [yaml.safe_load(path.open()) for path in sorted(Path(".ci").glob("**/*.yml"))]; yaml.safe_load(Path(".ci/guards.yaml").read_text()); print("parsed .ci yaml files, including templates")'

echo "============================================================"
echo "CI runtime 约束：检查 diff 空白与冲突标记"
echo "============================================================"
git diff --check

echo "CI runtime 约束：全部通过"
