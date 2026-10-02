#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in date jq kubectl python3; do require_command "${command}"; done

runtime=${1:-runtime-a}
case ${runtime} in
	runtime-a) kubeconfig=${RUNTIME_A_KUBECONFIG} ;;
	runtime-b) kubeconfig=${RUNTIME_B_KUBECONFIG} ;;
	*) die "usage: $0 [runtime-a|runtime-b]" ;;
esac

namespace=${RIVET_LOCAL_FDB_NAMESPACE:-actor-fdb-cell-system}
cell=${RIVET_LOCAL_FDB_CELL:-local-${runtime}-cos}
baseline=${RIVET_LOCAL_FDB_BASELINE_PROCESS_COUNT:-9}
expanded=${RIVET_LOCAL_FDB_EXPANDED_PROCESS_COUNT:-12}
timeout_seconds=${RIVET_LOCAL_FDB_SCALE_TIMEOUT_SECONDS:-1800}
contraction_settle_seconds=${RIVET_LOCAL_FDB_CONTRACTION_SETTLE_SECONDS:-130}
evidence_root=${AGENTS_DIR:-${HOME}/.agents}/benchmarks/local-mesh/supernode-fdb-scale
run_id=$(date -u +%Y%m%dT%H%M%SZ)-${runtime}
evidence_dir=${RIVET_LOCAL_SUPERNODE_EVIDENCE_DIR:-${evidence_root}/${run_id}}

[[ ${baseline} =~ ^[1-9][0-9]*$ && ${expanded} =~ ^[1-9][0-9]*$ ]] || \
	die "FDB process counts must be positive integers"
(( expanded > baseline )) || die "expanded process count must exceed baseline"
mkdir -p "${evidence_dir}"

fdb() {
	kubectl_for "${kubeconfig}" -n "${namespace}" "$@"
}

capture() {
	local stage=$1
	fdb get foundationdbcluster "${cell}" -o json >"${evidence_dir}/${stage}-cluster.json"
	fdb get pods -l "foundationdb.org/fdb-cluster-name=${cell},foundationdb.org/fdb-process-class=storage" \
		-o json >"${evidence_dir}/${stage}-pods.json"
}

ready_storage_count() {
	fdb get pods -l "foundationdb.org/fdb-cluster-name=${cell},foundationdb.org/fdb-process-class=storage" -o json | \
		jq '[.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running" and
			([.status.containerStatuses[]? | select(.ready != true)] | length) == 0)] | length'
}

wait_topology() {
	local target=$1 deadline=$((SECONDS + timeout_seconds)) cluster_json ready
	while (( SECONDS < deadline )); do
		cluster_json=$(fdb get foundationdbcluster "${cell}" -o json)
		ready=$(ready_storage_count)
		if [[ $(jq -r '.spec.processCounts.storage' <<<"${cluster_json}") == "${target}" && \
			$(jq -r '.status.generations.reconciled // 0' <<<"${cluster_json}") == $(jq -r '.metadata.generation' <<<"${cluster_json}") && \
			$(jq -r '.status.health.available // false' <<<"${cluster_json}") == true && \
			$(jq -r '.status.health.fullReplication // false' <<<"${cluster_json}") == true && \
			$(jq -r '.status.reconciledProcessGroups // 0' <<<"${cluster_json}") == "${target}" && \
			$(jq '[.status.processGroups[]? | select(.removalTimestamp == null)] | length' <<<"${cluster_json}") == "${target}" && \
			$(jq '[.status.processGroups[]? | select(.removalTimestamp == null and ((.processGroupConditions // []) | length) != 0)] | length' <<<"${cluster_json}") == 0 && \
			${ready} == "${target}" ]]; then
			return 0
		fi
		sleep 5
	done
	return 1
}

