#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
manifest=$script_dir/workerd-autoscaling.yaml
namespace=actor-fdb-cell-system
field_manager=actor-q01-autoscaling
admission_field_manager=rivet-runtime-admission-installer
image=${RIVET_REPORTER_IMAGE:-}
runtime_image=${RIVET_RUNTIME_IMAGE:-}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

[[ $image =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
	echo "RIVET_REPORTER_IMAGE must be an immutable image digest" >&2
	exit 2
}
[[ $runtime_image =~ ^[^[:space:]]+@sha256:[0-9a-f]{64}$ ]] || {
	echo "RIVET_RUNTIME_IMAGE must be an immutable image digest" >&2
	exit 2
}

temporary_root=${TMPDIR:-/data/tmp}
mkdir -p "$temporary_root"
temporary=$(mktemp -d "$temporary_root/workerd-autoscaling.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

rendered=$temporary/workerd-autoscaling.yaml
sed \
	-e "s|__RIVET_REPORTER_IMAGE__|$image|g" \
	-e "s|__RIVET_RUNTIME_IMAGE__|$runtime_image|g" \
	"$manifest" >"$rendered"
if grep -Eq '__RIVET_(REPORTER|RUNTIME)_IMAGE__' "$rendered"; then
	echo "autoscaling manifest retained an unresolved image placeholder" >&2
	exit 1
fi

# Fail before mutation if this is not the q01 cluster shape that the two
# controllers are allowed to own. The runtime Secret remains externally
# provisioned and is never rendered into this artifact.
kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret actor-fleet-tcr >/dev/null
kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com np-runtime0 -o json | python3 -c '
import json, sys
machine_set = json.load(sys.stdin)
taints = machine_set["spec"]["template"]["spec"].get("taints", [])
required = {"key": "fleet.actor.dev/runtime-admission", "value": "pending", "effect": "NoSchedule"}
if required not in taints:
    raise SystemExit("np-runtime0 must carry the default-deny runtime admission taint before autoscaling is installed")
' >/dev/null

# runtime-capacity owns provider scale-down, OIDC identity and qualified repair
# policy; the HPA/Host-drain installer must not reset those settings to safe
# defaults on every reconciliation. Bootstrap it only when absent. Existing
# controllers are an ordering boundary: the runtime release workflow must
# converge the exact controller/runtime images first, and this installer merely
# verifies that prerequisite before owning its separate autoscaling resources.
# This prevents an HPA manifest refresh from silently disabling or enabling a
# provider capability.
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment \
	actor-bj-q01-runtime-capacity -o json >"$temporary/runtime-capacity.json" 2>/dev/null; then
	python3 "$script_dir/verify-existing-runtime-capacity.py" \
		--controller-image "$image" --runtime-image "$runtime_image" \
		"$temporary/runtime-capacity.json"
else
	RIVET_CELL_NAMESPACE="$namespace" \
	RIVET_CONTROLLER_NAMESPACE="$namespace" \
	RIVET_CELL_NAME=actor-bj-q01 \
	RUNTIME_MACHINE_SET=np-runtime0 \
	RUNTIME_CAPACITY_MAX_REPAIR_SURGE=1 \
	RUNTIME_ADMISSION_FIELD_MANAGER="$admission_field_manager" \
	RIVET_REPORTER_IMAGE="$image" \
	RIVET_RUNTIME_IMAGE="$runtime_image" \
		"$script_dir/../../runtime/install-admission-controller.sh"
fi

kubectl "${kubeconfig_args[@]}" apply --server-side --dry-run=server \
	--field-manager="$field_manager" -f "$rendered" >/dev/null

# Deliberately omit --force-conflicts. A second writer owning HPA, drain, or
# MachineSet-controller fields is an operator-visible conflict, not permission
# to steal those fields during an unattended install.
kubectl "${kubeconfig_args[@]}" apply --server-side \
	--field-manager="$field_manager" -f "$rendered"

kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
	deployment/actor-bj-q01-host-drain --timeout=5m
kubectl "${kubeconfig_args[@]}" -n "$namespace" get hpa \
	actor-bj-q01-runtime-hosts-actor-capacity >/dev/null

echo "q01 workerd autoscaling converged: image=$image field_manager=$field_manager"
