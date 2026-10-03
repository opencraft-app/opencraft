#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
cell_name=${RIVET_CELL_NAME:?RIVET_CELL_NAME is required}
controller_image=${RIVET_REPORTER_IMAGE:?RIVET_REPORTER_IMAGE is required}
min_replicas=${RUNTIME_CAPACITY_MIN_REPLICAS:-4}
max_replicas=${RUNTIME_CAPACITY_MAX_REPLICAS:-301}
target_active_actors=${RUNTIME_CAPACITY_TARGET_ACTIVE_ACTORS:-16}
topology_max_skew=${RUNTIME_HOST_DRAIN_TOPOLOGY_MAX_SKEW:-2}
topology_repair_enabled=${RUNTIME_HOST_DRAIN_TOPOLOGY_REPAIR_ENABLED:-false}
runtime_machine_set=${RUNTIME_MACHINE_SET:-np-runtime0}
field_manager=${RUNTIME_AUTOSCALING_FIELD_MANAGER:-rivet-runtime-autoscaling}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

[[ $cell_name =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "RIVET_CELL_NAME must be a DNS label" >&2
	exit 2
}
[[ $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "RIVET_CELL_NAMESPACE must be a DNS label" >&2
	exit 2
}
[[ $runtime_machine_set =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "RUNTIME_MACHINE_SET must be a DNS label" >&2
	exit 2
}
[[ $topology_repair_enabled == true || $topology_repair_enabled == false ]] || {
	echo "RUNTIME_HOST_DRAIN_TOPOLOGY_REPAIR_ENABLED must be true or false" >&2
	exit 2
}
[[ $controller_image =~ ^[^[:space:]]+/actor-fleet/actor-fleet-controller@sha256:[0-9a-f]{64}$ ]] || {
	echo "RIVET_REPORTER_IMAGE must be the digest-pinned actor-fleet-controller" >&2
	exit 2
}
for value in "$min_replicas" "$max_replicas" "$target_active_actors" "$topology_max_skew"; do
	[[ $value =~ ^[1-9][0-9]*$ ]] || {
		echo "Host autoscaling limits must be positive decimal integers" >&2
		exit 2
	}
done
((max_replicas >= min_replicas)) || {
	echo "RUNTIME_CAPACITY_MAX_REPLICAS must be at least the minimum" >&2
	exit 2
}
[[ $field_manager =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || {
	echo "RUNTIME_AUTOSCALING_FIELD_MANAGER is invalid" >&2
	exit 2
}

for command in kubectl sed; do
	command -v "$command" >/dev/null || {
		echo "required command is missing: $command" >&2
		exit 2
	}
done
kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret actor-fleet-tcr >/dev/null
kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret "${cell_name}-runtime-auth" >/dev/null
kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-runtime-hosts" >/dev/null

temporary_root=${TMPDIR:-/data/tmp}
mkdir -p "$temporary_root"
temporary=$(mktemp -d "$temporary_root/runtime-autoscaling.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
rendered=$temporary/host-autoscaling.yaml
sed \
	-e "s|__CELL_NAME__|$cell_name|g" \
	-e "s|__NAMESPACE__|$namespace|g" \
	-e "s|__CONTROLLER_IMAGE__|$controller_image|g" \
	-e "s|__MIN_REPLICAS__|$min_replicas|g" \
	-e "s|__MAX_REPLICAS__|$max_replicas|g" \
	-e "s|__TARGET_ACTIVE_ACTORS__|$target_active_actors|g" \
	-e "s|__TOPOLOGY_MAX_SKEW__|$topology_max_skew|g" \
	-e "s|__TOPOLOGY_REPAIR_ENABLED__|$topology_repair_enabled|g" \
	-e "s|__RUNTIME_MACHINE_SET__|$runtime_machine_set|g" \
	"$script_dir/host-autoscaling.yaml" >"$rendered"
if grep -Eq '__[A-Z0-9_]+__' "$rendered"; then
	echo "Host autoscaling manifest retained an unresolved placeholder" >&2
	exit 1
fi

kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts --dry-run=server \
	--field-manager="$field_manager" -f "$rendered" >/dev/null
# This installer is the sole declarative owner of the Host drain controller.
# Older transactional rollbacks and emergency `kubectl set image` operations
# can leave release fields under an Update manager. Reclaim the complete,
# rendered object atomically so a later release cannot fail after Engine and
# Host have already converged. The rendered manifest deliberately excludes
# live StatefulSet replica state and all provider-owned Node fields.
kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
	--field-manager="$field_manager" -f "$rendered"
kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
	deployment/"${cell_name}-host-drain" --timeout=5m
[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment \
	"${cell_name}-host-drain" -o jsonpath='{.spec.template.metadata.annotations.fleet\.actor\.dev/runtime-release-hold-protocol}') == statefulset-uid-cas-v1 ]]
[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment \
	"${cell_name}-host-drain" -o jsonpath='{.spec.template.spec.containers[0].image}') == "$controller_image" ]]
kubectl "${kubeconfig_args[@]}" -n "$namespace" get hpa \
	"${cell_name}-runtime-hosts-actor-capacity" >/dev/null

# Applying an HPA does not synchronously enforce minReplicas. A fresh runtime
# manifest starts with one Host, so returning here used to let the release
# transaction observe spec.replicas=1 and roll back an otherwise healthy new
# Cell. Treat the HPA floor as part of this installer's convergence contract.
for _ in $(seq 1 150); do
	read -r desired ready updated < <(
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
			"${cell_name}-runtime-hosts" \
			-o jsonpath='{.spec.replicas}{" "}{.status.readyReplicas}{" "}{.status.updatedReplicas}{"\n"}'
	)
	if [[ $desired =~ ^[0-9]+$ && $ready == "$desired" && $updated == "$desired" ]] \
		&& ((desired >= min_replicas)); then
		break
	fi
	sleep 2
done
read -r desired ready updated < <(
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
		"${cell_name}-runtime-hosts" \
		-o jsonpath='{.spec.replicas}{" "}{.status.readyReplicas}{" "}{.status.updatedReplicas}{"\n"}'
)
[[ $desired =~ ^[0-9]+$ && $ready == "$desired" && $updated == "$desired" ]] \
	&& ((desired >= min_replicas)) || {
	echo "runtime Host HPA did not converge its minimum Ready floor" >&2
	exit 1
}

echo "runtime Host autoscaling converged: cell=$cell_name min=$min_replicas max=$max_replicas"
