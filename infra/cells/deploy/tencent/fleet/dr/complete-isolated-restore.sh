#!/usr/bin/env bash
set -euo pipefail

namespace=${ACTOR_NAMESPACE:-actor-fdb-cell-system}
cluster=${DR_FDB_CLUSTER:-actor-bj-k01-dr-20260818}
restore_deployment=${DR_RESTORE_DEPLOYMENT:-actor-bj-k01-dr-20260818-restore-agents}
restore_tag=${DR_RESTORE_TAG:-actor-bj-k01-dr-final}
expected_uid=${DR_EXPECTED_RESTORE_UID:-8e54ad990356b49ab6f90ade0cb46e23}
expected_version=${DR_EXPECTED_RESTORE_VERSION:-118475632413}
verifier_manifest=${DR_VERIFIER_MANIFEST:-/var/lib/actor-build/dr/verify-restored-actor.yaml}
verifier_job=${DR_VERIFIER_JOB:-actor-bj-k01-dr-verify-20260818}
timeout_seconds=${DR_RESTORE_TIMEOUT_SECONDS:-10800}
poll_seconds=${DR_RESTORE_POLL_SECONDS:-30}

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
deadline=$((SECONDS + timeout_seconds))
last_report=0

restore_status() {
	local agent
	agent=$(kubectl -n "$namespace" get pod \
		-l "app.kubernetes.io/name=${restore_deployment%-agents}-agent" \
		-o jsonpath='{.items[?(@.status.phase=="Running")].metadata.name}' | awk '{print $1}')
	[[ -n $agent ]] || {
		echo "no running restore agent" >&2
		return 1
	}
	kubectl -n "$namespace" exec "$agent" -- \
		fdbrestore status -t "$restore_tag" --dest_cluster_file /var/dynamic-conf/fdb.cluster 2>/dev/null
}

while ((SECONDS < deadline)); do
	status=$(restore_status)
	grep -q "UID: $expected_uid" <<<"$status" || {
		echo "restore UID mismatch" >&2
		echo "$status" >&2
		exit 1
	}
	grep -q "Version: $expected_version" <<<"$status" || {
		echo "restore version mismatch" >&2
		echo "$status" >&2
		exit 1
	}
	state=$(sed -n 's/.* State: \([^ ]*\).*/\1/p' <<<"$status" | head -1)
	if [[ $state == completed ]]; then
		echo "$status"
		break
	fi
	if [[ $state != running ]]; then
		echo "restore entered terminal failure state: $state" >&2
		echo "$status" >&2
		exit 1
	fi
	if ((SECONDS - last_report >= 120)); then
		echo "$status" | head -1
		last_report=$SECONDS
	fi
	sleep "$poll_seconds"
done
[[ ${state:-} == completed ]] || {
	echo "restore did not complete within ${timeout_seconds}s" >&2
	exit 1
}

for _ in $(seq 1 360); do
	available=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.status.health.available}')
	full=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.status.health.fullReplication}')
	generation=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.metadata.generation}')
	reconciled=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.status.generations.reconciled}')
	[[ $available == true && $full == true && $generation == "$reconciled" ]] && break
	sleep 10
done
[[ $available == true && $full == true && $generation == "$reconciled" ]] || {
	echo "isolated FDB did not reconcile after restore: available=$available full=$full generation=$generation reconciled=$reconciled" >&2
	exit 1
}

if kubectl -n "$namespace" get job "$verifier_job" >/dev/null 2>&1; then
	echo "verifier Job already exists; refusing to reuse possibly stale evidence" >&2
	exit 1
fi
kubectl apply -f "$verifier_manifest"
kubectl -n "$namespace" wait --for=condition=complete --timeout=20m "job/$verifier_job"
kubectl -n "$namespace" logs "job/$verifier_job"

finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
echo "dr_restore_completed_at=$finished_at"
echo "dr_completion_workflow_started_at=$started_at"
echo "dr_restore_uid=$expected_uid"
echo "dr_restore_version=$expected_version"
echo "dr_fdb_available=$available"
echo "dr_fdb_full_replication=$full"
echo "dr_fdb_reconciled_generation=$reconciled"
