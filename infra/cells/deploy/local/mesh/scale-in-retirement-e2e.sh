#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in kubectl jq date; do require_command "${command}"; done

namespace=actor-fleet-system
pool=local-mesh
reporter_namespace=actor-fleet-controller-system
reporter=local-environment-reporter
source_cell=""
new_claim=""
new_cell=""
new_work=""
cleaned=false

wait_until() {
	local predicate=$1
	local timeout=$2
	local description=$3
	local deadline=$((SECONDS + timeout))
	while (( SECONDS < deadline )); do
		if "${predicate}"; then return; fi
		sleep 2
	done
	die "timed out waiting for ${description}"
}

hub() { kubectl_for "${HUB_KUBECONFIG}" "$@"; }
spoke_a() { kubectl_for "${RUNTIME_A_KUBECONFIG}" "$@"; }

refresh_runtime_a_capacity() {
	local observed_at
	observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	hub patch rivetenvironmentreport local-runtime-a --type=merge -p \
		"{\"spec\":{\"observedAt\":\"${observed_at}\",\"capacity\":{\"maxCells\":2,\"currentCells\":1,\"provisioningCells\":0,\"availableCellSlots\":1,\"allocatableCellUnits\":2,\"maxConcurrentProvisioning\":1}}}" >/dev/null
}

new_claim_exists() {
	local claims
	claims=$(hub -n "${namespace}" get rivetcellclaim -o json)
	new_claim=$(jq -r --argjson before "${initial_claim_names}" \
		'.items[] | select((.metadata.name as $name | ($before | index($name)) == null)) | .metadata.name' <<<"${claims}" | head -1)
	[[ -n ${new_claim} ]]
}

new_claim_bound() {
	[[ $(hub -n "${namespace}" get rivetcellclaim "${new_claim}" -o jsonpath='{.status.phase}' 2>/dev/null) == Bound ]]
}

pool_candidate_is_new_cell() {
	[[ $(hub -n "${namespace}" get shardpool "${pool}" -o jsonpath='{.status.scaleInCandidate.cellName}') == "${new_cell}" ]]
}

hub_desired_is() {
	[[ $(hub -n "${namespace}" get rivetcell "${new_cell}" -o jsonpath='{.spec.desiredState}') == "$1" ]]
}

hub_draining() { hub_desired_is Draining; }
hub_retired() { hub_desired_is Retired; }

spoke_desired_is() {
	[[ $(spoke_a -n "${namespace}" get rivetcell "${new_cell}" -o jsonpath='{.spec.desiredState}' 2>/dev/null) == "$1" ]]
}

spoke_draining() { spoke_desired_is Draining; }
spoke_retired() { spoke_desired_is Retired; }

work_deleted() {
	! hub -n runtime-a get manifestwork "${new_work}" >/dev/null 2>&1
}

spoke_retired_or_compute_deleted() {
	spoke_retired || (hub_retirement_verified && work_deleted)
}

hub_retirement_verified() {
	local cell
	cell=$(hub -n "${namespace}" get rivetcell "${new_cell}" -o json)
	[[ $(jq -r '.status.phase' <<<"${cell}") == Retired && \
		$(jq -r '.status.retirementProofReady' <<<"${cell}") == true && \
		$(jq -r '.status.retirementProofVerified' <<<"${cell}") == true ]]
}

baseline_restored() {
	[[ $(hub -n "${namespace}" get rivetcellclaim -o json | jq '.items | length') == 2 && \
		$(hub -n "${namespace}" get rivetcell -o json | jq '.items | length') == 2 ]]
}

existing_identity_unchanged() {
	local current
	current=$(hub -n "${namespace}" get rivetcellclaim -o json | jq -c --argjson initial "${initial_claim_names}" \
		'[.items[]|select(.metadata.name as $name|($initial|index($name)) != null)|{name:.metadata.name,uid:.metadata.uid,provider:.status.providerRef,workUID:.status.workRef.uid,logicalUID:.status.cellRef.uid,spokeUID:.status.spokeCellRef.uid}]|sort_by(.name)')
	[[ ${current} == "${initial_identity}" ]]
}

