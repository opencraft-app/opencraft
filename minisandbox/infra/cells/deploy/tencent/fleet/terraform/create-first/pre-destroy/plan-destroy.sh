#!/usr/bin/env bash
set -euo pipefail

usage() {
	cat >&2 <<'EOF'
usage: plan-destroy.sh AUDIT IMAGE_INVENTORY SCOPE TFVARS OUTPUT_DIRECTORY

SCOPE is management, actor-bj-a01, or actor-bj-b01. The regional foundation
and protected state/recovery bucket are intentionally outside this workflow.

The caller must first close placement, retire Kubernetes-owned Machines, empty
only the exact Terraform-owned data buckets, and apply a separately reviewed
deletion-protection unlock. This command is read-only against managed cloud
resources and emits a sensitive binary plan plus a non-secret plan receipt.
EOF
	exit 2
}

[[ $# -eq 5 ]] || usage
audit=$(readlink -e "$1")
inventory=$(readlink -e "$2")
scope=$3
tfvars=$(readlink -e "$4")
output=$5
[[ $output == /* && -d $output && ! -L $output ]] || {
	echo "output directory must be an existing absolute non-symlink directory" >&2
	exit 2
}
[[ $(stat -c %a "$output") == 700 ]] || {
	echo "output directory must have mode 0700 because plans contain sensitive state" >&2
	exit 2
}
[[ -f $audit && -f $inventory && -f $tfvars ]] || usage
case "$scope" in
	management | actor-bj-a01 | actor-bj-b01) ;;
	*) usage ;;
esac
for name in destroy.tfvars.json current-state.json destroy.tfplan destroy.tfplan.json destroy-plan.receipt.json; do
	[[ ! -e $output/$name ]] || { echo "refusing to overwrite $output/$name" >&2; exit 2; }
done

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
create_first=$(dirname -- "$script_dir")
fleet_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
project_root=$(CDPATH= cd -- "$fleet_dir/../../../../.." && pwd)
terraform=$($create_first/tools/resolve-terraform.sh)
python=${PYTHON:-python3}
for command in "$terraform" "$python" git jq sha256sum; do
	command -v "$command" >/dev/null || { echo "required tool is missing: $command" >&2; exit 2; }
done

# The source tfvars remains immutable evidence. Only the teardown copy may
# disable deletion protection, and its mode stays private with the plan.
"$python" - "$tfvars" "$output/destroy.tfvars.json" "$scope" <<'PY'
import json,pathlib,sys
source=pathlib.Path(sys.argv[1]); target=pathlib.Path(sys.argv[2]); scope=sys.argv[3]
value=json.loads(source.read_text())
if not isinstance(value,dict): raise SystemExit("tfvars must be an object")
if value.get("deletion_protection") is not True:
    raise SystemExit("source tfvars must retain deletion_protection=true")
if scope == "management":
    if value.get("management_id") != "actor-bj-c01": raise SystemExit("management tfvars identity mismatch")
elif value.get("cell_id") != scope:
    raise SystemExit("Cell tfvars identity mismatch")
value["deletion_protection"]=False
target.write_text(json.dumps(value,indent=2,sort_keys=True)+"\n")
target.chmod(0o600)
PY

export TF_DATA_DIR=$output/terraform-data
export TF_IN_AUTOMATION=1
case "$scope" in
	management) "$create_first/init-backend.sh" management "$(jq -er '.recoveryBucket.name' "$audit")" >/dev/null ;;
	*) "$create_first/init-backend.sh" cell "$(jq -er '.recoveryBucket.name' "$audit")" "$scope" >/dev/null ;;
esac
root=$create_first/$([[ $scope == management ]] && echo management || echo cell)
"$terraform" -chdir="$root" state pull >"$output/current-state.json"
chmod 0600 "$output/current-state.json"
"$terraform" -chdir="$root" plan -destroy -input=false -lock-timeout=5m \
	-var-file="$output/destroy.tfvars.json" -out="$output/destroy.tfplan" >/dev/null
chmod 0600 "$output/destroy.tfplan"
"$terraform" -chdir="$root" show -json "$output/destroy.tfplan" >"$output/destroy.tfplan.json"
chmod 0600 "$output/destroy.tfplan.json"
"$python" "$script_dir/validate-destroy-plan.py" \
	--audit "$audit" --image-inventory "$inventory" --repo "$project_root" --scope "$scope" \
	--state "$output/current-state.json" --plan "$output/destroy.tfplan" \
	--plan-json "$output/destroy.tfplan.json" --output "$output/destroy-plan.receipt.json"
