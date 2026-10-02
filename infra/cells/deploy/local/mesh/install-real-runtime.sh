#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=storage-context.sh
source "${MESH_DIR}/storage-context.sh"

for command in jq kubectl openssl python3; do require_command "${command}"; done
image_file=${MESH_STATE_DIR}/local-real-runtime-image
[[ -s ${image_file} ]] || die "build and import the runtime image with build-real-runtime-image.sh first"
runtime_image=$(<"${image_file}")
nats_image=nats@sha256:e4bf19f15fd3218814a4e3c9e0064e1334bd8aa20d5984b9f1a0afd084f8cc00
cos_credential_file=${RIVET_TENCENT_COS_CREDENTIAL_FILE:-}
cos_app_id=${RIVET_TENCENT_COS_APP_ID:-}
local_cold_endpoint=${RIVET_LOCAL_COLD_ENDPOINT:-}
local_cold_region=${RIVET_LOCAL_COLD_REGION:-local}
local_cold_addressing_style=${RIVET_LOCAL_COLD_ADDRESSING_STYLE:-path}
local_cold_access_key=${RIVET_LOCAL_COLD_ACCESS_KEY_ID:-local-runtime-access}
local_cold_secret_key=${RIVET_LOCAL_COLD_SECRET_ACCESS_KEY:-local-runtime-secret}
declare -A rendered_files=()
cleanup_rendered() {
	local path
	for path in "${rendered_files[@]}"; do rm -f -- "${path}"; done
}
trap cleanup_rendered EXIT

if [[ ${RIVET_LOCAL_STORAGE_CONTEXT} == qualification && -z ${cos_credential_file} ]]; then
	die "qualification runtime install requires an explicit Tencent COS credential file"
fi

if [[ -n ${cos_credential_file} && -n ${local_cold_endpoint} ]]; then
	die "real Tencent COS and the local cold tier cannot be enabled together"
fi
if [[ -n ${local_cold_endpoint} && ${local_cold_addressing_style} != path && ${local_cold_addressing_style} != virtual_hosted ]]; then
	die "RIVET_LOCAL_COLD_ADDRESSING_STYLE must be path or virtual_hosted"
fi

if [[ -n ${cos_credential_file} ]]; then
	[[ -f ${cos_credential_file} ]] || die "COS credential file does not exist: ${cos_credential_file}"
	[[ $(stat -c %a "${cos_credential_file}") == 600 ]] || die "COS credential file must have mode 0600"
	grep -Eq '^AWS_ACCESS_KEY_ID=.+$' "${cos_credential_file}" || die "COS credential file has no access key"
	grep -Eq '^AWS_SECRET_ACCESS_KEY=.+$' "${cos_credential_file}" || die "COS credential file has no secret key"
	[[ ${cos_app_id} =~ ^[0-9]+$ ]] || die "RIVET_TENCENT_COS_APP_ID is required with COS credentials"
fi

