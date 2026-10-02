#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
controller_namespace=${RIVET_CONTROLLER_NAMESPACE:-fdb-operator-actor-fleet-controller-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell_name=$RIVET_CELL_NAME
runtime_profile=${RIVET_RUNTIME_PROFILE:-production}
availability_mode=${RIVET_AVAILABILITY_MODE:-production-multi-zone}
cell_reporter_mode=${RIVET_CELL_REPORTER_MODE:-enabled}
case "$availability_mode" in
production-multi-zone) required_topology_zones=3 ;;
qualification-single-zone) required_topology_zones=1 ;;
*)
	echo "RIVET_AVAILABILITY_MODE must be production-multi-zone or qualification-single-zone" >&2
	exit 2
	;;
esac
case "$cell_reporter_mode" in
enabled | disabled) ;;
*)
	echo "RIVET_CELL_REPORTER_MODE must be enabled or disabled" >&2
	exit 2
	;;
esac
case "$runtime_profile" in
production)
	ACTOR_IMAGE_LOCK_TOOL=$script_dir/../gitops/image-seed/image-lock.py
	# shellcheck source=../gitops/image-seed/bind-inventory.sh
	source "$script_dir/../gitops/image-seed/bind-inventory.sh"
	actor_image_inventory_require
	actor_image_inventory_bind_runtime_release \
		RIVET_RUNTIME_IMAGE RIVET_SOURCE_REVISION RIVET_SOURCE_MANIFEST_SHA256 rivet-runtime
	actor_image_inventory_bind RIVET_REPORTER_IMAGE actor-fleet-controller
	actor_image_inventory_bind RIVET_NATS_IMAGE nats
	actor_image_inventory_bind RIVET_WORKERD_METRICS_IMAGE observability-busybox
	actor_image_inventory_bind_build_identity \
		RIVET_REPORTER_SOURCE_REVISION RIVET_REPORTER_SOURCE_MANIFEST_SHA256 actor-fleet-controller
	default_write_debt_target=10485760
	default_write_debt_limit=12582912
	default_workerd_max_in_flight=16
	default_workerd_max_active_actors=32
	default_workerd_shards=16
	default_workerd_max_queued=64
	default_workerd_queue_timeout_ms=15000
	default_workerd_idle_sleep_ms=30000
	default_depot_reclaim_interval_ms=600000
	# Cloud qualification at 100 Agent/s showed that 4 allowed one Envoy's
	# serializable slot reservation key to exhaust all ten FDB retries. Sixteen
	# still bin-packs 32-slot Hosts while decorrelating the burst contenders.
	default_envoy_slot_jitter=16
	default_envoy_allocation_max_in_flight_per_pool=1
	;;
e2e-fast)
	default_write_debt_target=262144
	default_write_debt_limit=2359296
	default_workerd_max_in_flight=2
	default_workerd_max_active_actors=4
	default_workerd_shards=2
	default_workerd_max_queued=16
	default_workerd_queue_timeout_ms=5000
	default_workerd_idle_sleep_ms=5000
	default_depot_reclaim_interval_ms=5000
	default_envoy_slot_jitter=4
	default_envoy_allocation_max_in_flight_per_pool=4
	;;
*)
	echo "RIVET_RUNTIME_PROFILE must be production or e2e-fast" >&2
	exit 2
	;;
esac
runtime_image=${RIVET_RUNTIME_IMAGE:?RIVET_RUNTIME_IMAGE must be pinned by registry digest}
reporter_image=${RIVET_REPORTER_IMAGE:?RIVET_REPORTER_IMAGE must be pinned by registry digest}
reporter_source_revision=${RIVET_REPORTER_SOURCE_REVISION:-untracked}
reporter_source_manifest_sha=${RIVET_REPORTER_SOURCE_MANIFEST_SHA256:-untracked}
nats_image=${RIVET_NATS_IMAGE:?RIVET_NATS_IMAGE must be pinned by registry digest}
workerd_metrics_image=${RIVET_WORKERD_METRICS_IMAGE:?RIVET_WORKERD_METRICS_IMAGE must be pinned by registry digest}
if [[ $runtime_profile == production && $cell_reporter_mode == enabled ]]; then
	[[ $reporter_source_revision =~ ^[0-9a-f]{40}$ ]] || {
		echo "production Reporter source revision must be a full commit ID" >&2
		exit 2
	}
	[[ $reporter_source_manifest_sha =~ ^[0-9a-f]{64}$ ]] || {
		echo "production Reporter source manifest must be a sha256 digest" >&2
		exit 2
	}
