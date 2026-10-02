#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
runtime_dir=$(CDPATH= cd -- "$script_dir/../../runtime" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../../operations" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell_name=$RIVET_CELL_NAME
machine_set=${RUNTIME_MACHINE_SET:-np-runtime0}
action=${1:-}
receipt=${2:-}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")
temporary_root=${TMPDIR:-/data/tmp}
mkdir -p "$temporary_root"
temporary=$(mktemp -d "$temporary_root/runtime-machine-repair-configure.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

usage() {
	echo "usage: $0 enable /absolute/path/to/provider-receipt.json | disable" >&2
	exit 2
}

[[ $action == enable || $action == disable ]] || usage
[[ $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ && $machine_set == np-runtime0 ]] || {
	echo "automatic runtime Machine repair configuration requires a production Cell and np-runtime0" >&2
	exit 2
}
if [[ $action == enable ]]; then
	[[ $receipt == /* && -f $receipt ]] || usage
else
	[[ -z $receipt ]] || usage
fi

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="runtime.machine-repair-configure" \
	AUTONOMY_CONTROL_CELL="$cell_name" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
		"$operations_dir/assert-autonomy-control.sh"
fi

reporter_image=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment \
	"${cell_name}-runtime-capacity" -o jsonpath='{.spec.template.spec.containers[?(@.name=="controller")].image}')
runtime_image=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
	"${cell_name}-runtime-hosts" -o jsonpath='{.spec.template.spec.containers[?(@.name=="workerd-host")].image}')
for image in "$reporter_image" "$runtime_image"; do
	[[ $image =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
		echo "live runtime components are not pinned to immutable image digests" >&2
		exit 1
	}
done

enabled=false
if [[ $action == enable ]]; then
	enabled=true
fi
RIVET_CELL_NAMESPACE="$namespace" \
RIVET_CELL_NAME="$cell_name" \
RUNTIME_MACHINE_SET="$machine_set" \
RUNTIME_CAPACITY_MAX_REPAIR_SURGE=1 \
RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED="$enabled" \
RUNTIME_MACHINE_REPAIR_QUALIFICATION_RECEIPT="$receipt" \
RUNTIME_ADMISSION_FIELD_MANAGER=rivet-runtime-admission-installer \
RIVET_REPORTER_IMAGE="$reporter_image" \
RIVET_RUNTIME_IMAGE="$runtime_image" \
	"$runtime_dir/install-admission-controller.sh"

kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment \
	"${cell_name}-runtime-capacity" -o json >"$temporary/deployment.json"
kubectl "${kubeconfig_args[@]}" get clusterrole \
	"${cell_name}-runtime-capacity" -o json >"$temporary/rbac.json"
python3 - "$temporary/deployment.json" "$temporary/rbac.json" "$enabled" <<'PY'
import json
import sys

deployment, role = (json.load(open(path)) for path in sys.argv[1:3])
expected = sys.argv[3]
container = deployment["spec"]["template"]["spec"]["containers"][0]
environment = {item["name"]: item.get("value") for item in container["env"]}
if environment.get("RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED") != expected:
    raise SystemExit("runtime Machine repair switch did not converge")
machine_rule = next(rule for rule in role["rules"] if rule.get("resources") == ["machines"])
verbs = set(machine_rule.get("verbs", []))
expected_verbs = {"get", "list", "delete"} if expected == "true" else {"get", "list"}
if verbs != expected_verbs:
    raise SystemExit(f"runtime Machine repair RBAC did not converge: {verbs}")
PY

echo "runtime Machine repair configured: enabled=$enabled"