prepare_one() {
	local cluster=$1 kubeconfig=$2
	local cell="local-${cluster}" rendered cold_bucket="" cold_endpoint="" cold_region="ap-beijing" cold_addressing_style="virtual_hosted" fdb_cluster
	fdb_cluster=${cell}
	if [[ -n ${cos_credential_file} ]]; then
		local suffix=${cluster#runtime-}
		cold_bucket="actor-depot-cold-dev-bj-local-${suffix}-${cos_app_id}"
		fdb_cluster="${cell}-cos"
		kubectl_for "${kubeconfig}" -n actor-fdb-cell-system create secret generic "${cell}-runtime-cos" \
			--from-env-file="${cos_credential_file}" --dry-run=client -o yaml | \
		kubectl_for "${kubeconfig}" apply -f - >/dev/null
	elif [[ -n ${local_cold_endpoint} ]]; then
		case ${cluster} in
			runtime-a) cold_bucket=${RIVET_LOCAL_COLD_BUCKET_A:-local-runtime-a-cold} ;;
			runtime-b) cold_bucket=${RIVET_LOCAL_COLD_BUCKET_B:-local-runtime-b-cold} ;;
		esac
		cold_endpoint=${local_cold_endpoint}
		cold_region=${local_cold_region}
		cold_addressing_style=${local_cold_addressing_style}
		kubectl_for "${kubeconfig}" -n actor-fdb-cell-system create secret generic "${cell}-runtime-cos" \
			--from-literal="AWS_ACCESS_KEY_ID=${local_cold_access_key}" \
			--from-literal="AWS_SECRET_ACCESS_KEY=${local_cold_secret_key}" \
			--dry-run=client -o yaml | kubectl_for "${kubeconfig}" apply -f - >/dev/null
	fi
	case ${cluster} in
		runtime-a) fdb_cluster=${RIVET_LOCAL_FDB_CLUSTER_A:-${fdb_cluster}} ;;
		runtime-b) fdb_cluster=${RIVET_LOCAL_FDB_CLUSTER_B:-${fdb_cluster}} ;;
	esac
	rendered=$(mktemp)
	rendered_files[${cluster}]=${rendered}
	RIVET_LOCAL_COS_BUCKET=${cold_bucket} RIVET_LOCAL_COLD_ENDPOINT=${cold_endpoint} \
	RIVET_LOCAL_COLD_REGION=${cold_region} RIVET_LOCAL_COLD_ADDRESSING_STYLE=${cold_addressing_style} \
	RIVET_LOCAL_FDB_CLUSTER=${fdb_cluster} \
	RIVET_LOCAL_RUNTIME_A_GATEWAY_HOST="k3d-${RUNTIME_A_CLUSTER}-server-0." \
	RIVET_LOCAL_RUNTIME_B_GATEWAY_HOST="k3d-${RUNTIME_B_CLUSTER}-server-0." \
	RIVET_LOCAL_WORKER_REGISTRY_URL="http://k3d-${HUB_CLUSTER}-server-0:30081/" \
		python3 "${MESH_DIR}/real/render-runtime.py" \
		"${CELLS_DIR}/deploy/tencent/fleet/runtime/runtime.yaml" \
		"${CELLS_DIR}/deploy/tencent/fleet/runtime/nats.yaml" \
		"${cell}" "${runtime_image}" "${nats_image}" "${rendered}"

	if ! kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get secret "${cell}-runtime-auth" >/dev/null 2>&1; then
		local token
		token=$(openssl rand -hex 32)
		kubectl_for "${kubeconfig}" -n actor-fdb-cell-system create secret generic "${cell}-runtime-auth" \
			--from-literal="token=${token}" >/dev/null
	fi
	# The initializer is a one-shot Job whose durable state lives in FDB. Recreate
	# it whenever the selected FDB cluster changes; apply alone leaves a completed
	# Job tied to the previous database and the new Engine has no runner config.
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system delete job "${cell}-workerd-pool-init" \
		--ignore-not-found --wait=true >/dev/null
	kubectl_for "${kubeconfig}" apply -f "${rendered}" >/dev/null
}

wait_engine_one() {
	local cluster=$1 kubeconfig=$2
	local cell="local-${cluster}"
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system rollout status \
		statefulset/"${cell}-nats" --timeout=5m
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system rollout status \
		deployment/"${cell}-engine" --timeout=10m
}

reconfigure_epoxy() {
	local leader_pod
	leader_pod=$(kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system get pod \
		-l fleet.actor.dev/component=engine -o jsonpath='{.items[0].metadata.name}')
	kubectl_for "${RUNTIME_A_KUBECONFIG}" -n actor-fdb-cell-system exec "${leader_pod}" -- \
		/usr/bin/curl --fail --silent --show-error --request POST \
		--header 'content-type: application/json' --data '{}' \
		http://127.0.0.1:6421/epoxy/coordinator/replica-reconfigure >/dev/null
}