fi
write_debt_target=${RIVET_FDB_WRITE_DEBT_TARGET_BYTES:-$default_write_debt_target}
write_debt_limit=${RIVET_FDB_WRITE_DEBT_LIMIT_BYTES:-$default_write_debt_limit}
workerd_max_in_flight=${RIVET_WORKERD_MAX_IN_FLIGHT:-$default_workerd_max_in_flight}
workerd_max_active_actors=${RIVET_WORKERD_MAX_ACTIVE_ACTORS:-$default_workerd_max_active_actors}
workerd_shards=${RIVET_WORKERD_SHARDS:-$default_workerd_shards}
workerd_max_queued=${RIVET_WORKERD_MAX_QUEUED:-$default_workerd_max_queued}
workerd_queue_timeout_ms=${RIVET_WORKERD_QUEUE_TIMEOUT_MS:-$default_workerd_queue_timeout_ms}
workerd_idle_sleep_ms=${RIVET_WORKERD_IDLE_SLEEP_MS:-$default_workerd_idle_sleep_ms}
worker_registry_url=${RIVET_WORKER_REGISTRY_URL:?RIVET_WORKER_REGISTRY_URL must point to the private Worker registry endpoint}
cold_bucket=${RIVET_COLD_BUCKET:?RIVET_COLD_BUCKET must be the exact Terraform Cell cold bucket}
cold_region=${RIVET_COLD_REGION:-${TENCENT_REGION:-ap-beijing}}
cold_endpoint=${RIVET_COLD_ENDPOINT:-https://cos.${cold_region}.myqcloud.com}
depot_reclaim_interval_ms=${RIVET_DEPOT_RECLAIM_INTERVAL_MS:-$default_depot_reclaim_interval_ms}
cold_max_concurrent_requests=${RIVET_COLD_MAX_CONCURRENT_REQUESTS:-16}
gasoline_worker_poll_interval_ms=${RIVET_GASOLINE_WORKER_POLL_INTERVAL_MS:-2000}
gasoline_worker_pull_batch_size=${RIVET_GASOLINE_WORKER_PULL_BATCH_SIZE:-256}
gasoline_worker_max_active_workflows=${RIVET_GASOLINE_WORKER_MAX_ACTIVE_WORKFLOWS:-4096}
depot_manager_refresh_max_concurrency=${RIVET_DEPOT_MANAGER_REFRESH_MAX_CONCURRENCY:-8}
depot_compaction_max_concurrency=${RIVET_DEPOT_COMPACTION_MAX_CONCURRENCY:-2}
gasoline_worker_secondary_grace_ms=${RIVET_GASOLINE_WORKER_SECONDARY_GRACE_MS:-1000}
gasoline_history_prune_eligibility_seconds=${RIVET_GASOLINE_HISTORY_PRUNE_ELIGIBILITY_SECONDS:-900}
gasoline_terminal_prune_eligibility_seconds=${RIVET_GASOLINE_TERMINAL_PRUNE_ELIGIBILITY_SECONDS:-604800}
gasoline_prune_interval_seconds=${RIVET_GASOLINE_PRUNE_INTERVAL_SECONDS:-60}
envoy_slot_jitter=${RIVET_ENVOY_SLOT_JITTER:-$default_envoy_slot_jitter}
envoy_allocation_max_in_flight_per_pool=${RIVET_ENVOY_ALLOCATION_MAX_IN_FLIGHT_PER_POOL:-$default_envoy_allocation_max_in_flight_per_pool}
if [[ ! $worker_registry_url =~ ^https?://[A-Za-z0-9._:/-]+$ ]]; then
	echo "RIVET_WORKER_REGISTRY_URL must be an HTTP(S) URL without query or fragment" >&2
	exit 2
fi
if [[ ! $cold_bucket =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]; then
	echo "RIVET_COLD_BUCKET must be an exact COS bucket name" >&2
	exit 2
fi
if [[ ! $cold_region =~ ^ap-[a-z]+(-[a-z]+)*$ ]]; then
	echo "RIVET_COLD_REGION must be a Tencent Cloud region" >&2
	exit 2
fi
if [[ $cold_endpoint != "https://cos.${cold_region}.myqcloud.com" ]]; then
	echo "RIVET_COLD_ENDPOINT must be the exact regional Tencent COS origin" >&2
	exit 2
fi
if [[ ! $cell_name =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]]; then
	echo "RIVET_CELL_NAME must be a DNS label" >&2
	exit 2
fi
default_runtime_repair_surge=0
default_runtime_admission_field_manager=rivet-runtime-admission-installer
if [[ $runtime_profile == production && $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ ]]; then
	default_runtime_repair_surge=1
fi
runtime_repair_surge=${RUNTIME_CAPACITY_MAX_REPAIR_SURGE:-$default_runtime_repair_surge}
runtime_admission_field_manager=${RUNTIME_ADMISSION_FIELD_MANAGER:-$default_runtime_admission_field_manager}
runtime_targeted_repair_explicit=false
if [[ ${RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED+x} ]]; then
	runtime_targeted_repair_explicit=true
fi
runtime_targeted_repair_enabled=${RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED:-false}
runtime_exact_scale_down_enabled=${RUNTIME_EXACT_SCALE_DOWN_ENABLED:-false}
runtime_tke_cluster_id=${RUNTIME_TKE_CLUSTER_ID:-disabled}
runtime_tke_oidc_role_arn=${RUNTIME_TKE_OIDC_ROLE_ARN:-disabled}
runtime_machine_repair_receipt=${RUNTIME_MACHINE_REPAIR_QUALIFICATION_RECEIPT:-}
runtime_machine_repair_canonical_dir=${RUNTIME_MACHINE_REPAIR_CANONICAL_RECEIPTS_DIR:-/data/actor-qualification/receipts}
[[ $runtime_repair_surge =~ ^[0-9]+$ ]] || {
	echo "RUNTIME_CAPACITY_MAX_REPAIR_SURGE must be a non-negative integer" >&2
	exit 2
}
case "$runtime_exact_scale_down_enabled" in
true | false) ;;
*)
	echo "RUNTIME_EXACT_SCALE_DOWN_ENABLED must be true or false" >&2
	exit 2
	;;
esac
[[ $runtime_tke_cluster_id == disabled || $runtime_tke_cluster_id =~ ^cls-[a-z0-9]+$ ]] || {
	echo "RUNTIME_TKE_CLUSTER_ID is invalid" >&2
	exit 2
}
runtime_rollout_timeout_seconds=${RIVET_RUNTIME_ROLLOUT_TIMEOUT_SECONDS:-2700}
runtime_restart_fail_threshold=${RIVET_RUNTIME_RESTART_FAIL_THRESHOLD:-3}
runtime_host_drain_timeout_seconds=${RIVET_RUNTIME_HOST_DRAIN_TIMEOUT_SECONDS:-300}
for value in "$write_debt_target" "$write_debt_limit" "$workerd_max_in_flight" "$workerd_max_active_actors" "$workerd_shards" "$workerd_max_queued" "$workerd_queue_timeout_ms" "$workerd_idle_sleep_ms" "$depot_reclaim_interval_ms" "$cold_max_concurrent_requests" "$gasoline_worker_poll_interval_ms" "$gasoline_worker_pull_batch_size" "$gasoline_worker_max_active_workflows" "$depot_manager_refresh_max_concurrency" "$depot_compaction_max_concurrency" "$gasoline_worker_secondary_grace_ms" "$gasoline_history_prune_eligibility_seconds" "$gasoline_terminal_prune_eligibility_seconds" "$gasoline_prune_interval_seconds" "$envoy_slot_jitter" "$envoy_allocation_max_in_flight_per_pool" "$runtime_rollout_timeout_seconds" "$runtime_restart_fail_threshold" "$runtime_host_drain_timeout_seconds"; do
	[[ $value =~ ^[0-9]+$ ]] || {
		echo "runtime tuning values must be decimal integers" >&2
		exit 2
	}
done
if ((write_debt_target < 65536 || write_debt_limit - write_debt_target < 2097152)); then
	echo "FDB write-debt policy requires target >= 65536 and at least 2097152 bytes of commit headroom" >&2
	exit 2
fi
if ((write_debt_limit > 1073741824)); then
	echo "FDB write-debt limit must not exceed 1073741824 bytes" >&2
	exit 2
fi
if ((workerd_max_in_flight < 1 || workerd_max_queued < 1 || workerd_queue_timeout_ms < 1)); then
	echo "workerd recovery-admission limits must be positive" >&2
	exit 2
fi
if ((workerd_max_active_actors < 1 || workerd_max_active_actors > 1000000)); then
	echo "RIVET_WORKERD_MAX_ACTIVE_ACTORS must be between 1 and 1000000" >&2
	exit 2
fi
if ((workerd_idle_sleep_ms > 86400000)); then
	echo "RIVET_WORKERD_IDLE_SLEEP_MS must be 0 or at most 86400000" >&2
	exit 2
fi
if ((workerd_shards < 1 || workerd_shards > 64)); then
	echo "RIVET_WORKERD_SHARDS must be between 1 and 64" >&2
	exit 2
fi
if ((cold_max_concurrent_requests < 1 || cold_max_concurrent_requests > 4096)); then
	echo "RIVET_COLD_MAX_CONCURRENT_REQUESTS must be between 1 and 4096" >&2
	exit 2
fi
if ((gasoline_worker_poll_interval_ms < 100 || gasoline_worker_poll_interval_ms > 60000)); then
	echo "RIVET_GASOLINE_WORKER_POLL_INTERVAL_MS must be between 100 and 60000" >&2
	exit 2
fi
if ((gasoline_worker_pull_batch_size < 1 || gasoline_worker_pull_batch_size > 1000)); then
	echo "RIVET_GASOLINE_WORKER_PULL_BATCH_SIZE must be between 1 and 1000" >&2
	exit 2
fi
if ((gasoline_worker_max_active_workflows < 1 || gasoline_worker_max_active_workflows > 10000)); then
	echo "RIVET_GASOLINE_WORKER_MAX_ACTIVE_WORKFLOWS must be between 1 and 10000" >&2
	exit 2
fi
if ((depot_manager_refresh_max_concurrency < 1 || depot_manager_refresh_max_concurrency > 4096)); then
	echo "RIVET_DEPOT_MANAGER_REFRESH_MAX_CONCURRENCY must be between 1 and 4096" >&2
	exit 2
fi
if ((depot_compaction_max_concurrency < 1 || depot_compaction_max_concurrency > 4096)); then
	echo "RIVET_DEPOT_COMPACTION_MAX_CONCURRENCY must be between 1 and 4096" >&2
	exit 2
fi
if ((gasoline_worker_secondary_grace_ms > 60000)); then
	echo "RIVET_GASOLINE_WORKER_SECONDARY_GRACE_MS must not exceed 60000" >&2
	exit 2
fi
if ((gasoline_prune_interval_seconds < 1 || gasoline_prune_interval_seconds > 86400)); then
	echo "RIVET_GASOLINE_PRUNE_INTERVAL_SECONDS must be between 1 and 86400" >&2
	exit 2
fi
if ((gasoline_history_prune_eligibility_seconds > 0 && gasoline_terminal_prune_eligibility_seconds > 0 && gasoline_history_prune_eligibility_seconds > gasoline_terminal_prune_eligibility_seconds)); then
	echo "Gasoline history retention must not exceed terminal retention" >&2
	exit 2
fi
if ((envoy_slot_jitter > 64)); then
	echo "RIVET_ENVOY_SLOT_JITTER must be between 0 and 64" >&2
	exit 2
fi
if ((envoy_allocation_max_in_flight_per_pool < 1 || envoy_allocation_max_in_flight_per_pool > 256)); then
	echo "RIVET_ENVOY_ALLOCATION_MAX_IN_FLIGHT_PER_POOL must be between 1 and 256" >&2
	exit 2
fi
if ((depot_reclaim_interval_ms < 1000 || depot_reclaim_interval_ms > 86400000)); then
	echo "RIVET_DEPOT_RECLAIM_INTERVAL_MS must be between 1000 and 86400000" >&2
	exit 2
fi
if ((runtime_rollout_timeout_seconds < 60 || runtime_rollout_timeout_seconds > 7200)); then
	echo "RIVET_RUNTIME_ROLLOUT_TIMEOUT_SECONDS must be between 60 and 7200" >&2
	exit 2
fi
if ((runtime_restart_fail_threshold < 1 || runtime_restart_fail_threshold > 100)); then
	echo "RIVET_RUNTIME_RESTART_FAIL_THRESHOLD must be between 1 and 100" >&2
	exit 2
fi
if ((runtime_host_drain_timeout_seconds < 30 || runtime_host_drain_timeout_seconds > 600)); then
	echo "RIVET_RUNTIME_HOST_DRAIN_TIMEOUT_SECONDS must be between 30 and 600" >&2
	exit 2
fi
kubeconfig_args=()
if [[ -n ${KUBECONFIG:-} ]]; then
	kubeconfig_args=(--kubeconfig "$KUBECONFIG")
fi

for image in "$runtime_image" "$reporter_image" "$nats_image" "$workerd_metrics_image"; do
	[[ $image =~ @sha256:[0-9a-f]{64}$ ]] || {
		echo "image must be pinned by registry-reported sha256 digest: $image" >&2
		exit 1
	}
done
runtime_digest=sha256:${runtime_image##*@sha256:}
nats_manifest_sha=$(python3 "$script_dir/manifest-identity.py" \
	--file "$script_dir/nats.yaml" \
	--value "$cell_name" \
	--value "$availability_mode")
runtime_manifest_sha=$(python3 "$script_dir/manifest-identity.py" \
	--file "$script_dir/runtime.yaml" \
	--file "$script_dir/admission-controller.yaml" \
	--value "$cell_name" \
	--value "$runtime_profile" \
	--value "$write_debt_target" \
	--value "$write_debt_limit" \
	--value "$workerd_max_in_flight" \
	--value "$workerd_max_active_actors" \
	--value "$workerd_shards" \
	--value "$workerd_max_queued" \
	--value "$workerd_queue_timeout_ms" \
	--value "$workerd_idle_sleep_ms" \
	--value "$depot_reclaim_interval_ms" \
	--value "$cold_bucket" \
	--value "$cold_endpoint" \
	--value "$cold_region" \
	--value "$cold_max_concurrent_requests" \
	--value "$gasoline_worker_poll_interval_ms" \
	--value "$gasoline_worker_pull_batch_size" \
	--value "$gasoline_worker_max_active_workflows" \
	--value "$depot_manager_refresh_max_concurrency" \
	--value "$depot_compaction_max_concurrency" \
	--value "$gasoline_worker_secondary_grace_ms" \
	--value "$gasoline_history_prune_eligibility_seconds" \
	--value "$gasoline_terminal_prune_eligibility_seconds" \
	--value "$gasoline_prune_interval_seconds" \
	--value "$envoy_slot_jitter" \
	--value "$envoy_allocation_max_in_flight_per_pool" \
	--value "$workerd_metrics_image" \
	--value "$cell_reporter_mode" \
	--value "$reporter_source_revision" \
	--value "$reporter_source_manifest_sha" \
	--value "$runtime_repair_surge" \
	--value "$runtime_exact_scale_down_enabled" \
	--value "$runtime_tke_cluster_id" \
	--value "$runtime_tke_oidc_role_arn" \
	--value "${RUNTIME_MACHINE_SET:-np-runtime0}" \
	--value "$availability_mode" \
	--value "$worker_registry_url")

temporary_root=${TMPDIR:-/data/tmp}
mkdir -p "$temporary_root"
temporary=$(mktemp -d "$temporary_root/runtime-install.XXXXXX")
cleanup() {
	rm -rf -- "$temporary"
}
trap cleanup EXIT

runtime_install_required_nodes=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
	"${cell_name}-runtime-hosts" -o jsonpath='{.spec.replicas}')
kubectl "${kubeconfig_args[@]}" get nodes \
	-l "fleet.actor.dev/cell-name=${cell_name},fleet.actor.dev/control-pool=true" \
	-o json >"$temporary/control-nodes.json"
python3 "$script_dir/validate-control-node-topology.py" \
	"$temporary/control-nodes.json" "$cell_name" "$availability_mode"

runtime_auth_valid=false
runtime_auth_changed=false
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret "${cell_name}-runtime-auth" \
	-o jsonpath='{.data.token}' 2>/dev/null | base64 --decode >"$temporary/existing-token"; then
	if [[ $(wc -c <"$temporary/existing-token") -eq 64 ]] && grep -Eq '^[0-9a-f]{64}$' "$temporary/existing-token"; then
		runtime_auth_valid=true
	fi
fi
if [[ $runtime_auth_valid != true ]]; then
	openssl rand -hex 32 | tr -d '\n' >"$temporary/token"
	chmod 0600 "$temporary/token"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" create secret generic "${cell_name}-runtime-auth" \
		--from-file="token=$temporary/token" --dry-run=client -o yaml | \
		kubectl "${kubeconfig_args[@]}" apply -f - >/dev/null
	runtime_auth_changed=true
fi
kubectl "${kubeconfig_args[@]}" -n "$namespace" label secret "${cell_name}-runtime-auth" \
	fleet.actor.dev/cell-name="$cell_name" --overwrite >/dev/null
if [[ $runtime_auth_valid == true ]]; then
	runtime_auth_file=$temporary/existing-token
else
	runtime_auth_file=$temporary/token
fi
runtime_auth_sha=$(sha256sum "$runtime_auth_file" | cut -d' ' -f1)
[[ $runtime_auth_sha =~ ^[0-9a-f]{64}$ ]] || {
	echo "failed to derive the runtime authentication revision" >&2
	exit 1
}

# A qualified production Cell keeps automatic replacement enabled across ordinary runtime releases only
# when the complete, identity-bound qualification pair is still valid. Explicit
# release inputs always win; absent or stale evidence defaults to disabled.
if [[ $runtime_targeted_repair_explicit == false \
	&& $runtime_profile == production \
	&& $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ ]]; then
	canonical_provider=$runtime_machine_repair_canonical_dir/${cell_name}-runtime-machine-repair-current.json
	canonical_automatic=$runtime_machine_repair_canonical_dir/${cell_name}-runtime-automatic-repair-current.json
	if [[ -f $canonical_provider && -f $canonical_automatic ]]; then
		current_cluster_uid=$(kubectl "${kubeconfig_args[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}')
		current_machine_set_uid=$(kubectl "${kubeconfig_args[@]}" get machineset.node.tke.cloud.tencent.com \
			"${RUNTIME_MACHINE_SET:-np-runtime0}" -o jsonpath='{.metadata.uid}')
		provider_sha=$(sha256sum "$canonical_provider" | cut -d' ' -f1)
		if "$script_dir/../qualification/actor-bj-q01/verify-runtime-machine-repair-receipt.py" \
				--expected-cell "$cell_name" --expected-machine-set "${RUNTIME_MACHINE_SET:-np-runtime0}" \
				--cluster-uid "$current_cluster_uid" --machine-set-uid "$current_machine_set_uid" \
				"$canonical_provider" && \
			"$script_dir/../qualification/actor-bj-q01/verify-runtime-automatic-repair-receipt.py" \
				--expected-cell "$cell_name" --expected-machine-set "${RUNTIME_MACHINE_SET:-np-runtime0}" \
				--cluster-uid "$current_cluster_uid" --machine-set-uid "$current_machine_set_uid" \
				--provider-receipt-sha256 "$provider_sha" "$canonical_automatic"; then
			runtime_targeted_repair_enabled=true
			runtime_machine_repair_receipt=$canonical_provider
			echo "runtime Machine repair: preserving qualified automatic replacement for $cell_name"
		else
			echo "runtime Machine repair: canonical qualification for $cell_name is stale or invalid; automatic replacement disabled" >&2
		fi
	else
		echo "runtime Machine repair: no complete canonical q01 qualification pair; automatic replacement disabled"
	fi
fi

# Default-deny runtime Nodes are admitted before a workload template requiring
# the admitted label is applied. This also bootstraps a new Cell where the
# runtime StatefulSet does not exist yet.
RIVET_CELL_NAMESPACE="$namespace" \
RIVET_CONTROLLER_NAMESPACE="$controller_namespace" \
RIVET_CELL_NAME="$cell_name" \
RUNTIME_MACHINE_SET="${RUNTIME_MACHINE_SET:-np-runtime0}" \
RUNTIME_CAPACITY_MAX_REPAIR_SURGE="$runtime_repair_surge" \
RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED="$runtime_targeted_repair_enabled" \
RUNTIME_EXACT_SCALE_DOWN_ENABLED="$runtime_exact_scale_down_enabled" \
RUNTIME_TKE_CLUSTER_ID="$runtime_tke_cluster_id" \
RUNTIME_TKE_OIDC_ROLE_ARN="$runtime_tke_oidc_role_arn" \
RUNTIME_MACHINE_REPAIR_QUALIFICATION_RECEIPT="$runtime_machine_repair_receipt" \
RUNTIME_ADMISSION_FIELD_MANAGER="$runtime_admission_field_manager" \
RIVET_REPORTER_IMAGE="$reporter_image" \
RIVET_RUNTIME_IMAGE="$runtime_image" \
	"$script_dir/install-admission-controller.sh"
if [[ $runtime_auth_changed == true ]]; then
	# secretKeyRef values do not roll a running controller Pod. Recreate it
	# before any qualified repair can authenticate to a runtime Host.
	kubectl "${kubeconfig_args[@]}" -n "$namespace" delete pod \
		-l "fleet.actor.dev/cell-name=${cell_name},fleet.actor.dev/component=runtime-capacity-controller" \
		--wait=false >/dev/null
	kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
		deployment/"${cell_name}-runtime-capacity" --timeout=5m
fi

kubectl "${kubeconfig_args[@]}" get nodes \
	-l "fleet.actor.dev/cell-name=${cell_name},rivet.dev/compute=true,node.tke.cloud.tencent.com/machineset=${RUNTIME_MACHINE_SET:-np-runtime0}" \
	-o json >"$temporary/runtime-nodes.json"
python3 - "$temporary/runtime-nodes.json" "$runtime_install_required_nodes" "$required_topology_zones" <<'PY'
import json
import sys

nodes = json.load(open(sys.argv[1]))["items"]
required = int(sys.argv[2])
required_zones = int(sys.argv[3])
if not nodes:
    raise SystemExit("runtime install requires at least one admitted compute Node")
admitted_by_zone = {}
for node in nodes:
    metadata = node["metadata"]
    conditions = {item["type"]: item["status"] for item in node.get("status", {}).get("conditions", [])}
    if conditions.get("Ready") != "True":
        raise SystemExit(f"runtime Node is not Ready: {metadata['name']}")
    if metadata.get("annotations", {}).get("fleet.actor.dev/runtime-capacity-drain"):
        raise SystemExit(f"runtime Node is draining: {metadata['name']}")
    taint_keys = {item.get("key") for item in node.get("spec", {}).get("taints", [])}
    admitted = metadata.get("labels", {}).get("fleet.actor.dev/runtime-admitted") == "true"
    if "fleet.actor.dev/runtime-capacity-drain" in taint_keys:
        raise SystemExit(f"runtime Node retains a scheduling fence: {metadata['name']}")
    if admitted:
        if "fleet.actor.dev/runtime-admission" in taint_keys:
            raise SystemExit(f"admitted runtime Node retains its admission fence: {metadata['name']}")
        zone = metadata.get("labels", {}).get("topology.kubernetes.io/zone")
        if not zone:
            raise SystemExit(f"admitted runtime Node has no topology zone: {metadata['name']}")
        admitted_by_zone[zone] = admitted_by_zone.get(zone, 0) + 1
    elif "fleet.actor.dev/runtime-admission" not in taint_keys:
        raise SystemExit(f"non-admitted runtime Node is not fail-closed: {metadata['name']}")
if len(admitted_by_zone) != required_zones:
    raise SystemExit(f"runtime admitted capacity spans {len(admitted_by_zone)} zones, want {required_zones}")
counts = list(admitted_by_zone.values())
if max(counts) - min(counts) > 1 or sum(counts) < required:
    raise SystemExit(f"runtime admitted capacity is insufficient or skewed: {admitted_by_zone}, required={required}")
PY

wait_for_runtime_hosts() {
	local deadline=$((SECONDS + runtime_rollout_timeout_seconds))
	local status
	while ((SECONDS < deadline)); do
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
			"${cell_name}-runtime-hosts" -o json >"$temporary/runtime-rollout-statefulset.json"
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
			-l "fleet.actor.dev/cell-name=${cell_name},fleet.actor.dev/component=workerd-host" \
			-o json >"$temporary/runtime-rollout-pods.json"
		set +e
		python3 - "$temporary/runtime-rollout-statefulset.json" \
			"$temporary/runtime-rollout-pods.json" "$runtime_restart_fail_threshold" <<'PY'
import json
import sys

statefulset = json.load(open(sys.argv[1]))
pods = json.load(open(sys.argv[2]))["items"]
restart_threshold = int(sys.argv[3])
spec_replicas = int(statefulset.get("spec", {}).get("replicas", 0))
status = statefulset.get("status", {})
ready = int(status.get("readyReplicas", 0))
updated = int(status.get("updatedReplicas", 0))
same_revision = (
    status.get("currentRevision") is not None
    and status.get("currentRevision") == status.get("updateRevision")
)
if ready == spec_replicas and updated == spec_replicas and same_revision:
    raise SystemExit(0)

fatal_waiting = {"CrashLoopBackOff", "ImagePullBackOff", "ErrImagePull", "CreateContainerError"}
failures = []
for pod in pods:
    pod_name = pod.get("metadata", {}).get("name", "unknown")
    for container in pod.get("status", {}).get("containerStatuses", []):
        waiting = container.get("state", {}).get("waiting", {}).get("reason")
        restarts = int(container.get("restartCount", 0))
        if waiting in fatal_waiting or (not container.get("ready", False) and restarts >= restart_threshold):
            failures.append(
                "{}/{} ready={} restarts={} waiting={}".format(
                    pod_name,
                    container.get("name", "unknown"),
                    container.get("ready", False),
                    restarts,
                    waiting,
                )
            )
if failures:
    print("runtime rollout entered a terminal container state: " + "; ".join(failures), file=sys.stderr)
    raise SystemExit(42)
raise SystemExit(1)
PY
		status=$?
		set -e
		if ((status == 0)); then
			echo "runtime StatefulSet converged before the failure deadline"
			return 0
		fi
		if ((status == 42)); then
			kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
				-l "fleet.actor.dev/cell-name=${cell_name},fleet.actor.dev/component=workerd-host" \
				-o wide >&2 || true
			return 1
		fi
		sleep 5
	done
	echo "runtime StatefulSet did not converge within ${runtime_rollout_timeout_seconds}s" >&2
	return 1
}

drain_runtime_host() {
	local pod=$1
	local expected_uid=$2
	local actual_uid
	actual_uid=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pod "$pod" -o jsonpath='{.metadata.uid}')
	[[ $actual_uid == "$expected_uid" ]] || {
		echo "runtime Host UID changed before drain: $pod expected=$expected_uid actual=$actual_uid" >&2
		return 1
	}
	kubectl "${kubeconfig_args[@]}" -n "$namespace" exec "$pod" -c workerd-host -- \
		env RIVET_RELEASE_DRAIN_TIMEOUT_SECONDS="$runtime_host_drain_timeout_seconds" \
		/bin/bash -ec '
			deadline=$((SECONDS + RIVET_RELEASE_DRAIN_TIMEOUT_SECONDS))
			drain_confirmed=false
			response=
			while ((SECONDS < deadline)); do
				response=$(curl --fail --silent --show-error --max-time 2 \
					--header "content-type: application/json" \
					--header "x-rivet-workerd-token: $RIVET_WORKERD_TOKEN" \
					--data '\''{"draining":true}'\'' \
					http://127.0.0.1:19083/v1/sqlite/drain 2>/dev/null || true)
				if grep -Eq '\''"metadata_sent":[[:space:]]*true'\'' <<<"$response" && \
				   grep -Eq '\''"host_draining":[[:space:]]*true'\'' <<<"$response" && \
				   grep -Eq '\''"host_accepting_actors":[[:space:]]*false'\'' <<<"$response"; then
					drain_confirmed=true
					break
				fi
				sleep 1
			done
			[[ $drain_confirmed == true ]] || { echo "failed to publish runtime Host drain fence" >&2; exit 1; }
			while ((SECONDS < deadline)); do
				response=$(curl --fail --silent --show-error --max-time 2 \
					--header "content-type: application/json" \
					--header "x-rivet-workerd-token: $RIVET_WORKERD_TOKEN" \
					--data '\''{"draining":true}'\'' \
					http://127.0.0.1:19083/v1/sqlite/drain 2>/dev/null || true)
				if grep -Eq '\''"quiescent":[[:space:]]*true'\'' <<<"$response" && \
				   grep -Eq '\''"host_active_actors":[[:space:]]*0'\'' <<<"$response" && \
				   grep -Eq '\''"bridge_active_actors":[[:space:]]*0'\'' <<<"$response" && \
				   grep -Eq '\''"in_flight":[[:space:]]*0'\'' <<<"$response" && \
				   grep -Eq '\''"queued":[[:space:]]*0'\'' <<<"$response"; then
					exit 0
				fi
				sleep 1
			done
			echo "runtime Host did not become exactly quiescent" >&2
			printf "last bounded drain response: %.2048s\n" "$response" >&2
			exit 1
		'
	actual_uid=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pod "$pod" -o jsonpath='{.metadata.uid}')
	[[ $actual_uid == "$expected_uid" ]] || {
		echo "runtime Host UID changed after drain: $pod expected=$expected_uid actual=$actual_uid" >&2
		return 1
	}
}

delete_runtime_host_uid() {
	local pod=$1
	local uid=$2
	python3 - "$uid" "$temporary/runtime-host-delete-options.json" <<'PY'
import json, sys
json.dump({
    "apiVersion": "v1",
    "kind": "DeleteOptions",
    "gracePeriodSeconds": None,
    "propagationPolicy": "Background",
    "preconditions": {"uid": sys.argv[1]},
}, open(sys.argv[2], "w"))
PY
	kubectl "${kubeconfig_args[@]}" delete \
		--raw "/api/v1/namespaces/${namespace}/pods/${pod}" \
		-f "$temporary/runtime-host-delete-options.json" >/dev/null
}

wait_for_replacement_host() {
	local pod=$1
	local old_uid=$2
	local wanted_revision=$3
	local deadline=$((SECONDS + runtime_rollout_timeout_seconds))
	while ((SECONDS < deadline)); do
		if kubectl "${kubeconfig_args[@]}" -n "$namespace" get pod "$pod" \
			-o json >"$temporary/runtime-replacement-pod.json" 2>/dev/null; then
			set +e
			python3 - "$temporary/runtime-replacement-pod.json" "$old_uid" "$wanted_revision" <<'PY'
import json, sys
pod = json.load(open(sys.argv[1]))
metadata = pod.get("metadata", {})
if metadata.get("uid") == sys.argv[2] or metadata.get("deletionTimestamp"):
    raise SystemExit(1)
if metadata.get("labels", {}).get("controller-revision-hash") != sys.argv[3]:
    raise SystemExit(1)
conditions = {item.get("type"): item.get("status") for item in pod.get("status", {}).get("conditions", [])}
if conditions.get("Ready") != "True":
    raise SystemExit(1)
statuses = pod.get("status", {}).get("containerStatuses", [])
if not statuses or not all(item.get("ready") for item in statuses):
    raise SystemExit(1)
raise SystemExit(0)
PY
			status=$?
			set -e
			if ((status == 0)); then
				echo "runtime Host replacement Ready: $pod revision=$wanted_revision"
				return 0
			fi
		fi
		sleep 2
	done
	echo "runtime Host replacement did not become Ready: $pod" >&2
	return 1
}

roll_runtime_hosts_serially() {
	local deadline=$((SECONDS + runtime_rollout_timeout_seconds))
	local selection state pod uid wanted_revision
	while ((SECONDS < deadline)); do
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
			"${cell_name}-runtime-hosts" -o json >"$temporary/runtime-serial-statefulset.json"
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
			-l "fleet.actor.dev/cell-name=${cell_name},fleet.actor.dev/component=workerd-host" \
			-o json >"$temporary/runtime-serial-pods.json"
		selection=$(python3 - "$temporary/runtime-serial-statefulset.json" \
			"$temporary/runtime-serial-pods.json" <<'PY'
import json, re, sys
statefulset = json.load(open(sys.argv[1]))
pods = json.load(open(sys.argv[2]))["items"]
metadata = statefulset["metadata"]
spec = statefulset["spec"]
status = statefulset.get("status", {})
if spec.get("updateStrategy") != {"type": "OnDelete"}:
    raise SystemExit("runtime serial rollout lost the OnDelete fence")
# The release-field handoff and the complete installer manifest are two
# deliberate API mutations. The StatefulSet controller may briefly expose the
# first mutation's updateRevision while metadata.generation already names the
# final template. Never drain a Host against that stale intermediate revision.
if status.get("observedGeneration") != metadata.get("generation"):
    print("WAIT")
    raise SystemExit(0)
wanted = status.get("updateRevision")
if not wanted:
    raise SystemExit("runtime StatefulSet has no update revision")
replicas = int(spec.get("replicas", 0))
owned = []
for pod in pods:
    name = pod.get("metadata", {}).get("name", "")
    match = re.fullmatch(re.escape(metadata["name"]) + r"-(\d+)", name)
    owners = pod.get("metadata", {}).get("ownerReferences", [])
    if not match or not any(owner.get("uid") == metadata["uid"] and owner.get("controller") for owner in owners):
        raise SystemExit("runtime selector contains a foreign Pod: " + name)
    owned.append((int(match.group(1)), pod))
if any(pod.get("metadata", {}).get("deletionTimestamp") for _, pod in owned):
    print("WAIT")
    raise SystemExit(0)
# Scale-out and a static release may overlap.  Never choose a stale Pod for
# drain while another desired ordinal is still Pending or not Ready: kubectl
# exec on an unassigned Pod is a hard error, and replacing Ready Pods before
# the pre-existing capacity has converged needlessly reduces availability.
conditions = lambda pod: {
    item.get("type"): item.get("status")
    for item in pod.get("status", {}).get("conditions", [])
}
if len(owned) != replicas or any(
    not pod.get("spec", {}).get("nodeName") or
    conditions(pod).get("Ready") != "True" or
    not pod.get("status", {}).get("containerStatuses") or
    not all(item.get("ready") for item in pod["status"]["containerStatuses"])
    for _, pod in owned
):
    print("WAIT")
    raise SystemExit(0)
stale = [
    (ordinal, pod) for ordinal, pod in owned
    if pod.get("metadata", {}).get("labels", {}).get("controller-revision-hash") != wanted
]
if stale:
    ordinal, pod = max(stale, key=lambda item: item[0])
    print("STALE\t{}\t{}\t{}".format(pod["metadata"]["name"], pod["metadata"]["uid"], wanted))
else:
    print("DONE")
PY
)
		IFS=$'\t' read -r state pod uid wanted_revision <<<"$selection"
		case "$state" in
		DONE)
			echo "runtime serial rollout replaced every Host"
			return 0
			;;
		WAIT)
			sleep 2
			;;
		STALE)
			drain_runtime_host "$pod" "$uid"
			delete_runtime_host_uid "$pod" "$uid"
			wait_for_replacement_host "$pod" "$uid" "$wanted_revision"
			;;
		*)
			echo "invalid runtime serial rollout selection: $selection" >&2
			return 1
			;;
		esac
	done
	echo "runtime serial rollout exceeded ${runtime_rollout_timeout_seconds}s" >&2
	return 1
}