federated_inventory_restored() {
	local proxy='/api/v1/namespaces/mesh-observability/services/http:actor-mesh-observability-prometheus:9090/proxy'
	local query='actor_fleet%3Acell_inventory%20and%20%28time%28%29%20-%20actor_fleet%3Acell_heartbeat_seconds%20%3C%2060%29'
	local inventory
	inventory=$(hub get --raw "${proxy}/api/v1/query?query=${query}")
	[[ $(jq -r '[.data.result[].metric.cluster] | sort | join(",")' <<<"${inventory}") == runtime-a,runtime-b ]]
}

cleanup() {
	[[ ${cleaned} == true ]] && return
	log "restoring the two-Cell baseline after the retirement drill"
	if [[ -n ${source_cell} ]]; then
		spoke_a -n "${namespace}" annotate rivetcell "${source_cell}" \
			local.fleet.actor.dev/capacity-risk- local.fleet.actor.dev/scale-out-epoch- >/dev/null 2>&1 || true
	fi
	if [[ -n ${new_claim} ]]; then
		hub -n "${namespace}" delete rivetcellclaim "${new_claim}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
	fi
	if [[ -n ${new_work} ]]; then
		hub -n runtime-a delete manifestwork "${new_work}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
	fi
	if [[ -n ${new_cell} ]]; then
		spoke_a -n "${namespace}" delete rivetcell "${new_cell}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
		hub -n "${namespace}" delete rivetcell "${new_cell}" --ignore-not-found --wait=false >/dev/null 2>&1 || true
	fi
	hub -n "${namespace}" patch shardpool "${pool}" --type=merge -p \
		'{"spec":{"maxCells":2,"scaleIn":{"mode":"Disabled","enterUtilizationPercent":25,"exitUtilizationPercent":40,"observationSeconds":604800,"maxConcurrentRetirements":1}}}' >/dev/null 2>&1 || true
	hub -n "${reporter_namespace}" scale deployment/${reporter} --replicas=1 >/dev/null 2>&1 || true
	hub -n "${reporter_namespace}" rollout status deployment/${reporter} --timeout=3m >/dev/null 2>&1 || true
	"${MESH_DIR}/sync-environment-report.sh" runtime-a 0 >/dev/null 2>&1 || true
	"${MESH_DIR}/sync-environment-report.sh" runtime-b 0 >/dev/null 2>&1 || true
	cleaned=true
}
trap cleanup EXIT

"${MESH_DIR}/verify-federated-placement.sh"
initial_claim_names=$(hub -n "${namespace}" get rivetcellclaim -o json | jq -c '[.items[].metadata.name]')
initial_identity=$(hub -n "${namespace}" get rivetcellclaim -o json | \
	jq -c '[.items[]|{name:.metadata.name,uid:.metadata.uid,provider:.status.providerRef,workUID:.status.workRef.uid,logicalUID:.status.cellRef.uid,spokeUID:.status.spokeCellRef.uid}]|sort_by(.name)')
source_cell=$(spoke_a -n "${namespace}" get rivetcell -o json | jq -r '.items[0].metadata.name')

log "opening one temporary runtime-a Cell slot and injecting a production capacity-pressure epoch"
hub -n "${reporter_namespace}" scale deployment/${reporter} --replicas=0 >/dev/null
hub -n "${namespace}" patch shardpool "${pool}" --type=merge -p \
	'{"spec":{"maxCells":3,"scaleIn":{"mode":"Disabled","enterUtilizationPercent":25,"exitUtilizationPercent":40,"observationSeconds":604800,"maxConcurrentRetirements":1}}}' >/dev/null
refresh_runtime_a_capacity
spoke_a -n "${namespace}" annotate rivetcell "${source_cell}" --overwrite \
	local.fleet.actor.dev/capacity-risk=AdmissionClosed \
	local.fleet.actor.dev/scale-out-epoch=1 >/dev/null

deadline=$((SECONDS + 180))
while (( SECONDS < deadline )); do
	refresh_runtime_a_capacity
	if new_claim_exists; then break; fi
	sleep 5
done
[[ -n ${new_claim} ]] || die "capacity pressure did not create a third Claim"

spoke_a -n "${namespace}" annotate rivetcell "${source_cell}" \
	local.fleet.actor.dev/capacity-risk- local.fleet.actor.dev/scale-out-epoch- >/dev/null