wait_one() {
	local cluster=$1 kubeconfig=$2
	local cell="local-${cluster}" cold_bucket=""
	if [[ -n ${cos_credential_file} ]]; then
		local suffix=${cluster#runtime-}
		cold_bucket="actor-depot-cold-dev-bj-local-${suffix}-${cos_app_id}"
	elif [[ -n ${local_cold_endpoint} ]]; then
		case ${cluster} in
			runtime-a) cold_bucket=${RIVET_LOCAL_COLD_BUCKET_A:-local-runtime-a-cold} ;;
			runtime-b) cold_bucket=${RIVET_LOCAL_COLD_BUCKET_B:-local-runtime-b-cold} ;;
		esac
	fi
	wait_engine_one "${cluster}" "${kubeconfig}"
	if [[ -n ${RIVET_LOCAL_STORAGE_PROFILE_ID:-} ]]; then
		"${MESH_DIR}/reconcile-storage-profile.sh" "${cell}" "${kubeconfig}"
	fi
	# Applying the Job together with a rolling Engine update can route its PUT to
	# the old Engine and therefore the old FDB cluster. Recreate it only after the
	# new Engine revision is the sole Service backend.
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system delete job "${cell}-workerd-pool-init" \
		--ignore-not-found --wait=true >/dev/null
	kubectl_for "${kubeconfig}" apply -f "${rendered_files[${cluster}]}" >/dev/null
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system wait job/"${cell}-workerd-pool-init" \
		--for=condition=Complete --timeout=5m
	# A host can enter exponential reconnect backoff while the fresh FDB has no
	# runner config. Restart it after initialization so install completion implies
	# that the host immediately connects to the selected Engine/FDB generation.
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system rollout restart \
		statefulset/"${cell}-runtime-hosts" >/dev/null
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system rollout status \
		statefulset/"${cell}-runtime-hosts" --timeout=10m
	local engine_pod runner_configs
	engine_pod=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get pod \
		-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=engine" \
		-o jsonpath='{.items[0].metadata.name}')
	runner_configs=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system exec "${engine_pod}" -- \
		/usr/bin/curl --fail --silent --show-error \
		'http://127.0.0.1:6421/runner-configs?namespace=default')
	jq -e '.runner_configs.workerd.normal | type == "object"' <<<"${runner_configs}" >/dev/null || \
		die "${cell} new FDB does not contain the workerd runner config"
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get deployment "${cell}-engine" -o json |
		jq -e '.spec.template.spec.nodeSelector == {"rivet.dev/control":"true"}' >/dev/null || \
		die "${cell} Engine template is not pinned to control nodes"
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get statefulset "${cell}-nats" -o json |
		jq -e '.spec.template.spec.nodeSelector == {"rivet.dev/control":"true"}' >/dev/null || \
		die "${cell} NATS template is not pinned to control nodes"
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get job "${cell}-workerd-pool-init" -o json |
		jq -e '.spec.template.spec.nodeSelector == {"rivet.dev/control":"true"}' >/dev/null || \
		die "${cell} runner-config initializer is not pinned to control nodes"
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get statefulset "${cell}-runtime-hosts" -o json |
		jq -e '
			.spec.template.spec as $pod |
			$pod.nodeSelector == {"rivet.dev/compute":"true"} and
			$pod.tolerations == [{
				"key":"rivet.dev/compute", "operator":"Equal",
				"value":"true", "effect":"NoSchedule"
			}]
		' >/dev/null || die "${cell} workerd/V8 template escaped the compute isolation contract"
	local engine_node nats_node workerd_node
	engine_node=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get pod \
		-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=engine" \
		-o jsonpath='{.items[0].spec.nodeName}')
	nats_node=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get pod \
		-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=nats" \
		-o jsonpath='{.items[0].spec.nodeName}')
	workerd_node=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get pod \
		-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=workerd-host" \
		-o jsonpath='{.items[0].spec.nodeName}')
	[[ $(kubectl_for "${kubeconfig}" get node "${engine_node}" -o jsonpath='{.metadata.labels.rivet\.dev/control}') == true ]] || \
		die "${cell} Engine is not running on a control node"
	[[ $(kubectl_for "${kubeconfig}" get node "${nats_node}" -o jsonpath='{.metadata.labels.rivet\.dev/control}') == true ]] || \
		die "${cell} NATS is not running on a control node"
	[[ $(kubectl_for "${kubeconfig}" get node "${workerd_node}" -o jsonpath='{.metadata.labels.rivet\.dev/compute}') == true ]] || \
		die "${cell} workerd/V8 is not running on a compute node"
	if [[ -n ${cold_bucket} ]]; then
		if [[ -n ${local_cold_endpoint} ]]; then
			log "${cell} real Engine, workerd, Depot VFS and persistent local S3 cold tier are running"
		else
			log "${cell} real Engine, workerd, Depot VFS and Tencent COS cold tier are running"
		fi
	else
		log "${cell} real Engine, workerd, Depot VFS and intentionally unreachable cold tier are running"
	fi
}

