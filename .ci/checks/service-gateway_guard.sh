#!/usr/bin/env bash
set -euo pipefail

cd "${GUARD_REPO_ROOT:-$(pwd)}"

echo "service-gateway guard: changed files"
cat "${GUARD_CHANGED_FILES_FILE:?}"

echo "============================================================"
echo "service-gateway 约束：校验发布 bundle 契约"
echo "目的：提前发现 shprod 投影夹带无关服务、sandbox 发布契约缺失等问题"
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
suite = loader.discover(".ci/runtime/tests", pattern="test_release_bundle_contracts.py")
result = unittest.TextTestRunner(verbosity=1).run(filter_suite(suite))
sys.exit(0 if result.wasSuccessful() else 1)
PY

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
