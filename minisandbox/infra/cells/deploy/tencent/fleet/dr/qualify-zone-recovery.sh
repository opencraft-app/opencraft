#!/usr/bin/env bash
#
# Exercise one isolated-restore FDB storage process through a temporary
# dedicated-node scheduling outage. The target is selected by its Kubernetes
# zone, but only its node is cordoned. This does not claim a cloud AZ power or
# network failure; it proves the Kubernetes/Operator recovery path and always
# restores the exact node that this script cordons.
set -euo pipefail

namespace=${ACTOR_NAMESPACE:-actor-fdb-cell-system}
cluster=${DR_FDB_CLUSTER:?DR_FDB_CLUSTER is required}
drill_zone=${DRILL_ZONE:?DRILL_ZONE is required (a Kubernetes topology.kubernetes.io/zone value)}
execute=${DRILL_EXECUTE:-false}
fault_observation_seconds=${DRILL_FAULT_OBSERVATION_SECONDS:-30}
recovery_timeout_seconds=${DRILL_RECOVERY_TIMEOUT_SECONDS:-1800}
receipt=${DRILL_RECEIPT:-}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../operations" && pwd)

[[ $execute == true ]] || {
	echo "refusing mutation: set DRILL_EXECUTE=true after selecting an isolated restore cluster" >&2
	exit 2
}
[[ $fault_observation_seconds =~ ^[0-9]+$ && $recovery_timeout_seconds =~ ^[1-9][0-9]*$ ]] || {
	echo "DRILL_FAULT_OBSERVATION_SECONDS and DRILL_RECOVERY_TIMEOUT_SECONDS must be integers" >&2
	exit 2
}

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="dr.zone-recovery" \
	AUTONOMY_CONTROL_CELL="$cluster" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
	"$operations_dir/assert-autonomy-control.sh"
fi

health() {
	local available full generation reconciled
	available=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.status.health.available}')
	full=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.status.health.fullReplication}')
	generation=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.metadata.generation}')
	reconciled=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.status.generations.reconciled}')
	printf '%s\t%s\t%s\t%s\n' "$available" "$full" "$generation" "$reconciled"
}

