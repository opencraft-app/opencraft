#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
terraform=$($script_dir/tools/resolve-terraform.sh)

python3 "$script_dir/test-render-cell-assets.py"
python3 "$script_dir/test-terraform-network-contract.py"
python3 "$script_dir/../../network/validate-plan.py"
python3 "$script_dir/../../network/test-plan.py"
python3 "$script_dir/test-terraform-storage-contract.py"
python3 "$script_dir/tools/test_install_terraform.py"
python3 "$script_dir/pre-destroy/test_audit.py"
python3 "$script_dir/pre-destroy/test_validate_destroy_plan.py"
python3 "$script_dir/rebuild/test_render_inputs.py"
PYTHONDONTWRITEBYTECODE=1 python3 "$script_dir/rebuild/test_management_code_plane.py"
bash "$script_dir/test-preflight-cam-automation.sh"
bash "$script_dir/test-preflight-region-zones.sh"
python3 "$script_dir/bootstrap/test_validate_inputs.py"
python3 "$script_dir/bootstrap/test_install_pull_credential.py"
python3 "$script_dir/bootstrap/test_install_pull_credential_e2e.py"
python3 "$script_dir/bootstrap/test_acquire_argocd_ha.py"
python3 "$script_dir/bootstrap/test_validate_management_platform_inputs.py"
python3 "$script_dir/bootstrap/test_verify_management_platform_live.py"
python3 "$script_dir/bootstrap/test_install_management_platform.py"
python3 "$script_dir/bootstrap/test_verify_management_platform.py"
python3 "$script_dir/bootstrap/test_check_management_platform.py"
python3 "$script_dir/bootstrap/test_render_management_git.py"
python3 "$script_dir/bootstrap/test_install_management_git.py"
python3 "$script_dir/bootstrap/test_verify_management_git.py"
python3 "$script_dir/bootstrap/test_render_regional_profile.py"
python3 "$script_dir/bootstrap/test_validate_storage_inputs.py"
python3 "$script_dir/bootstrap/test_install_storage_credentials.py"
python3 "$script_dir/bootstrap/test_validate_cell_platform_inputs.py"
python3 "$script_dir/bootstrap/test_render_cell_controller.py"
python3 "$script_dir/bootstrap/test_install_cell_platform.py"
bash -n "$script_dir/bootstrap/install-pull-credential.sh"
grep -F '/usr/local/qcloud/python/bin/python3.7' "$script_dir/bootstrap/install-pull-credential.sh" >/dev/null
grep -F '/usr/local/qcloud/python/bin/python3.7' "$script_dir/bootstrap/install-storage-credentials.sh" >/dev/null
grep -F '/usr/local/qcloud/python/bin/python3.7' "$script_dir/bootstrap/install-cell-platform.sh" >/dev/null
bash -n "$script_dir/bootstrap/prepare-bootstrap-host.sh"
grep -F 'packages=(buildah git jq nodejs skopeo python3.11 python3.11-pyyaml)' "$script_dir/bootstrap/prepare-bootstrap-host.sh" >/dev/null
grep -F 'dnf -y module enable nodejs:20' "$script_dir/bootstrap/prepare-bootstrap-host.sh" >/dev/null
grep -F 'bootstrap Node.js 20 is unavailable' "$script_dir/bootstrap/prepare-bootstrap-host.sh" >/dev/null
grep -F 'assert sys.version_info[:2] == (3, 11)' "$script_dir/bootstrap/prepare-bootstrap-host.sh" >/dev/null
grep -F 'package_inventory_sha256=' "$script_dir/bootstrap/prepare-bootstrap-host.sh" >/dev/null
bash -n "$script_dir/bootstrap/prepare-tccli-tool.sh"
grep -F 'base-tencentcloud-cli@sha256:' "$script_dir/bootstrap/prepare-tccli-tool.sh" >/dev/null
grep -F 'internal.tencentcloudapi.com' "$script_dir/bootstrap/tccli-container-wrapper.sh" >/dev/null
bash -n "$script_dir/bootstrap/tccli-container-wrapper.sh"
bash -n "$script_dir/bootstrap/acquire-argocd-ha.sh"
bash -n "$script_dir/bootstrap/install-management-platform.sh"
bash -n "$script_dir/bootstrap/check-management-platform.sh"
bash -n "$script_dir/bootstrap/install-management-git.sh"
bash -n "$script_dir/bootstrap/check-management-git.sh"
bash -n "$script_dir/rebuild/run-management-code-plane.sh"
bash -n "$script_dir/bootstrap/install-storage-credentials.sh"
bash -n "$script_dir/bootstrap/install-cell-platform.sh"
bash -n "$script_dir/tools/install-terraform.sh"
bash -n "$script_dir/tools/resolve-terraform.sh"
bash -n "$script_dir/preflight-cam-automation.sh"
bash -n "$script_dir/preflight-region-zones.sh"
bash -n "$script_dir/pre-destroy/plan-destroy.sh"
"$terraform" fmt -check -recursive "$script_dir"

