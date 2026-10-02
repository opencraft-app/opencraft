#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

mode=${1:-quick}
[[ ${mode} == quick || ${mode} == full ]] || die "usage: $0 [quick|full]"
for command in date flock go jq kubectl; do require_command "${command}"; done

mkdir -p "${MESH_STATE_DIR}"
exec 9>"${MESH_STATE_DIR}/qualification.lock"
if ! flock -n 9; then
	die "another local-mesh qualification run is active"
fi

evidence_root=${AGENTS_DIR:-${HOME}/.agents}/benchmarks/local-mesh
run_id=$(date -u +%Y%m%dT%H%M%SZ)-${mode}
evidence_dir=${LOCAL_MESH_EVIDENCE_DIR:-${evidence_root}/${run_id}}
mkdir -p "${evidence_dir}/logs"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
results_file=${evidence_dir}/results.jsonl
: >"${results_file}"

hub() { kubectl_for "${HUB_KUBECONFIG}" "$@"; }

capture_identity() {
	local claims works managed
	claims=$(hub -n actor-fleet-system get rivetcellclaim -o json)
	works=$(hub get manifestwork -A -o json)
	managed=$(hub get managedcluster runtime-a runtime-b -o json)
	jq -cn --argjson claims "${claims}" --argjson works "${works}" --argjson managed "${managed}" '
		{
			managed: [$managed.items[] | {name: .metadata.name, uid: .metadata.uid}] | sort_by(.name),
			claims: [$claims.items[] | {
				name: .metadata.name,
				uid: .metadata.uid,
				providerRef: .status.providerRef,
				workUID: .status.workRef.uid,
				logicalCellUID: .status.cellRef.uid,
				spokeCellUID: .status.spokeCellRef.uid
			}] | sort_by(.name),
			works: [$works.items[] | select(.metadata.name != "local-mesh-smoke") | {
				namespace: .metadata.namespace,
				name: .metadata.name,
				uid: .metadata.uid
			}] | sort_by([.namespace, .name])
		}'
}

capture_state() {
	local output=$1
	local prefix=${output}.source
	hub get managedcluster -o json >"${prefix}.managed.json"
	hub -n actor-fleet-system get shardpool local-mesh -o json >"${prefix}.pool.json"
	hub -n actor-fleet-system get rivetcellclaim -o json >"${prefix}.claims.json"
	hub -n actor-fleet-system get rivetcell -o json >"${prefix}.cells.json"
	hub get rivetenvironmentreport -o json >"${prefix}.environments.json"
	hub get --raw '/api/v1/namespaces/mesh-observability/services/http:actor-mesh-observability-prometheus:9090/proxy/api/v1/targets' >"${prefix}.targets.json"
	jq -n \
		--arg capturedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		--slurpfile managed "${prefix}.managed.json" --slurpfile pool "${prefix}.pool.json" \
		--slurpfile claims "${prefix}.claims.json" --slurpfile cells "${prefix}.cells.json" \
		--slurpfile environments "${prefix}.environments.json" --slurpfile targets "${prefix}.targets.json" \
		'{capturedAt: $capturedAt, managedClusters: $managed[0], pool: $pool[0], claims: $claims[0], cells: $cells[0], environmentReports: $environments[0], prometheusTargets: $targets[0]}' \
		>"${output}"
	rm -f "${prefix}.managed.json" "${prefix}.pool.json" "${prefix}.claims.json" \
		"${prefix}.cells.json" "${prefix}.environments.json" "${prefix}.targets.json"
}

write_summary() {
	local status=$1
	jq -s \
		--arg runId "${run_id}" --arg mode "${mode}" --arg status "${status}" \
		--arg startedAt "${started_at}" --arg completedAt "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		--arg evidenceDir "${evidence_dir}" \
		'{runId: $runId, mode: $mode, status: $status, startedAt: $startedAt, completedAt: $completedAt, evidenceDir: $evidenceDir, gates: .}' \
		"${results_file}" >"${evidence_dir}/summary.json.tmp"
	mv "${evidence_dir}/summary.json.tmp" "${evidence_dir}/summary.json"
}

