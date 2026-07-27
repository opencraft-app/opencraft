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
  .ci/runtime/create_playground_from_gitops.sh \
  .ci/runtime/gitops_promotion_bootstrap.sh \
  .ci/runtime/commands/publish_frontend_preview.sh \
  .ci/runtime/commands/release_frontend_edgeone_artifact.sh \
  .ci/runtime/pin_image_to_gitops.sh \
  .ci/runtime/promote_bundle_image_to_gitops.sh \
  .ci/runtime/smoke_materialized_runtime.sh \
  .ci/checks/guard.sh \
  .ci/checks/service-gateway_guard.sh \
  service-gateway/checks/guard.sh \
  admin-gateway/checks/guard.sh \
  frontend/checks/guard.sh

echo "============================================================"
echo "CI runtime 约束：开始 Python 编译检查"
echo "检查对象：contracts / gitops / gates / guards / commands / support"
echo "============================================================"
python3 -m py_compile $(find \
  .ci/runtime/contracts \
  .ci/runtime/gitops \
  .ci/runtime/gates \
  .ci/runtime/guards \
  .ci/runtime/commands \
  .ci/runtime/support \
  -name '*.py' | sort)

echo "============================================================"
echo "CI runtime 约束：校验生产 Argo sync 必须保持人工"
echo "============================================================"
python3 .ci/runtime/commands/validate_prod_manual_sync.py --repo-root "$REPO_ROOT"

echo "============================================================"
echo "CI runtime 约束：校验 release bundle manifest 由拆分源生成"
echo "============================================================"
python3 .ci/runtime/commands/generate_release_bundle_manifest.py --check

echo "============================================================"
echo "CI runtime 约束：运行 runtime 单测"
echo "============================================================"
python3 - <<'PY'
import sys
import unittest

excluded = {
    "contract_tests.test_release_bundle_contracts.ReleaseBundleContractTests.test_velagw_beijing_otel_version_matches_subtree_source",
    "contract_tests.test_release_bundle_contracts.ReleaseBundleContractTests.test_velagw_shprod_otel_version_matches_subtree_source",
}


def filter_suite(suite):
    filtered = unittest.TestSuite()
    for test in suite:
        if isinstance(test, unittest.TestSuite):
            child = filter_suite(test)
            if child.countTestCases():
                filtered.addTest(child)
            continue
        if test.id() not in excluded:
            filtered.addTest(test)
    return filtered


loader = unittest.TestLoader()
suite = loader.discover(".ci/runtime/tests")
result = unittest.TextTestRunner(verbosity=1).run(filter_suite(suite))
sys.exit(0 if result.wasSuccessful() else 1)
PY

echo "============================================================"
echo "CI runtime 约束：运行 materialized runtime smoke"
echo "============================================================"
bash .ci/runtime/smoke_materialized_runtime.sh

echo "============================================================"
echo "CI runtime 约束：解析 Stream YAML 与 guards.manifest"
echo "============================================================"
python3 - <<'PY'
from pathlib import Path
import yaml

for path in sorted(Path(".ci").glob("**/*.yml")):
    yaml.safe_load(path.read_text())
yaml.safe_load(Path(".ci/guards.manifest").read_text())

unexpected_yaml = sorted(path.as_posix() for path in Path(".ci").glob("**/*.yaml"))
if unexpected_yaml:
    raise SystemExit("non-pipeline .yaml files under .ci are forbidden: " + ", ".join(unexpected_yaml))

print("parsed .ci yml files and guards manifest")
PY

echo "============================================================"
echo "CI runtime 约束：检查 diff 空白与冲突标记"
echo "============================================================"
git diff --check

echo "CI runtime 约束：全部通过"