storage_rows() {
	local pod node zone ready
	while IFS= read -r pod; do
		node=$(kubectl -n "$namespace" get pod "$pod" -o jsonpath='{.spec.nodeName}')
		zone=$(kubectl get node "$node" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')
		ready=true
		container_ready=$(kubectl -n "$namespace" get pod "$pod" -o jsonpath='{range .status.containerStatuses[*]}{.ready}{" "}{end}')
		[[ -n $container_ready ]] || ready=false
		for status in $container_ready; do
			[[ $status == true ]] || ready=false
		done
		printf '%s\t%s\t%s\t%s\n' "$pod" "$node" "$zone" "$ready"
	done < <(kubectl -n "$namespace" get pods -o name | sed -n "s#^pod/${cluster}-storage-#${cluster}-storage-#p")
}

storage_gate() {
	local rows count zones ready_count
	rows=$(storage_rows)
	count=$(awk 'NF { count++ } END { print count + 0 }' <<<"$rows")
	zones=$(awk -F '\t' 'NF { seen[$3] = 1 } END { print length(seen) }' <<<"$rows")
	ready_count=$(awk -F '\t' '$4 == "true" { count++ } END { print count + 0 }' <<<"$rows")
	[[ $count == 3 && $zones == 3 && $ready_count == 3 ]]
}

mapfile -t initial_health < <(health | tr '\t' '\n')
[[ ${initial_health[0]} == true && ${initial_health[1]} == true && ${initial_health[2]} == "${initial_health[3]}" ]] || {
	echo "isolated FDB source gate failed: available=${initial_health[0]} full=${initial_health[1]} generation=${initial_health[2]}/${initial_health[3]}" >&2
	exit 1
}
storage_gate || {
	echo "isolated FDB must start with exactly three Ready storage Pods in three zones" >&2
	storage_rows >&2
	exit 1
}

target_row=$(storage_rows | awk -F '\t' -v zone="$drill_zone" '$3 == zone { print }')
[[ $(wc -l <<<"$target_row" | tr -d ' ') == 1 ]] || {
	echo "selected zone must contain exactly one storage Pod: zone=$drill_zone" >&2
	storage_rows >&2
	exit 1
}
IFS=$'\t' read -r target_pod target_node target_zone target_ready <<<"$target_row"

[[ $(kubectl get node "$target_node" -o jsonpath='{.metadata.labels.fleet\.actor\.dev/fdb-dedicated}') == true ]] || {
	echo "target node is not dedicated to FDB: $target_node" >&2
	exit 1
}
[[ $(kubectl get node "$target_node" -o jsonpath='{.spec.unschedulable}') != true ]] || {
	echo "target node is already cordoned: $target_node" >&2
	exit 1
}
mapfile -t collocated_other_fdb < <(kubectl -n "$namespace" get pods --field-selector "spec.nodeName=$target_node" \
	-o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.foundationdb\.org/fdb-cluster-name}{"\n"}{end}' | \
	awk -F '\t' -v cluster="$cluster" '$2 != "" && $2 != cluster { print $1 " (" $2 ")" }')
((${#collocated_other_fdb[@]} == 0)) || {
	echo "refusing to cordon a node shared with another FDB cluster: ${collocated_other_fdb[*]}" >&2
	exit 1
}
cordon_nodes=("$target_node")

cordons_active=false
uncordon_nodes() {
	[[ $cordons_active == true ]] || return 0
	local node
	for node in "${cordon_nodes[@]}"; do
		kubectl uncordon "$node" >&2 || true
	done
	cordons_active=false
}
trap uncordon_nodes EXIT INT TERM

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
started_unix=$(date -u +%s)
for node in "${cordon_nodes[@]}"; do
	kubectl cordon "$node" >&2
done
cordons_active=true

# Normal deletion only: never --force. The FoundationDB Operator owns the
# replacement process group and all data movement.
kubectl -n "$namespace" delete pod "$target_pod" --wait=false >&2

observed_unready=false
observation_deadline=$((SECONDS + fault_observation_seconds))
while ((SECONDS < observation_deadline)); do
	if ! kubectl -n "$namespace" get pod "$target_pod" >/dev/null 2>&1; then
		observed_unready=true
		break
	fi
	current_ready=true
	container_ready=$(kubectl -n "$namespace" get pod "$target_pod" -o jsonpath='{range .status.containerStatuses[*]}{.ready}{" "}{end}')
	[[ -n $container_ready ]] || current_ready=false
	for status in $container_ready; do
		[[ $status == true ]] || current_ready=false
	done
	if [[ $current_ready != true ]]; then
		observed_unready=true
		break
	fi
	sleep 2
done

recovery_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
recovery_started_unix=$(date -u +%s)
uncordon_nodes

recovered=false
deadline=$((SECONDS + recovery_timeout_seconds))
while ((SECONDS < deadline)); do
	mapfile -t current_health < <(health | tr '\t' '\n')
	if [[ ${current_health[0]} == true && ${current_health[1]} == true && ${current_health[2]} == "${current_health[3]}" ]] && storage_gate; then
		recovered=true
		break
	fi
	sleep 10
done
[[ $recovered == true ]] || {
	echo "recovery gate timed out after ${recovery_timeout_seconds}s" >&2
	health >&2
	storage_rows >&2
	exit 1
}

completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
completed_unix=$(date -u +%s)
recovery_rto_seconds=$((completed_unix - recovery_started_unix))
total_elapsed_seconds=$((completed_unix - started_unix))

if [[ -n $receipt ]]; then
	DRILL_STORAGE_ROWS=$(storage_rows) \
	DRILL_CORDONED_NODES=$(printf '%s\n' "${cordon_nodes[@]}") \
	DRILL_STARTED_AT=$started_at \
	DRILL_RECOVERY_STARTED_AT=$recovery_started_at \
	DRILL_COMPLETED_AT=$completed_at \
	DRILL_CLUSTER=$cluster \
	DRILL_NAMESPACE=$namespace \
	DRILL_ZONE=$drill_zone \
	DRILL_TARGET_POD=$target_pod \
	DRILL_TARGET_NODE=$target_node \
	DRILL_OBSERVED_UNREADY=$observed_unready \
	DRILL_RECOVERY_RTO_SECONDS=$recovery_rto_seconds \
	DRILL_TOTAL_ELAPSED_SECONDS=$total_elapsed_seconds \
	python3 - "$receipt" <<'PY'
import json
import os
import sys

path = sys.argv[1]
storage = []
for row in os.environ["DRILL_STORAGE_ROWS"].splitlines():
    pod, node, zone, ready = row.split("\t")
    storage.append({"pod": pod, "node": node, "zone": zone, "ready": ready == "true"})
receipt = {
    "kind": "isolated-fdb-node-recovery",
    "verdict": "passed",
    "started_at": os.environ["DRILL_STARTED_AT"],
    "recovery_started_at": os.environ["DRILL_RECOVERY_STARTED_AT"],
    "completed_at": os.environ["DRILL_COMPLETED_AT"],
    "isolated_cluster": os.environ["DRILL_CLUSTER"],
    "namespace": os.environ["DRILL_NAMESPACE"],
    "selected_kubernetes_zone": os.environ["DRILL_ZONE"],
    "target": {
        "pod": os.environ["DRILL_TARGET_POD"],
        "node": os.environ["DRILL_TARGET_NODE"],
    },
    "cordoned_dedicated_nodes": os.environ["DRILL_CORDONED_NODES"].splitlines(),
    "observed_target_unready": os.environ["DRILL_OBSERVED_UNREADY"] == "true",
    "recovery_rto_seconds": int(os.environ["DRILL_RECOVERY_RTO_SECONDS"]),
    "total_elapsed_seconds": int(os.environ["DRILL_TOTAL_ELAPSED_SECONDS"]),
    "storage_after_recovery": storage,
    "limitation": "The target was selected by zone, but only its isolated-restore node was cordoned. This is not a cloud AZ power or network outage.",
}
with open(path, "w") as output:
    json.dump(receipt, output, indent=2, sort_keys=True)
    output.write("\n")
PY
	sha256sum "$receipt"
fi

echo "dr_node_recovery=passed cluster=$cluster zone=$drill_zone target_pod=$target_pod observed_unready=$observed_unready recovery_rto_seconds=$recovery_rto_seconds"
