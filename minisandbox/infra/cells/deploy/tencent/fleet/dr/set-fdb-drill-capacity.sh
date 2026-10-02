#!/usr/bin/env bash
set -euo pipefail

desired=${1:?usage: set-fdb-drill-capacity.sh 9|10}
[[ $desired == 9 || $desired == 10 ]] || {
	echo "drill capacity must be 9 or 10" >&2
	exit 2
}

namespace=${ACTOR_NAMESPACE:-actor-fdb-cell-system}
: "${ACTOR_CELL_NAME:?ACTOR_CELL_NAME must name the exact Cell}"
cell=$ACTOR_CELL_NAME
machine_set=${ACTOR_FDB_MACHINESET:-np-fdbpool0}
timeout_seconds=${ACTOR_CAPACITY_TIMEOUT_SECONDS:-1800}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../operations" && pwd)

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="dr.capacity" \
	AUTONOMY_CONTROL_CELL="$cell" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
		"$operations_dir/assert-autonomy-control.sh"
fi

fdb_available=$(kubectl -n "$namespace" get foundationdbcluster "$cell" -o jsonpath='{.status.health.available}')
fdb_full=$(kubectl -n "$namespace" get foundationdbcluster "$cell" -o jsonpath='{.status.health.fullReplication}')
generation=$(kubectl -n "$namespace" get foundationdbcluster "$cell" -o jsonpath='{.metadata.generation}')
reconciled=$(kubectl -n "$namespace" get foundationdbcluster "$cell" -o jsonpath='{.status.generations.reconciled}')
backup_url=$(kubectl -n "$namespace" get foundationdbbackup "${cell}-continuous" -o jsonpath='{.status.backupDetails.url}')
backup_pod=$(kubectl -n "$namespace" get pods \
	-l "foundationdb.org/deployment-name=${cell}-continuous-backup-agents" \
	-o jsonpath='{.items[0].metadata.name}')
backup_restorable=false
if [[ $backup_url == blobstore://* && -n $backup_pod ]]; then
	backup_description=$(kubectl -n "$namespace" exec "$backup_pod" -c foundationdb -- \
		timeout 45 fdbbackup describe -d "$backup_url")
	if grep -q '^Restorable: true$' <<<"$backup_description"; then backup_restorable=true; fi
fi
[[ $fdb_available == true && $fdb_full == true && $generation == "$reconciled" && $backup_restorable == true ]] || {
	echo "source gate failed: available=$fdb_available full=$fdb_full generation=$generation/$reconciled backup_restorable=$backup_restorable" >&2
	exit 1
}

kubectl patch machineset "$machine_set" --type merge -p \
	"{\"spec\":{\"replicas\":$desired,\"scaling\":{\"minReplicas\":$desired,\"maxReplicas\":$desired}}}"

deadline=$((SECONDS + timeout_seconds))
while ((SECONDS < deadline)); do
	ready=$(kubectl get machineset "$machine_set" -o jsonpath='{.status.readyReplicas}')
	available=$(kubectl get machineset "$machine_set" -o jsonpath='{.status.availableReplicas}')
	observed=$(kubectl get machineset "$machine_set" -o jsonpath='{.status.observedGeneration}')
	current_generation=$(kubectl get machineset "$machine_set" -o jsonpath='{.metadata.generation}')
	nodes=$(kubectl get node -l "node.tke.cloud.tencent.com/machineset=$machine_set" -o json | \
		jq '[.items[] | select(any(.status.conditions[]; .type == "Ready" and .status == "True"))] | length')
	[[ ${ready:-0} == "$desired" && ${available:-0} == "$desired" && "$observed" == "$current_generation" && "$nodes" == "$desired" ]] && break
	sleep 10
done
[[ ${ready:-0} == "$desired" && ${available:-0} == "$desired" && "$observed" == "$current_generation" && "$nodes" == "$desired" ]] || {
	echo "MachineSet did not converge: desired=$desired ready=${ready:-0} available=${available:-0} generation=$current_generation/$observed nodes=$nodes" >&2
	exit 1
}

temporary=$(mktemp)
trap 'rm -f -- "$temporary"' EXIT
for node in $(kubectl get node -l "node.tke.cloud.tencent.com/machineset=$machine_set" -o name); do
	name=${node#node/}
	zone=$(kubectl get "$node" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')
	ready_state=$(kubectl get "$node" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')
	[[ $ready_state == true || $ready_state == True ]]
	printf '%s %s\n' "$zone" "$name" >>"$temporary"
done
zone_count=$(awk '{print $1}' "$temporary" | sort -u | wc -l | tr -d ' ')
[[ $zone_count -ge 3 ]] || {
	echo "dedicated capacity spans only $zone_count zones" >&2
	exit 1
}
min_zone=$(awk '{count[$1]++} END {for (z in count) print count[z]}' "$temporary" | sort -n | head -1)
max_zone=$(awk '{count[$1]++} END {for (z in count) print count[z]}' "$temporary" | sort -n | tail -1)
((max_zone - min_zone <= 1)) || {
	echo "ZoneEquality violated: min=$min_zone max=$max_zone" >&2
	exit 1
}

echo "machineset=$machine_set desired=$desired ready=$ready zones=$zone_count zone_min=$min_zone zone_max=$max_zone"
sort "$temporary"
