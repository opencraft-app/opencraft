#!/usr/bin/env bash
set -euo pipefail

STACK_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
LOCAL_DIR=$(cd -- "${STACK_DIR}/.." && pwd)
MESH_DIR=${LOCAL_DIR}/mesh
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=../mesh/storage-profile.sh
source "${MESH_DIR}/storage-profile.sh"

target=${1:-runtime-a}
case ${target} in
	runtime-a) targets=(runtime-a) ;;
	runtime-b) targets=(runtime-b) ;;
	all) targets=(runtime-a runtime-b) ;;
	*) die "usage: $0 [runtime-a|runtime-b|all]" ;;
esac

receipt_dir=${MESH_STATE_DIR}/local-workers/receipts
mkdir -p "${receipt_dir}"
chmod 0700 "${MESH_STATE_DIR}/local-workers" "${receipt_dir}"

for runtime in "${targets[@]}"; do
	case ${runtime} in
		runtime-a)
			kubeconfig=${RUNTIME_A_KUBECONFIG}; port_base=22420
			fdb_cluster=${RIVET_LOCAL_FDB_CLUSTER_A}; cold_bucket=${RIVET_LOCAL_COLD_BUCKET_A}
			;;
		runtime-b)
			kubeconfig=${RUNTIME_B_KUBECONFIG}; port_base=23420
			fdb_cluster=${RIVET_LOCAL_FDB_CLUSTER_B}; cold_bucket=${RIVET_LOCAL_COLD_BUCKET_B}
			;;
	esac
	receipt=${receipt_dir}/${runtime}-cold-recovery.json
	python3 "${MESH_DIR}/qualify-real-cos-outage.py" \
		--kubeconfig "${kubeconfig}" \
		--cell "local-${runtime}" \
		--output "${receipt}" \
		--engine-port "${port_base}" \
		--depot-port "$((port_base + 1))" \
		--metrics-port "$((port_base + 10))" \
		--fill-bytes 1048576 \
		--outage-seconds 3 \
		--recovery-timeout-seconds 300 \
		--storage-profile-id "${RIVET_LOCAL_STORAGE_PROFILE_ID}" \
		--expected-fdb-cluster "${fdb_cluster}" \
		--expected-cold-bucket "${cold_bucket}" \
		--expected-cold-endpoint "${RIVET_LOCAL_COLD_ENDPOINT}" \
		--expected-max-object-size-bytes "${RIVET_LOCAL_COLD_MAX_OBJECT_SIZE_BYTES}" \
		--expected-recovery-window-ms "${RIVET_LOCAL_COLD_RECOVERY_WINDOW_MS}" \
		--evidence-schema rivet-local-s3-cold-recovery/v1
	jq -e --arg profile "${RIVET_LOCAL_STORAGE_PROFILE_ID}" '
		.schema == "rivet-local-s3-cold-recovery/v1" and .verdict == "passed" and
		.storage_binding.profile_id == $profile and
		.recovery.bottomless_bytes == 1048576 and .recovery.bottomless_corrupt_chunks == 0
	' \
		"${receipt}" >/dev/null || die "${runtime} cold recovery receipt failed validation"
	log "${runtime} passed FDB ACK, cold publication, Engine restart, sleep, and cold-wake recovery"
done

routing_receipt=${receipt_dir}/stateless-durable-routing-$(date +%s).json
python3 "${MESH_DIR}/stateless-durable-routing-e2e/run.py" --receipt "${routing_receipt}"
jq -e '
	.schema == "stateless-durable-routing-e2e/v1" and .verdict == "passed" and
	.sameAndCrossCell == true and .sleepWake == true and
	(.placements | keys | sort) == ["runtime-a", "runtime-b"] and
	.statelessPodReplacement.oldUid != .statelessPodReplacement.newUid
' "${routing_receipt}" >/dev/null || die "stateless and Durable Object routing receipt failed validation"
log "stateless fetch, A/B placement, same/cross-Cell routing, sleep/wake, and Pod replacement passed"