wait_until new_claim_bound 240 "third Claim to bind"
new_cell=$(hub -n "${namespace}" get rivetcellclaim "${new_claim}" -o jsonpath='{.status.placementDecision.logicalCellName}')
new_work=$(hub -n "${namespace}" get rivetcellclaim "${new_claim}" -o jsonpath='{.status.workRef.name}')
[[ -n ${new_cell} && -n ${new_work} ]] || die "third Claim has incomplete durable identity"
[[ $(hub -n "${namespace}" get rivetcellclaim "${new_claim}" -o jsonpath='{.status.placementDecision.targetClusterRef.name}') == runtime-a ]] || die "third Cell was not placed in the only environment with a free slot"

log "publishing low-load evidence only for ${new_cell}"
spoke_a -n "${namespace}" annotate rivetcell "${new_cell}" --overwrite \
	local.fleet.actor.dev/scale-in-evidence=true >/dev/null
hub patch rivetenvironmentreport local-runtime-a --type=merge -p \
	'{"spec":{"capacity":{"maxCells":2,"currentCells":2,"provisioningCells":0,"availableCellSlots":0,"allocatableCellUnits":2,"maxConcurrentProvisioning":1}}}' >/dev/null
hub -n "${namespace}" patch shardpool "${pool}" --type=merge -p \
	'{"spec":{"maxCells":3,"scaleIn":{"mode":"Automatic","enterUtilizationPercent":25,"exitUtilizationPercent":40,"observationSeconds":3600,"maxConcurrentRetirements":1}}}' >/dev/null
wait_until pool_candidate_is_new_cell 180 "deterministic low-load scale-in candidate"

request_id=$(hub -n "${namespace}" get shardpool "${pool}" -o jsonpath='{.status.scaleInCandidate.requestId}')
observed_since=$(date -u -d '2 hours ago' +%Y-%m-%dT%H:%M:%SZ)
hub -n "${namespace}" patch shardpool "${pool}" --subresource=status --type=merge -p \
	"{\"status\":{\"scaleInCandidate\":{\"cellName\":\"${new_cell}\",\"cellUID\":\"$(hub -n "${namespace}" get rivetcell "${new_cell}" -o jsonpath='{.metadata.uid}')\",\"requestId\":\"${request_id}\",\"observedSince\":\"${observed_since}\",\"compositeLoadPercent\":0}}}" >/dev/null

wait_until hub_draining 120 "Hub Cell to cross the Draining boundary"
wait_until spoke_draining 120 "OCM to propagate Draining to the spoke"

log "injecting the external exact-key/COS/FDB retirement receipt after Draining"
spoke_a -n "${namespace}" annotate rivetcell "${new_cell}" --overwrite \
	local.fleet.actor.dev/retirement-proof=true >/dev/null
wait_until hub_retired 180 "Hub Cell to cross the Retired generation boundary"
wait_until hub_retirement_verified 180 "verified retirement proof to mirror to Hub"
wait_until spoke_retired_or_compute_deleted 120 "OCM to propagate Retired or remove the proven compute Work"
wait_until work_deleted 180 "retired compute ManifestWork to be deleted"

[[ $(hub -n "${namespace}" get shardpool "${pool}" -o jsonpath='{.status.readyCells}') == 2 ]] || die "retirement reduced the Pool below minCells"
[[ $(hub -n "${namespace}" get shardpool "${pool}" -o jsonpath='{.status.admissionOpen}') == true ]] || die "healthy Cells did not remain admission-open"
[[ $(hub -n runtime-a get manifestwork -o json | jq '[.items[]|select(.metadata.name!="local-mesh-smoke")]|length') == 1 ]] || die "retirement did not remove exactly one compute Work"
wait_until existing_identity_unchanged 90 "the original Claim/Work/Cell identity set to converge unchanged"

log "reverse path passed: pressure added one Cell, hysteresis drained it, proof retired it, and only compute Work was removed"
cleanup
wait_until baseline_restored 120 "two-Cell baseline cleanup"
wait_until federated_inventory_restored 120 "federated stale series to leave the active inventory"
"${MESH_DIR}/verify-federated-placement.sh"
log "scale-in retirement E2E passed and the reusable baseline was restored"