wait_for_nats_mesh() {
	kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
		statefulset/"${cell_name}-nats" --timeout=10m
	local nats_cluster_ready=false
	for _ in $(seq 1 120); do
		nats_cluster_ready=true
		for ordinal in 0 1 2; do
			if ! kubectl "${kubeconfig_args[@]}" -n "$namespace" exec \
				"${cell_name}-nats-$ordinal" -- \
				wget -qO- http://127.0.0.1:8222/routez | \
				python3 -c 'import json,sys; assert json.load(sys.stdin).get("num_routes", 0) >= 2'; then
				nats_cluster_ready=false
				break
			fi
		done
		[[ $nats_cluster_ready == true ]] && break
		sleep 2
	done
	if [[ $nats_cluster_ready != true ]]; then
		echo "NATS did not form a three-member route mesh" >&2
		return 1
	fi
}

wait_for_engine_nats_clients() {
	local expected ordinal connected=false
	expected=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment \
		"${cell_name}-engine" -o jsonpath='{.spec.replicas}')
	[[ $expected =~ ^[1-9][0-9]*$ ]] || {
		echo "Engine replica count is invalid: $expected" >&2
		return 1
	}
	for _ in $(seq 1 120); do
		connected=true
		if ! kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
			-l "fleet.actor.dev/cell-name=${cell_name},fleet.actor.dev/component=engine" \
			-o json >"$temporary/engine-nats-pods.json"; then
			connected=false
		fi
		for ordinal in 0 1 2; do
			if ! kubectl "${kubeconfig_args[@]}" -n "$namespace" exec \
				"${cell_name}-nats-$ordinal" -- \
				wget -qO- 'http://127.0.0.1:8222/connz?subs=0' \
				>"$temporary/engine-nats-server-${ordinal}.json"; then
				connected=false
				break
			fi
		done
		if [[ $connected == true ]] && python3 "$script_dir/verify-engine-nats-clients.py" \
			"$expected" "$cell_name" "$temporary/engine-nats-pods.json" \
			"$temporary/engine-nats-server-0.json" "$temporary/engine-nats-server-1.json" \
			"$temporary/engine-nats-server-2.json" 2>"$temporary/engine-nats-error.txt"; then
			echo "Engine NATS clients ready: exact_ready_pods=$expected expected=$expected"
			return 0
		fi
		sleep 2
	done
	[[ ! -f $temporary/engine-nats-error.txt ]] || cat "$temporary/engine-nats-error.txt" >&2
	echo "Engine did not establish a NATS connection for every exact Ready Pod: expected=$expected" >&2
	return 1
}