termination_receipt=${receipt_dir}/stateless-termination-$(date +%s).json
python3 "${MESH_DIR}/stateless-termination-e2e/run.py" --receipt "${termination_receipt}"
jq -e '
	.schema == "stateless-termination-e2e/v1" and .verdict == "passed" and
	.graceful.readinessRemoved == true and
	.graceful.newWorkReachedPeer == true and
	.graceful.inFlightResponseCompleted == true and
	.forcedTimeout.drainTimeoutDelta >= 1 and
	.forcedTimeout.inFlightResponseInterrupted == true and
	.forcedTimeout.result == {"kind":"indeterminate_result","status":502}
' "${termination_receipt}" >/dev/null || die "stateless termination receipt failed validation"
log "stateless Pod readiness drain, peer continuity, graceful completion, and forced timeout passed"

capacity_receipt=${receipt_dir}/stateless-capacity-provider-$(date +%s).json
python3 "${MESH_DIR}/stateless-capacity-provider-e2e/run.py" --receipt "${capacity_receipt}"
jq -e '
	.schema == "stateless-capacity-provider-e2e/v1" and .verdict == "passed" and
	.load_requests == 60 and .hpa_target_in_flight_per_pod == 48 and
	.phases.scale_up.observed_in_flight == 60 and
	.phases.scale_up.hpa.desiredReplicas == 2 and
	.phases.scale_up.capacity_request.status.phase == "Ready" and
	([.phases.scale_up.capacity_request.status.history[].phase] | index("Pending") != null) and
	([.phases.scale_up.capacity_request.status.history[].phase] | index("Provisioning") != null) and
	.phases.scale_up.provider_restart.before.metadata.uid ==
		.phases.scale_up.provider_restart.after.metadata.uid and
	.phases.scale_down.hpa.desiredReplicas == 1 and
	.phases.scale_down.capacity_request.status.phase == "Deleted" and
	([.phases.scale_down.capacity_request.status.history[].phase] | index("Draining") != null) and
	([.phases.scale_down.capacity_request.status.history[].phase] | index("Deleting") != null) and
	.phases.scale_down.stateless_nodes == ["k3d-rivet-runtime-a-stateless-0"] and
	.provider_image_imports == 1 and .provider_reconcile_errors == 0
' "${capacity_receipt}" >/dev/null || die "stateless HPA/Node capacity receipt failed validation"
log "stateless in-flight HPA, Pending Pod, exact-image Node admission, drain, and scale-down passed"

router_capacity_receipt=${receipt_dir}/workers-api-autoscaling-$(date +%s).json
python3 "${MESH_DIR}/workers-api-autoscaling-e2e/run.py" --receipt "${router_capacity_receipt}"
jq -e '
	.schema == "actor-workers-api-autoscaling-e2e/v1" and .verdict == "passed" and
	.phases.baseline.hpa.currentReplicas == 3 and
	.phases.scaleUp.hpa.desiredReplicas == 4 and
	(.phases.scaleUp.pods | length) == 4 and
	.phases.scaleDown.hpa.desiredReplicas == 3 and
	(.phases.scaleDown.pods | length) == 3 and
	.phases.scaleDown.successfulRequests == .loadRequests
' "${router_capacity_receipt}" >/dev/null || die "Workers API Router autoscaling receipt failed validation"
log "central Router in-flight metric, custom metrics adapter, HPA 3->4->3, and request completion passed"

ha_receipt=${receipt_dir}/workers-api-ha-$(date +%s).json
python3 "${MESH_DIR}/workers-api-ha-e2e/run.py" --receipt "${ha_receipt}"
jq -e '
	.schema == "actor-first-placement/v1" and .verdict == "passed" and
	.api_replicas >= 3 and .replica_set_first_request_converged == true and
	.api_replacement_zero_failures == true and
	.registry_outage_cached_object_survived == true and
	.registry_outage_new_object_failed_closed == true and
	.registry_outage_recovery_converged == true and
	.stateless_dispatch_created_actor == false
' "${ha_receipt}" >/dev/null || die "Workers API/Registry HA receipt failed validation"
log "HPA-safe Workers API replica set, Registry total outage, cache hit/miss, and recovery passed"