set_target() {
	local target=$1 source
	source=$(fdb get foundationdbcluster "${cell}" -o jsonpath='{.spec.processCounts.storage}')
	log "${cell}: requesting ${target} real FDB storage Pods on the ${runtime} supernode"
	fdb patch foundationdbcluster "${cell}" --type merge \
		-p "{\"spec\":{\"processCounts\":{\"storage\":${target}}}}" >/dev/null
	if ! wait_topology "${target}"; then
		capture "failed-${target}" || true
		die "${cell} did not converge to ${target} Ready, fully replicated storage Pods"
	fi
	if (( target < source && contraction_settle_seconds > 0 )); then
		# The Operator deliberately rejects another recovery-sensitive process
		# mutation for 120 seconds after a recovery. Production hysteresis is much
		# longer; this bounded wait gives the compressed qualification equivalent
		# semantics instead of racing the next expansion into that safety window.
		sleep "${contraction_settle_seconds}"
	fi
}

original=$(fdb get foundationdbcluster "${cell}" -o jsonpath='{.spec.processCounts.storage}')
[[ ${original} =~ ^[1-9][0-9]*$ ]] || die "${cell} has an invalid original storage count"
restored=false
restore_original() {
	local status=$?
	trap - EXIT INT TERM
	if [[ ${restored} != true ]]; then
		log "restoring ${cell} to its original ${original}-Pod topology"
		fdb patch foundationdbcluster "${cell}" --type merge \
			-p "{\"spec\":{\"processCounts\":{\"storage\":${original}}}}" >/dev/null || true
		wait_topology "${original}" || status=1
	fi
	exit "${status}"
}
trap restore_original EXIT INT TERM

capture original
set_target "${baseline}"
capture baseline
set_target "${expanded}"
capture expanded
set_target "${baseline}"
capture contracted

# The qualification topology is temporary: preserve the installed Cell's exact
# pre-test shape so repeated runs do not become infrastructure mutations.
set_target "${original}"
restored=true
capture restored

python3 - "${evidence_dir}" "${runtime}" "${cell}" "${original}" "${baseline}" "${expanded}" <<'PY'
import hashlib, json, pathlib, sys

root = pathlib.Path(sys.argv[1])
runtime, cell = sys.argv[2:4]
original, baseline, expanded = map(int, sys.argv[4:7])
stages = {}
for stage, expected in (("original", original), ("baseline", baseline), ("expanded", expanded),
                        ("contracted", baseline), ("restored", original)):
    cluster = json.loads((root / f"{stage}-cluster.json").read_text())
    pods = json.loads((root / f"{stage}-pods.json").read_text())
    ready = [p for p in pods["items"] if p["metadata"].get("deletionTimestamp") is None
             and p.get("status", {}).get("phase") == "Running"
             and all(c.get("ready") for c in p.get("status", {}).get("containerStatuses", []))]
    assert cluster["spec"]["processCounts"]["storage"] == expected
    assert cluster["status"]["generations"]["reconciled"] == cluster["metadata"]["generation"]
    assert cluster["status"]["health"]["available"] is True
    assert cluster["status"]["health"]["fullReplication"] is True
    assert cluster["status"]["reconciledProcessGroups"] == expected
    active_groups = [g for g in cluster["status"]["processGroups"]
                     if g.get("removalTimestamp") is None]
    assert len(active_groups) == expected
    assert not [g for g in active_groups if g.get("processGroupConditions")]
    assert len(ready) == expected
    stages[stage] = {"expectedStoragePods": expected, "readyStoragePods": len(ready),
                     "clusterGeneration": cluster["metadata"]["generation"],
                     "podUIDs": sorted(p["metadata"]["uid"] for p in ready)}
receipt = {"schema": "rivet-local-supernode-fdb-scale/v1", "verdict": "passed",
           "runtime": runtime, "cell": cell,
           "physicalFailureDomains": 1, "topologySemantics": "Supernode",
           "qualifiedTransition": [baseline, expanded, baseline], "restoredTo": original,
           "stages": stages}
payload = (json.dumps(receipt, indent=2, sort_keys=True) + "\n").encode()
(root / "summary.json").write_bytes(payload)
(root / "summary.sha256").write_text(hashlib.sha256(payload).hexdigest() + "\n")
print(root / "summary.json")
PY

log "real supernode FDB ${baseline} -> ${expanded} -> ${baseline} qualification passed"