# Reuse the existing long-lived pull credential without materializing its
# contents outside the API-to-API pipe. The reporter/runtime namespace remains
# independently scoped even though both repositories are in the same TCR.
kubectl "${kubeconfig_args[@]}" -n "$controller_namespace" \
	get secret actor-fleet-tcr -o json | \
	python3 -c 'import json,sys; d=json.load(sys.stdin); m=d["metadata"]; m["name"]="actor-fleet-tcr"; m["namespace"]=sys.argv[1]; [m.pop(k,None) for k in ("uid","resourceVersion","creationTimestamp","managedFields")]; print(json.dumps(d))' "$namespace" | \
	kubectl "${kubeconfig_args[@]}" apply -f - >/dev/null

# Storage bootstrap owns this immutable, least-privilege Secret. Runtime
# releases may consume it but never derive or rotate it from FDB backup keys.
kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret "${cell_name}-runtime-cos" \
	-o json >"$temporary/runtime-cos-secret.json"
jq -e --arg cell "$cell_name" --arg bucket "$cold_bucket" '
  .immutable == true and
  .metadata.labels["fleet.actor.dev/cell-name"] == $cell and
  .metadata.labels["fleet.actor.dev/credential-scope"] == "cell-cold" and
  .metadata.labels["fleet.actor.dev/storage-bucket"] == $bucket and
  (.data.AWS_ACCESS_KEY_ID | type == "string" and length > 0) and
  (.data.AWS_SECRET_ACCESS_KEY | type == "string" and length > 0)
