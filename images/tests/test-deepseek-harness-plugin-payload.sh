#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TMPDIR="$(mktemp -d)"
trap 'rm -rf -- "${TMPDIR}"' EXIT
export LIGHTVELA_DSH_TEST_MODE=1
export LIGHTVELA_DSH_TEST_ROOT="${TMPDIR}/root"
source "${ROOT_DIR}/images/helpers/install-deepseek-harness.sh"

# This helper runs Python only; keep its test inside the fixture directory.
run_as_runtime_user_in() { shift 2; "$@"; }
source_profile="${TMPDIR}/source"
candidate_profile="${TMPDIR}/candidate"
python3 - "${source_profile}" "${candidate_profile}" "${TMPDIR}/manifest.json" <<'PY'
import json
import pathlib
import sys

source, candidate, manifest = map(pathlib.Path, sys.argv[1:])
dependencies = {"custom-plugin": "git+fixture#1", "changed-plugin": "1.0.0", "managed-plugin": "1.0.0"}
for root in (source, candidate):
    root.mkdir()
    dep = dict(dependencies)
    if root == candidate:
        dep["changed-plugin"] = "2.0.0"
    (root / "package.json").write_text(json.dumps({"dependencies": dep, "dsh": {"profile": {"bundles": list(dep)}}}))
    for name in dependencies:
        (root / "node_modules" / name / "dist").mkdir(parents=True)
for name in dependencies:
    (source / "node_modules" / name / "dist" / "client.js").write_text("old-build")
(source / "node_modules" / "custom-plugin" / "package.json").write_text("old-metadata")
(source / "node_modules" / "custom-plugin" / "dist" / "existing.js").write_text("old-output")
(candidate / "node_modules" / "custom-plugin" / "dist" / "existing.js").write_text("new-output")
(source / "node_modules" / "custom-plugin" / "dist" / "outside.js").symlink_to(manifest)
manifest.write_text(json.dumps({"profile": {"plugins": [{"package": "managed-plugin"}]}}))
PY
restore_custom_plugin_payload "${source_profile}" "${candidate_profile}" "${TMPDIR}" "${TMPDIR}" "${TMPDIR}/manifest.json"
python3 - "${candidate_profile}" <<'PY'
import pathlib
import sys

root = pathlib.Path(sys.argv[1]) / "node_modules"
assert (root / "custom-plugin" / "dist" / "client.js").read_text() == "old-build"
assert (root / "custom-plugin" / "dist" / "existing.js").read_text() == "new-output"
assert not (root / "custom-plugin" / "package.json").exists()
assert not (root / "custom-plugin" / "dist" / "outside.js").exists()
assert not (root / "changed-plugin" / "dist" / "client.js").exists()
assert not (root / "managed-plugin" / "dist" / "client.js").exists()
PY

echo "deepseek harness plugin payload tests passed"
