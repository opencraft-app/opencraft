#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in base64 jq kubectl python3; do
	require_command "${command}"
done

failures=()

record_failure() {
	failures+=("$1")
}

check_managed_cluster() {
	local cluster=$1
	local kubeconfig=$2
	local managed condition endpoint secret
	if ! managed=$(kubectl_for "${HUB_KUBECONFIG}" get managedcluster "${cluster}" -o json 2>/dev/null); then
		record_failure "ManagedCluster ${cluster} is missing"
		return
	fi
	condition=$(jq -r '.status.conditions[]? | select(.type == "ManagedClusterConditionAvailable") | .status' <<<"${managed}")
	[[ ${condition} == True ]] || record_failure "ManagedCluster ${cluster} Available=${condition:-missing}"

	for secret in bootstrap-hub-kubeconfig hub-kubeconfig-secret; do
		endpoint=$(hub_kubeconfig_server "${kubeconfig}" "${secret}" || true)
		[[ ${endpoint} == "${HUB_INTERNAL_ENDPOINT}" ]] || \
			record_failure "${cluster}/${secret} uses ${endpoint:-missing}, expected ${HUB_INTERNAL_ENDPOINT}"
	done

	condition=$(kubectl_for "${kubeconfig}" get klusterlet klusterlet -o json 2>/dev/null | \
		jq -r '.status.conditions[]? | select(.type == "HubConnectionDegraded") | .status' || true)
	[[ ${condition:-False} != True ]] || record_failure "${cluster} Klusterlet reports HubConnectionDegraded=True"

	if ! kubectl_for "${kubeconfig}" -n open-cluster-management-agent wait deployment \
		klusterlet-registration-agent klusterlet-work-agent --for=condition=Available --timeout=1s >/dev/null 2>&1; then
		record_failure "${cluster} OCM agent deployments are not Available"
	fi
}

check_environment_reports() {
	local reports managed now
	if ! kubectl_for "${HUB_KUBECONFIG}" get crd rivetenvironmentreports.fleet.actor.dev >/dev/null 2>&1; then
		return
	fi
	reports=$(kubectl_for "${HUB_KUBECONFIG}" get rivetenvironmentreports -o json)
	if [[ $(jq '.items | length' <<<"${reports}") == 0 ]]; then
		if kubectl_for "${HUB_KUBECONFIG}" get shardpools -A -o name 2>/dev/null | grep -q .; then
			record_failure "no RivetEnvironmentReports exist for the configured ShardPools"
		fi
		return
	fi
	now=$(date -u +%s)
	for cluster in runtime-a runtime-b; do
		managed=$(kubectl_for "${HUB_KUBECONFIG}" get managedcluster "${cluster}" -o json)
		if ! python3 - "${cluster}" "${now}" "${MESH_REPORT_FRESHNESS_SECONDS}" \
			"$(jq -c --arg cluster "${cluster}" '.items[] | select(.spec.managedClusterRef.name == $cluster)' <<<"${reports}")" \
			"$(jq -c '{uid:.metadata.uid,generation:.metadata.generation}' <<<"${managed}")" <<'PY'
import datetime
import json
import sys

cluster, now, freshness, report_raw, managed_raw = sys.argv[1:]
if not report_raw:
    raise SystemExit(f"{cluster} has no RivetEnvironmentReport")
report = json.loads(report_raw)
managed = json.loads(managed_raw)
ref = report["spec"]["managedClusterRef"]
if ref.get("uid") != managed["uid"] or ref.get("generation") != managed["generation"]:
    raise SystemExit(f"{cluster} report references stale ManagedCluster identity")
observed = datetime.datetime.fromisoformat(report["spec"]["observedAt"].replace("Z", "+00:00")).timestamp()
age = int(now) - observed
if age < -30 or age > int(freshness):
    raise SystemExit(f"{cluster} report age {age:.0f}s exceeds freshness window {freshness}s")
PY
		then
			record_failure "${cluster} environment evidence is missing, stale, or fenced by an old identity"
		fi
	done
}

check_shard_pools() {
	local pools unhealthy
	if ! kubectl_for "${HUB_KUBECONFIG}" get crd shardpools.fleet.actor.dev >/dev/null 2>&1; then
		return
	fi
	pools=$(kubectl_for "${HUB_KUBECONFIG}" get shardpools -A -o json)
	if [[ $(jq '.items | length' <<<"${pools}") == 0 ]]; then
		return
	fi
	unhealthy=$(jq -r '.items[] | select(.status.admissionOpen != true or (.status.readyCells // 0) < .spec.minCells) | "\(.metadata.namespace)/\(.metadata.name): admissionOpen=\(.status.admissionOpen // false), readyCells=\(.status.readyCells // 0), minCells=\(.spec.minCells)"' <<<"${pools}")
	if [[ -n ${unhealthy} ]]; then
		while IFS= read -r pool; do
			record_failure "ShardPool ${pool}"
		done <<<"${unhealthy}"
	fi
}

check_managed_cluster runtime-a "${RUNTIME_A_KUBECONFIG}"
check_managed_cluster runtime-b "${RUNTIME_B_KUBECONFIG}"
check_environment_reports
check_shard_pools

if (( ${#failures[@]} != 0 )); then
	for failure in "${failures[@]}"; do
		printf '[local-mesh] unhealthy: %s\n' "${failure}" >&2
	done
	exit 1
fi

log "health verdict: healthy"