' "$temporary/runtime-cos-secret.json" >/dev/null || {
	echo "runtime COS Secret is not the exact immutable Cell cold-storage identity" >&2
	exit 1
}

sed \
	-e "s|actor-bj-k01|$cell_name|g" \
	-e "s|__RIVET_NATS_IMAGE__|$nats_image|g" \
	-e "s|__RIVET_MANIFEST_SHA256__|$nats_manifest_sha|g" \
	"$script_dir/nats.yaml" >"$temporary/nats.yaml"
if [[ $availability_mode == qualification-single-zone ]]; then
	python3 "$script_dir/adapt-single-zone-topology.py" \
		--input "$temporary/nats.yaml" --output "$temporary/nats.yaml"
fi
python3 "$script_dir/partition-nats-manifest.py" \
	--manifest "$temporary/nats.yaml" --output "$temporary" --cell "$cell_name"

# A fresh Cell needs NATS before Engine can establish its first connection. An
# update has the opposite compatibility requirement: converge the new Engine
# client before any NATS Pod enters lame-duck. Applying only the non-workload
# resources here is safe; NATS does not reload a mounted ConfigMap without an
# explicit signal or Pod replacement.
engine_exists=false
runtime_exists=false
nats_exists=false
resume_initial_nats=false
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-engine" >/dev/null 2>&1; then
	engine_exists=true
