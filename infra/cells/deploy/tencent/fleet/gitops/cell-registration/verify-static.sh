#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bash -n "$script_dir/install-management.sh" "$script_dir/register-cell.sh" \
	"$script_dir/publish-management-desired-state.sh" \
	"$script_dir/complete-cell-adoption.sh"
python3 "$script_dir/test_cell_registration.py"
python3 "$script_dir/test_verify_platform.py"
python3 "$script_dir/test_verify_convergence.py"
python3 "$script_dir/test_publish_cell_route.py"
python3 "$script_dir/test_publish_cell_serving_route.py"
python3 "$script_dir/test_complete_cell_adoption.py"
python3 "$script_dir/test_publish_desired_state.py"
python3 -m py_compile \
	"$script_dir/local-applicationset-e2e.py" \
	"$script_dir/local-registration-e2e.py" \
	"$script_dir/merge-resource-inclusions.py" \
	"$script_dir/render-management.py" \
	"$script_dir/publish-desired-state.py" \
	"$script_dir/verify-publication.py" \
	"$script_dir/verify-platform.py" \
	"$script_dir/verify-convergence.py" \
	"$script_dir/verify-handoff.py" \
	"$script_dir/adopt-cell.py" \
	"$script_dir/publish-cell-route.py" \
	"$script_dir/publish-cell-serving-route.py"

temporary=$(mktemp -d /data/tmp/cell-registration-static.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
python3 "$script_dir/render-management.py" \
	--repo-url ssh://git@example.invalid/fleet.git \
	--platform-receipt-digest "sha256:$(printf '1%.0s' {1..64})" \
	--management-git-receipt-digest "sha256:$(printf '2%.0s' {1..64})" \
	--cluster-uid static-cluster-uid \
	--output "$temporary/management.yaml" >/dev/null
python3 - "$temporary/management.yaml" <<'PY'
import sys,yaml
documents=list(yaml.safe_load_all(open(sys.argv[1])))
assert [item["kind"] for item in documents] == ["AppProject", "AppProject", "ApplicationSet"]
assert documents[1]["metadata"]["name"] == "actor-cell-runtime"
assert documents[1]["spec"]["clusterResourceWhitelist"] == []
PY
echo "cell_registration_static=passed"