run_gate() {
	local name=$1
	shift
	local gate_started started_epoch completed_epoch exit_code status
	gate_started=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	started_epoch=$(date +%s)
	log "qualification gate ${name} started"
	set +e
	("$@") > >(tee "${evidence_dir}/logs/${name}.log") 2>&1
	exit_code=$?
	set -e
	completed_epoch=$(date +%s)
	status=passed
	if (( exit_code != 0 )); then status=failed; fi
	jq -cn \
		--arg name "${name}" --arg status "${status}" --arg startedAt "${gate_started}" \
		--arg log "logs/${name}.log" --argjson exitCode "${exit_code}" \
		--argjson durationSeconds "$((completed_epoch - started_epoch))" \
		'{name: $name, status: $status, exitCode: $exitCode, startedAt: $startedAt, durationSeconds: $durationSeconds, log: $log}' \
		>>"${results_file}"
	if (( exit_code != 0 )); then
		capture_state "${evidence_dir}/failed-state.json" || true
		write_summary failed
		die "qualification gate ${name} failed; evidence: ${evidence_dir}/summary.json"
	fi
	log "qualification gate ${name} passed"
}

identity_before=$(capture_identity)
printf '%s\n' "${identity_before}" | jq . >"${evidence_dir}/identity-before.json"
capture_state "${evidence_dir}/state-before.json"

run_gate mesh-health "${MESH_DIR}/verify.sh"
run_gate go-state-machines bash -c \
	"cd '${CELLS_DIR}' && GOTOOLCHAIN=auto GOSUMDB=sum.golang.org go test ./..."
run_gate federated-placement "${MESH_DIR}/verify-federated-placement.sh"
run_gate freshness-window "${MESH_DIR}/steady-state-e2e.sh"

if [[ ${mode} == full ]]; then
	run_gate hub-endpoint-recovery "${MESH_DIR}/hub-endpoint-recovery-e2e.sh"
	run_gate evidence-stall "${MESH_DIR}/evidence-stall-e2e.sh"
	run_gate prometheus-outage "${MESH_DIR}/prometheus-outage-e2e.sh"
	run_gate fdb-scale-down "${MESH_DIR}/fdb-scale-down-e2e.sh"
	run_gate cell-scale-in "${MESH_DIR}/scale-in-retirement-e2e.sh"
	run_gate spoke-failure-recovery "${MESH_DIR}/failure-recovery-e2e.sh"
	if [[ ${RIVET_LOCAL_SUPERNODE_LIVE_SCALE:-0} == 1 ]]; then
		run_gate supernode-fdb-scale-a "${MESH_DIR}/supernode-fdb-scale-e2e.sh" runtime-a
		run_gate supernode-fdb-scale-b "${MESH_DIR}/supernode-fdb-scale-e2e.sh" runtime-b
	fi
fi

run_gate final-federated-placement "${MESH_DIR}/verify-federated-placement.sh"
identity_after=$(capture_identity)
printf '%s\n' "${identity_after}" | jq . >"${evidence_dir}/identity-after.json"
if [[ ${identity_after} != "${identity_before}" ]]; then
	jq -cn --arg name stable-identity --arg status failed --argjson exitCode 1 \
		'{name: $name, status: $status, exitCode: $exitCode, durationSeconds: 0, log: "identity-before.json + identity-after.json"}' >>"${results_file}"
	capture_state "${evidence_dir}/failed-state.json" || true
	write_summary failed
	die "qualification changed durable mesh identity; evidence: ${evidence_dir}/summary.json"
fi
jq -cn --arg name stable-identity --arg status passed --argjson exitCode 0 \
	'{name: $name, status: $status, exitCode: $exitCode, durationSeconds: 0, log: "identity-before.json + identity-after.json"}' >>"${results_file}"

capture_state "${evidence_dir}/state-after.json"
write_summary passed
log "${mode} production qualification passed; evidence: ${evidence_dir}/summary.json"