fi
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-runtime-hosts" >/dev/null 2>&1; then
	runtime_exists=true
fi
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-nats" >/dev/null 2>&1; then
	nats_exists=true
fi
if [[ $engine_exists == true && $runtime_exists == true && $nats_exists == true ]]; then
	update_release_fields=true
elif [[ $engine_exists == false && $runtime_exists == false && $nats_exists == false ]]; then
	update_release_fields=false
elif [[ $engine_exists == false && $runtime_exists == false && $nats_exists == true ]] && \
	! kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap "${cell_name}-release-ledger" >/dev/null 2>&1; then
	# The first install deliberately creates and verifies NATS before Engine or
	# Host. A timeout or operator restart in that wait leaves this exact prefix.
	# Reapplying the intended NATS objects is safe only while no immutable
	# release ledger exists; a mature Cell missing Engine/Host still fails shut.
	echo "resuming interrupted initial runtime install from the NATS-only prefix"
	update_release_fields=false
	resume_initial_nats=true
elif [[ $engine_exists == true && $runtime_exists == false && $nats_exists == true ]] && \
	! kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap "${cell_name}-release-ledger" >/dev/null 2>&1; then
	# The next initial-install boundary is Engine -> NATS client convergence,
	# before any Host exists. Resume only a still-Provisioning exact Cell and
	# its canonical immutable workloads. Never delete NATS with Engine alive.
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get rivetcell "$cell_name" -o json >"$temporary/bootstrap-cell.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-engine" -o json >"$temporary/bootstrap-engine.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-nats" -o json >"$temporary/bootstrap-nats.json"
	python3 "$script_dir/verify-bootstrap-engine-prefix.py" "$cell_name" "$runtime_image" "$nats_image" \
		"$temporary/bootstrap-cell.json" "$temporary/bootstrap-engine.json" "$temporary/bootstrap-nats.json"
	echo "resuming interrupted initial runtime install from the Engine/NATS-only prefix"
	update_release_fields=false
else
	echo "runtime install found a partial Engine/runtime-hosts/NATS topology; refusing an unsafe dependency migration" >&2
	exit 1
fi
kubectl "${kubeconfig_args[@]}" apply --server-side --field-manager=rivet-runtime-installer \
	-f "$temporary/nats-base.yaml"
if [[ $update_release_fields == false ]]; then
	kubectl "${kubeconfig_args[@]}" apply --server-side --field-manager=rivet-runtime-installer \
		-f "$temporary/nats-statefulset.yaml"
	if [[ $resume_initial_nats == true ]]; then
		# A hard-topology correction can deadlock StatefulSet rolling update:
		# an old Pod's required anti-affinity prevents the highest ordinal's new
		# revision from scheduling, so the old Pod is never replaced. This is
		# safe only in the already-proven initial prefix with no ledger, Engine,
		# or Host. NATS carries no durable Actor state.
		! kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap \
			"${cell_name}-release-ledger" >/dev/null 2>&1
		! kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment \
			"${cell_name}-engine" >/dev/null 2>&1
		! kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
			"${cell_name}-runtime-hosts" >/dev/null 2>&1
		kubectl "${kubeconfig_args[@]}" -n "$namespace" delete pod \
			-l "fleet.actor.dev/cell-name=${cell_name},fleet.actor.dev/component=nats" \
			--wait=true --timeout=2m
	fi
	wait_for_nats_mesh
fi

sed \
	-e "s|actor-bj-k01|$cell_name|g" \
	-e "s|__RIVET_RUNTIME_IMAGE__|$runtime_image|g" \
	-e "s|__RIVET_WORKERD_METRICS_IMAGE__|$workerd_metrics_image|g" \
	-e "s|__RIVET_COLD_BUCKET__|$cold_bucket|g" \
	-e "s|__RIVET_COLD_ENDPOINT__|$cold_endpoint|g" \
	-e "s|__RIVET_COLD_REGION__|$cold_region|g" \
	-e "s|__RIVET_REPORTER_IMAGE__|$reporter_image|g" \
	-e "s|__RIVET_REPORTER_SOURCE_REVISION__|$reporter_source_revision|g" \
	-e "s|__RIVET_REPORTER_SOURCE_MANIFEST_SHA256__|$reporter_source_manifest_sha|g" \
	-e "s|__RIVET_RUNTIME_DIGEST__|$runtime_digest|g" \
	-e "s|__RIVET_RUNTIME_AUTH_SHA256__|$runtime_auth_sha|g" \
	-e "s|__RIVET_MANIFEST_SHA256__|$runtime_manifest_sha|g" \
	-e "s|__RIVET_RUNTIME_MACHINE_SET__|${RUNTIME_MACHINE_SET:-np-runtime0}|g" \
	-e "s|__RIVET_RUNTIME_PROFILE__|$runtime_profile|g" \
	-e "s|__RIVET_FDB_WRITE_DEBT_TARGET_BYTES__|$write_debt_target|g" \
	-e "s|__RIVET_FDB_WRITE_DEBT_LIMIT_BYTES__|$write_debt_limit|g" \
	-e "s|__RIVET_COLD_MAX_CONCURRENT_REQUESTS__|$cold_max_concurrent_requests|g" \
	-e "s|__RIVET_GASOLINE_WORKER_POLL_INTERVAL_MS__|$gasoline_worker_poll_interval_ms|g" \
	-e "s|__RIVET_GASOLINE_WORKER_PULL_BATCH_SIZE__|$gasoline_worker_pull_batch_size|g" \
	-e "s|__RIVET_GASOLINE_WORKER_MAX_ACTIVE_WORKFLOWS__|$gasoline_worker_max_active_workflows|g" \
	-e "s|__RIVET_DEPOT_MANAGER_REFRESH_MAX_CONCURRENCY__|$depot_manager_refresh_max_concurrency|g" \
	-e "s|__RIVET_DEPOT_COMPACTION_MAX_CONCURRENCY__|$depot_compaction_max_concurrency|g" \
	-e "s|__RIVET_GASOLINE_WORKER_SECONDARY_GRACE_MS__|$gasoline_worker_secondary_grace_ms|g" \
	-e "s|__RIVET_GASOLINE_HISTORY_PRUNE_ELIGIBILITY_SECONDS__|$gasoline_history_prune_eligibility_seconds|g" \
	-e "s|__RIVET_GASOLINE_TERMINAL_PRUNE_ELIGIBILITY_SECONDS__|$gasoline_terminal_prune_eligibility_seconds|g" \
	-e "s|__RIVET_GASOLINE_PRUNE_INTERVAL_SECONDS__|$gasoline_prune_interval_seconds|g" \
	-e "s|__RIVET_ENVOY_SLOT_JITTER__|$envoy_slot_jitter|g" \
	-e "s|__RIVET_ENVOY_ALLOCATION_MAX_IN_FLIGHT_PER_POOL__|$envoy_allocation_max_in_flight_per_pool|g" \
	-e "s|__RIVET_WORKERD_MAX_IN_FLIGHT__|$workerd_max_in_flight|g" \
	-e "s|__RIVET_WORKERD_MAX_ACTIVE_ACTORS__|$workerd_max_active_actors|g" \
	-e "s|__RIVET_WORKERD_SHARDS__|$workerd_shards|g" \
	-e "s|__RIVET_WORKERD_MAX_QUEUED__|$workerd_max_queued|g" \
	-e "s|__RIVET_WORKERD_QUEUE_TIMEOUT_MS__|$workerd_queue_timeout_ms|g" \
	-e "s|__RIVET_WORKERD_IDLE_SLEEP_MS__|$workerd_idle_sleep_ms|g" \
	-e "s|__RIVET_WORKER_REGISTRY_URL__|$worker_registry_url|g" \
	-e "s|__RIVET_DEPOT_RECLAIM_INTERVAL_MS__|$depot_reclaim_interval_ms|g" \
	"$script_dir/runtime.yaml" >"$temporary/runtime.yaml"
if [[ $cell_reporter_mode == disabled ]]; then
	python3 - "$temporary/runtime.yaml" "${cell_name}-cell-reporter" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
resource_name = sys.argv[2]
documents = path.read_text().split("\n---\n")
kept = [
    document for document in documents
    if f"\n  name: {resource_name}\n" not in f"\n{document}\n"
]
if len(documents) - len(kept) != 7:
    raise SystemExit("expected to remove exactly seven Cell reporter resources")
path.write_text("\n---\n".join(kept))
PY
fi
# Older installations used kubectl replace for the runtime ConfigMap, so its
# data field can still be owned by the legacy "kubectl-replace" manager. Move
# only this one declarative object to the installer before applying the whole
# runtime manifest. Do not force ownership of workloads or any other object.
python3 - "$temporary/runtime.yaml" "$temporary/runtime-config.yaml" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text()
document, separator, _ = source.partition("\n---\n")
if not separator or "\nkind: ConfigMap\n" not in f"\n{document}\n":
    raise SystemExit("runtime manifest must begin with the runtime ConfigMap")
Path(sys.argv[2]).write_text(document + "\n")
PY
if [[ $runtime_exists == true ]]; then
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap \
		"${cell_name}-runtime-config" -o json >"$temporary/runtime-config-before.json"
fi
kubectl create --dry-run=client -f "$temporary/runtime-config.yaml" -o json \
	>"$temporary/runtime-config-desired.json"