# Apply both sides before waiting. The first Engine's Epoxy bootstrap can immediately
# address the second Cell's Guard/api-peer NodePorts instead of deadlocking the
# install while the second manifest has not been created yet.
prepare_one runtime-a "${RUNTIME_A_KUBECONFIG}"
prepare_one runtime-b "${RUNTIME_B_KUBECONFIG}"
# A fresh B database has no runner config yet, so its initializer must be able
# to reach replica 2 before it issues the first pool write. Initialize the
# coordinator Cell, then configure the A/B Epoxy quorum before awaiting B's
# pool-init Job. Otherwise a clean two-Cell bootstrap forms a dependency cycle:
# B pool-init waits for Epoxy while Epoxy configuration waits for B pool-init.
wait_engine_one runtime-a "${RUNTIME_A_KUBECONFIG}"
wait_engine_one runtime-b "${RUNTIME_B_KUBECONFIG}"
wait_one runtime-a "${RUNTIME_A_KUBECONFIG}"
reconfigure_epoxy
wait_one runtime-b "${RUNTIME_B_KUBECONFIG}"

# Both Engines are applied before either side is awaited so their peer endpoints exist during
# bootstrap. A follower can still come up while the coordinator is rolling and retain an old local
# Epoxy config. Once both sides are Ready, explicitly ask the coordinator to replay its current
# config and require each replica's local UDB view to contain the active A/B quorum.
reconfigure_epoxy

wait_for_epoxy_replica() {
	local kubeconfig=$1 expected_replica=$2 deadline pod state
	deadline=$((SECONDS + 120))
	while ((SECONDS < deadline)); do
		pod=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get pod \
			-l fleet.actor.dev/component=engine -o jsonpath='{.items[0].metadata.name}')
		if state=$(kubectl_for "${kubeconfig}" -n actor-fdb-cell-system exec "${pod}" -- \
			/usr/bin/curl --fail --silent --show-error \
			http://127.0.0.1:6421/epoxy/replica/debug 2>/dev/null) &&
			jq -e --argjson expected "${expected_replica}" \
				'.computed.this_replica_id == $expected and
				 .computed.this_replica_status == "Active" and
				 (.computed.quorum_members | sort) == [1, 2]' <<<"${state}" >/dev/null; then
			return
		fi
		sleep 1
	done
	die "Epoxy replica ${expected_replica} did not converge to the active A/B quorum"
}

wait_for_epoxy_replica "${RUNTIME_A_KUBECONFIG}" 1
wait_for_epoxy_replica "${RUNTIME_B_KUBECONFIG}" 2
log "local-runtime-a and local-runtime-b Epoxy replicas hold the active A/B quorum"