temporary=$(mktemp -d /data/tmp/create-first-verify.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

for root in bootstrap-state foundation management operations-network cell; do
	export TF_DATA_DIR=$temporary/$root
	"$terraform" -chdir="$script_dir/$root" init -backend=false -input=false >/dev/null
	"$terraform" -chdir="$script_dir/$root" validate
done
unset TF_DATA_DIR

if rg -n --glob '*.tf' --glob '*.tfvars.example' --glob '*.json.example' \
	'(cls|vpc|subnet|sg|skey|img|ins|tcr)-[a-z0-9]{6,}' "$script_dir"; then
	echo "create-first source contains a remembered Tencent resource ID" >&2
	exit 1
fi

python3 - "$script_dir/foundation/variables.tf" \
	"$script_dir/../../qualification/actor-bj-q01/install-private-registry.sh" <<'PY'
import re
import sys
from pathlib import Path

terraform = Path(sys.argv[1]).read_text()
installer = Path(sys.argv[2]).read_text()

block = re.search(r'default = \[(.*?)\n  \]', terraform, re.S)
if not block:
    raise SystemExit("unable to find foundation repository inventory")
declared = set(re.findall(r'"([a-z0-9][a-z0-9._-]+)"', block.group(1)))

block = re.search(r'required_repositories=\((.*?)\n\)', installer, re.S)
if not block:
    raise SystemExit("unable to find runtime repository preflight inventory")
required = {item.removeprefix("actor-fleet/") for item in re.findall(r'^\s*([^#\s]+)\s*$', block.group(1), re.M)}
missing = sorted(required - declared)
if missing:
    raise SystemExit("foundation is missing required TCR repositories: " + ", ".join(missing))
if "runtime-base" not in declared:
    raise SystemExit("foundation must retain the immutable runtime-base repository")
PY

python3 - "$script_dir/foundation/variables.tf" \
	"$script_dir/../../gitops/image-seed/image_contract.py" <<'PY'
import importlib.util,re,sys
from pathlib import Path

terraform=Path(sys.argv[1]).read_text()
block=re.search(r'variable "repositories".*?default = \[(.*?)\n  \]',terraform,re.S)
if not block:
    raise SystemExit("unable to read the Terraform TCR repository inventory")
declared=set(re.findall(r'"([a-z0-9][a-z0-9._-]+)"',block.group(1)))
spec=importlib.util.spec_from_file_location("image_contract_create_first",sys.argv[2])
module=importlib.util.module_from_spec(spec); spec.loader.exec_module(module)
if declared != module.ALL_REPOSITORIES:
    raise SystemExit(
        "Terraform and image-lock repositories differ: missing={} unknown={}".format(
            sorted(module.ALL_REPOSITORIES-declared),sorted(declared-module.ALL_REPOSITORIES)
        )
    )
PY

echo "create-first Terraform and inventory renderer verified"