if [[ ${RUNTIME_STATIC_RELEASE_TRANSACTION:-0} != 1 ]] && \
	! kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap "${cell_name}-release-ledger" >/dev/null 2>&1; then
	# Bootstrap must exercise the same resolved-config compatibility gate as a
	# mature release, before starting an Engine or changing its configuration.
	sed -n '/^  config.jsonc: |$/,/^---$/p' "$temporary/runtime.yaml" | \
		sed '1d;$d;s/^    //' >"$temporary/bootstrap-config.jsonc"
	RIVET_RUNTIME_CONFIG_FILE="$temporary/bootstrap-config.jsonc" \
		"$script_dir/validate-runtime-image.sh"
fi
kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
	--field-manager=rivet-runtime-installer -f "$temporary/runtime-config.yaml"
# Transaction rollback uses an update patch and older releases used the
# default kubectl-patch manager. Reclaim only release-controlled images,
# manifest hashes, and the workerd process-pool command before the full
# conflict-detecting apply. Read args from the rendered manifest itself so
# shell/YAML newline semantics cannot drift between two copies.
python3 - "$temporary/runtime.yaml" "$temporary" "$cell_name" "$cell_reporter_mode" <<'PY'
import sys
from pathlib import Path

source = Path(sys.argv[1]).read_text()
destination = Path(sys.argv[2])
cell = sys.argv[3]
reporter_mode = sys.argv[4]
found = set()
for document in source.split("\n---\n"):
    if "\nkind: Deployment\n" in f"\n{document}\n" and f"\n  name: {cell}-engine\n" in f"\n{document}\n":
        (destination / "desired-engine.yaml").write_text(document + "\n")
        found.add("engine")
    if "\nkind: StatefulSet\n" in f"\n{document}\n" and f"\n  name: {cell}-runtime-hosts\n" in f"\n{document}\n":
        (destination / "desired-runtime.yaml").write_text(document + "\n")
        found.add("runtime")
    if "\nkind: Deployment\n" in f"\n{document}\n" and f"\n  name: {cell}-cell-reporter\n" in f"\n{document}\n":
        (destination / "desired-reporter.yaml").write_text(document + "\n")
        found.add("reporter")
expected = {"engine", "runtime"}
if reporter_mode == "enabled":
    expected.add("reporter")
if found != expected:
    raise SystemExit(f"failed to extract rendered release workloads: {sorted(found)}")
PY
if [[ $runtime_exists == true ]]; then
	# Manifest identity is a release-level fence shared by Engine and Host.
	# Probe both workloads before preserving either identity: preserving just
	# one side when the other changed creates a mixed release that cannot pass
	# qualification.  Only a fully no-op pair already bound to the same old
	# identity may retain that identity; every other pair takes the newly
	# rendered common identity and rolls through the normal release protocol.
	for component in engine runtime; do
		case "$component" in
		engine) kind=Deployment; resource="${cell_name}-engine" ;;
		runtime) kind=StatefulSet; resource="${cell_name}-runtime-hosts" ;;
		esac
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get "$kind" "$resource" \
			-o json >"$temporary/live-${component}.json"
		# Probe the complete desired workload, including the release-owned image
		# and command fields that the ordinary installer document intentionally
		# omits. The dry run applies API defaulting without changing ownership.
		kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
			--dry-run=server --field-manager=rivet-runtime-noop-probe \
			-f "$temporary/desired-${component}.yaml" -o json \
			>"$temporary/candidate-${component}.json"
		extra=()
		if [[ $component == engine ]]; then
			extra=(--related-live "$temporary/runtime-config-before.json" \
				--related-candidate "$temporary/runtime-config-desired.json")
		fi
		if [[ ${RIVET_EXPECT_NOOP_WORKLOADS:-0} == 1 ]]; then
			extra+=(--require-noop)
		fi
		python3 "$script_dir/preserve-noop-template-identity.py" \
			--live "$temporary/live-${component}.json" \
			--candidate "$temporary/candidate-${component}.json" \
			--manifest "$temporary/runtime.yaml" \
			--manifest "$temporary/desired-${component}.yaml" \
			--kind "$kind" --name "$resource" --probe-only "${extra[@]}" \
			>"$temporary/noop-${component}.json"
	done
	identity_coordination=$(python3 "$script_dir/coordinate-noop-release-identity.py" \
		--engine "$temporary/noop-engine.json" \
		--runtime "$temporary/noop-runtime.json")
	engine_noop=$(jq -r '.engine_noop' <<<"$identity_coordination")
	runtime_noop=$(jq -r '.runtime_noop' <<<"$identity_coordination")
	preserve_release_identity=$(jq -r '.preserve' <<<"$identity_coordination")
	if [[ $preserve_release_identity == true ]]; then
		for component in engine runtime; do
			case "$component" in
			engine)
				kind=Deployment
				resource="${cell_name}-engine"
				extra=(--related-live "$temporary/runtime-config-before.json" \
					--related-candidate "$temporary/runtime-config-desired.json")
				;;
			runtime)
				kind=StatefulSet
				resource="${cell_name}-runtime-hosts"
				extra=()
				;;
			esac
			python3 "$script_dir/preserve-noop-template-identity.py" \
				--live "$temporary/live-${component}.json" \
				--candidate "$temporary/candidate-${component}.json" \
				--manifest "$temporary/runtime.yaml" \
				--manifest "$temporary/desired-${component}.yaml" \
				--kind "$kind" --name "$resource" "${extra[@]}"
		done
	else
		echo "preserved=false coordinated_release_identity=true engine_noop=$engine_noop runtime_noop=$runtime_noop"
	fi
fi
kubectl create --dry-run=client -f "$temporary/desired-engine.yaml" -o json >"$temporary/desired-engine.json"
kubectl create --dry-run=client -f "$temporary/desired-runtime.yaml" -o json >"$temporary/desired-runtime.json"
kubectl create --dry-run=client -f "$temporary/nats-statefulset.yaml" -o json >"$temporary/desired-nats.json"
if [[ $cell_reporter_mode == enabled ]]; then
	kubectl create --dry-run=client -f "$temporary/desired-reporter.yaml" -o json >"$temporary/desired-reporter.json"
fi
python3 - "$temporary" "$namespace" <<'PY'
import json, sys
from pathlib import Path

root = Path(sys.argv[1])
namespace = sys.argv[2]
engine = json.load(open(root / "desired-engine.json"))
runtime = json.load(open(root / "desired-runtime.json"))
nats = json.load(open(root / "desired-nats.json"))
engine_container = next(item for item in engine["spec"]["template"]["spec"]["containers"] if item["name"] == "engine")
runtime_init = next(item for item in runtime["spec"]["template"]["spec"]["initContainers"] if item["name"] == "prepare-workerd-config")
workerd = next(item for item in runtime["spec"]["template"]["spec"]["containers"] if item["name"] == "workerd")
workerd_host = next(item for item in runtime["spec"]["template"]["spec"]["containers"] if item["name"] == "workerd-host")
workerd_metrics = next(item for item in runtime["spec"]["template"]["spec"]["containers"] if item["name"] == "workerd-metrics")
nats_container = next(item for item in nats["spec"]["template"]["spec"]["containers"] if item["name"] == "nats")
items = [
    {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": engine["metadata"]["name"], "namespace": namespace},
        "spec": {"selector": engine["spec"]["selector"], "template": {
            "metadata": {"annotations": {"fleet.actor.dev/manifest-sha256": engine["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/manifest-sha256"]}},
            "spec": {"containers": [{"name": "engine", "image": engine_container["image"]}]},
        }},
    },
    {
        "apiVersion": "apps/v1",
        "kind": "StatefulSet",
        "metadata": {"name": runtime["metadata"]["name"], "namespace": namespace},
        "spec": {
            "serviceName": runtime["spec"]["serviceName"],
            "selector": runtime["spec"]["selector"],
            "template": {
            "metadata": {"annotations": {"fleet.actor.dev/manifest-sha256": runtime["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/manifest-sha256"]}},
            "spec": {
                "initContainers": [{"name": "prepare-workerd-config", "image": runtime_init["image"]}],
                "containers": [
                    {"name": "workerd", "image": workerd["image"], "args": workerd["args"]},
                    {"name": "workerd-host", "image": workerd_host["image"]},
                    {"name": "workerd-metrics", "image": workerd_metrics["image"]},
                ],
            },
        }},
    },
    {
        "apiVersion": "apps/v1",
        "kind": "StatefulSet",
        "metadata": {"name": nats["metadata"]["name"], "namespace": namespace},
        "spec": {
            "serviceName": nats["spec"]["serviceName"],
            "selector": nats["spec"]["selector"],
            "template": {
                "metadata": {"annotations": {"fleet.actor.dev/manifest-sha256": nats["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/manifest-sha256"]}},
                "spec": {"containers": [{"name": "nats", "image": nats_container["image"]}]},
            },
        },
    },
]
reporter_path = root / "desired-reporter.json"
if reporter_path.exists():
    reporter = json.load(open(reporter_path))
    reporter_container = next(
        item for item in reporter["spec"]["template"]["spec"]["containers"]
        if item["name"] == "reporter"
    )
    reporter_release_digest = next(
        item for item in reporter_container["env"]
        if item["name"] == "RELEASE_DIGEST"
    )
    items.append({
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {"name": reporter["metadata"]["name"], "namespace": namespace},
        "spec": {
            "selector": reporter["spec"]["selector"],
            "template": {
                "metadata": {
                    "labels": reporter["spec"]["template"]["metadata"]["labels"],
                    "annotations": reporter["spec"]["template"]["metadata"]["annotations"],
                },
                "spec": {"containers": [{
                    "name": "reporter",
                    "image": reporter_container["image"],
                    "env": [reporter_release_digest],
                }]},
            },
        },
    })
for item in items:
    name = item["metadata"]["name"]
    if name.endswith("-engine"):
        label = "engine"
    elif name.endswith("-runtime-hosts"):
        label = "runtime"
    elif name.endswith("-nats"):
        label = "nats"
    elif name.endswith("-cell-reporter"):
        label = "reporter"
    else:
        raise SystemExit(f"unexpected release-field workload: {name}")
    json.dump(item, open(root / f"runtime-release-fields-{label}.json", "w"))
PY
if [[ $runtime_exists == true ]]; then
	# Runtime replica count is live capacity state owned by HPA/Host drain. An
	# update release must neither force it back to the manifest bootstrap floor
	# nor conflict with the current writer. First move the existing value away
	# from the static installer manager without changing it, then omit the field
	# from the full SSA document. Fresh installs retain the manifest bootstrap.
	current_runtime_replicas=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
		"${cell_name}-runtime-hosts" -o jsonpath='{.spec.replicas}')
	[[ $current_runtime_replicas =~ ^[1-9][0-9]*$ ]] || {
		echo "existing runtime replica count is invalid: $current_runtime_replicas" >&2
		exit 1
	}
	kubectl "${kubeconfig_args[@]}" -n "$namespace" patch statefulset \
		"${cell_name}-runtime-hosts" --type=merge \
		--field-manager=rivet-runtime-replica-handoff \
		-p "{\"spec\":{\"replicas\":$current_runtime_replicas}}" >/dev/null
	python3 - "$temporary/desired-runtime.json" \
		"$temporary/runtime-rollout-on-delete.json" \
		"$temporary/runtime-rollout-rolling.json" <<'PY'
import json, sys
source, on_delete, rolling = sys.argv[1:]
document = json.load(open(source))
identity = {
    "apiVersion": document["apiVersion"],
    "kind": document["kind"],
    "metadata": {
        "name": document["metadata"]["name"],
        "namespace": document["metadata"]["namespace"],
    },
}
for output, strategy in (
    (on_delete, {"type": "OnDelete"}),
    (rolling, {"type": "RollingUpdate"}),
):
    payload = dict(identity)
    payload["spec"] = {"updateStrategy": strategy}
    json.dump(payload, open(output, "w"))
PY
	python3 "$script_dir/strip-update-owned-fields.py" \
		--manifest "$temporary/runtime.yaml" --cell "$cell_name"
fi

# Keep the release-field handoff above on the original rendered text. Its
# deliberately narrow parser proves that the expected bootstrap-owned fields
# exist before removing them. The topology adapter is structured YAML and may
# normalize indentation, so it must run only after that proof/handoff and
# before the structured manifest partitioner.
if [[ $availability_mode == qualification-single-zone ]]; then
	python3 "$script_dir/adapt-single-zone-topology.py" \
		--input "$temporary/runtime.yaml" --output "$temporary/runtime.yaml"
fi

# Apply release-owned workloads in dependency order. A single multi-document
# apply lets the Deployment and StatefulSet controllers begin replacing Engine
# and Host Pods concurrently, which combines two independent failure domains.
# Base resources may converge first; then Engine, NATS for an existing Cell,
# the idempotent pool Job, Host StatefulSet, and reporter each receive an
# explicit health boundary. This partitioning does not prune resources and
# keeps one SSA owner.
python3 "$script_dir/partition-runtime-manifest.py" \
	--manifest "$temporary/runtime.yaml" --output "$temporary" \
	--cell "$cell_name" --reporter-mode "$cell_reporter_mode"
kubectl "${kubeconfig_args[@]}" -n "$namespace" delete job "${cell_name}-workerd-pool-init" \
	--ignore-not-found --wait=true >/dev/null
kubectl "${kubeconfig_args[@]}" apply --server-side --field-manager=rivet-runtime-installer \
	-f "$temporary/phase-base.yaml"
if [[ $update_release_fields == true ]]; then
	# Reclaim legacy release-field ownership and install the complete desired
	# Engine in one API mutation. Applying the desired image/manifest as a
	# preliminary partial template creates an intermediate ReplicaSet; with a
	# one-Pod surge that intermediate can occupy the only surge slot and leave
	# the final ReplicaSet permanently Pending behind old hard anti-affinity.
	kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
		--field-manager=rivet-runtime-installer \
		-f "$temporary/phase-engine.yaml"
else
	kubectl "${kubeconfig_args[@]}" apply --server-side --field-manager=rivet-runtime-installer \
		-f "$temporary/phase-engine.yaml"
fi
kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status deployment/"${cell_name}-engine" --timeout=10m
wait_for_engine_nats_clients
# Existing Cells now run the reconnect-capable Engine before the first NATS
# member receives SIGUSR2. Fresh installs already converged NATS above.
if [[ $update_release_fields == true ]]; then
	kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
		--field-manager=rivet-runtime-release-fields \
		-f "$temporary/runtime-release-fields-nats.json"
	kubectl "${kubeconfig_args[@]}" apply --server-side --field-manager=rivet-runtime-installer \
		-f "$temporary/nats-statefulset.yaml"
	wait_for_nats_mesh
	wait_for_engine_nats_clients
fi
kubectl "${kubeconfig_args[@]}" apply --server-side --field-manager=rivet-runtime-installer \
	-f "$temporary/phase-pool.yaml"
kubectl "${kubeconfig_args[@]}" -n "$namespace" wait --for=condition=complete job/"${cell_name}-workerd-pool-init" --timeout=5m
if [[ $update_release_fields == true ]]; then
	# Freeze automatic StatefulSet replacement before either the ownership
	# handoff or the full candidate spec can mutate the Pod template. The
	# release workflow drains and deletes one exact UID at a time below.
	kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
		--field-manager=rivet-runtime-rollout-fence \
		-f "$temporary/runtime-rollout-on-delete.json" >/dev/null
	kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
		--field-manager=rivet-runtime-release-fields \
		-f "$temporary/runtime-release-fields-runtime.json"
	# A failed transaction restores template values with an isolated Update
	# manager. Applying the old value back to the installer afterwards can
	# co-own, rather than remove, that legacy entry; the next release would then
	# fail when a static environment value changes. This document has already
	# had live replicas and updateStrategy removed, while the rollout fence and
	# release-field handoff above own their respective fields. Reclaim the
	# remaining declarative template atomically before serial Host replacement.
	kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
		--field-manager=rivet-runtime-installer \
		-f "$temporary/phase-runtime.yaml"
	roll_runtime_hosts_serially
	# Every live Pod already has updateRevision. Restoring the declarative
	# RollingUpdate strategy therefore causes no deletion and keeps future
	# emergency patches from silently inheriting an OnDelete workload.
	kubectl "${kubeconfig_args[@]}" apply --server-side \
		--field-manager=rivet-runtime-rollout-fence \
		-f "$temporary/runtime-rollout-rolling.json" >/dev/null
else
	kubectl "${kubeconfig_args[@]}" apply --server-side --field-manager=rivet-runtime-installer \
		-f "$temporary/phase-runtime.yaml"
fi
wait_for_runtime_hosts
if [[ $cell_reporter_mode == enabled ]]; then
	if [[ $update_release_fields == true ]]; then
		kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
			--field-manager=rivet-runtime-release-fields \
			-f "$temporary/runtime-release-fields-reporter.json"
	fi
	kubectl "${kubeconfig_args[@]}" apply --server-side --field-manager=rivet-runtime-installer \
		-f "$temporary/phase-reporter.yaml"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status deployment/"${cell_name}-cell-reporter" --timeout=5m
fi

# HPA is the scale-out demand calculator only. The separate UID-fenced
# controller owns serial scale-in and also enforces the runtime release hold;
# every production installation therefore converges it before returning.
if [[ $runtime_profile == production ]]; then
	RIVET_CELL_NAMESPACE="$namespace" \
	RIVET_CELL_NAME="$cell_name" \
	RIVET_REPORTER_IMAGE="$reporter_image" \
	RUNTIME_CAPACITY_MIN_REPLICAS="${RUNTIME_CAPACITY_MIN_REPLICAS:-4}" \
	RUNTIME_CAPACITY_MAX_REPLICAS="${RUNTIME_CAPACITY_MAX_REPLICAS:-301}" \
	RUNTIME_CAPACITY_TARGET_ACTIVE_ACTORS="${RUNTIME_CAPACITY_TARGET_ACTIVE_ACTORS:-16}" \
	RUNTIME_HOST_DRAIN_TOPOLOGY_MAX_SKEW="${RUNTIME_HOST_DRAIN_TOPOLOGY_MAX_SKEW:-2}" \
		"$script_dir/install-host-autoscaling.sh"
fi
