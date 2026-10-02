#!/usr/bin/env bash
set -euo pipefail

PVM_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${PVM_DIR}/lib.sh"

for command in base64 curl docker jq kubectl openssl sed; do require_command "${command}"; done
validate_local_pvm_settings

image_ref=$(read_single_line "${PVM_IMAGE_REF_FILE}")
archive=$(read_single_line "${PVM_IMAGE_ARCHIVE_FILE}")
[[ -f ${archive} ]] || die "PVM image archive is missing: ${archive}; run ${PVM_DIR}/build-image.sh"
[[ ${image_ref} =~ ^[a-zA-Z0-9._/:@-]+$ ]] || die "PVM image reference contains unsupported characters"

mkdir -p -- "${PVM_ARTIFACT_ROOT}"
if [[ ! -f ${PVM_HERMES_KEY_FILE} ]]; then
	umask 0077
	openssl rand -hex 32 >"${PVM_HERMES_KEY_FILE}"
fi
hermes_key=$(read_single_line "${PVM_HERMES_KEY_FILE}")

register_runner_config() {
	local cell=$1 kubeconfig=$2
	# Each local Cell owns an independent FDB. Register directly with its trusted
	# api-peer so concurrent A/B installers cannot race a public fan-out update.
	kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" exec \
		deployment/"${cell}-engine" -- /usr/bin/curl --fail --silent --show-error \
		--request PUT \
		--header 'Content-Type: application/json' \
		--data '{"normal":{}}' \
		"http://127.0.0.1:6421/runner-configs/${PVM_RUNNER_NAME}?namespace=default" >/dev/null
}

render_runtime() {
	local cell=$1 kubeconfig=$2 runtime_config engine_image fdb_config_map
	local cos_bucket cos_endpoint cos_region template_id
	runtime_config=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get configmap \
		"${cell}-runtime-config" -o jsonpath='{.data.config\.jsonc}')
	engine_image=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get deployment \
		"${cell}-engine" -o json | jq -er '
			[.spec.template.spec.containers[] | select(.name == "engine") | .image] |
			if length == 1 then .[0] else error("Engine must have exactly one engine container") end')
	[[ ${engine_image} =~ ^[a-zA-Z0-9._/:@-]+$ ]] || die "${cell} Engine image reference contains unsupported characters"
	fdb_config_map=$(kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get deployment \
		"${cell}-engine" -o json | jq -er '
			[.spec.template.spec.volumes[] | select(.name == "fdb-config") | .configMap.name] |
			if length == 1 then .[0] else error("Engine must mount exactly one fdb-config ConfigMap") end')
	[[ ${fdb_config_map} =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || \
		die "${cell} Engine has an invalid fdb-config ConfigMap name"
	kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" get configmap "${fdb_config_map}" \
		-o json | jq -e '.data["cluster-file"] | type == "string" and length > 0' >/dev/null || \
		die "${cell} Engine fdb-config ConfigMap has no cluster-file"
	cos_bucket=$(jq -er '.sqlite.workflow_cold_storage.s3.bucket' <<<"${runtime_config}")
	cos_endpoint=$(jq -er '.sqlite.workflow_cold_storage.s3.endpoint' <<<"${runtime_config}")
	cos_region=$(jq -er '.sqlite.workflow_cold_storage.s3.region' <<<"${runtime_config}")
	template_id=$(jq -er '.sha256' \
		"${REPO_ROOT}/runtimes/minisandbox/core/target/pvm-linux/actor-volume-template-2g.ext4.metadata.json")
	sed \
		-e "s|__CELL__|${cell}|g" \
		-e "s|__RUNNER_NAME__|${PVM_RUNNER_NAME}|g" \
		-e "s|__FDB_CONFIG_MAP__|${fdb_config_map}|g" \
		-e "s|__ENGINE_IMAGE__|${engine_image}|g" \
		-e "s|__IMAGE__|${image_ref}|g" \
		-e "s|__MEMORY_MIB__|${PVM_MEMORY_MIB}|g" \
		-e "s|__UPPER_SIZE_MIB__|${PVM_UPPER_SIZE_MIB}|g" \
		-e "s|__ACTOR_VOLUME_TEMPLATE_ID__|${template_id}|g" \
		-e "s|__COS_BUCKET__|${cos_bucket}|g" \
		-e "s|__COS_ENDPOINT__|${cos_endpoint}|g" \
		-e "s|__COS_REGION__|${cos_region}|g" \
		"${PVM_DIR}/manifests/runtime.yaml"
}

import_image_to_pvm_nodes() {
	local cluster=$1 kubeconfig=$2 node found=false
	while IFS= read -r node; do
		[[ -n ${node} ]] || continue
		[[ ${node} == "k3d-${cluster}-"* ]] || die "refusing unexpected PVM node name: ${node}"
		docker inspect "${node}" >/dev/null 2>&1 || die "PVM node is not a local Docker container: ${node}"
		log "importing ${image_ref} directly into ${node} from /data"
		docker exec -i "${node}" ctr --namespace k8s.io images import - <"${archive}" >/dev/null
		found=true
	done < <(kubectl_for "${kubeconfig}" get node -l rivet.dev/pvm=true -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
	[[ ${found} == true ]] || die "${cluster} has no rivet.dev/pvm=true nodes"
}

while IFS=$'\t' read -r cell cluster kubeconfig; do
	[[ -f ${kubeconfig} ]] || die "kubeconfig is missing for ${cell}: ${kubeconfig}"
	import_image_to_pvm_nodes "${cluster}" "${kubeconfig}"
	log "installing the bounded KVM device resource in ${cell}"
	kubectl_for "${kubeconfig}" apply -f "${PVM_DIR}/manifests/device-plugin.yaml" >/dev/null
	kubectl_for "${kubeconfig}" -n "${PVM_NAMESPACE}" rollout status \
		daemonset/minisandbox-kvm-device-plugin --timeout=3m
	deadline=$((SECONDS + 120))
	until kubectl_for "${kubeconfig}" get node -l rivet.dev/pvm=true -o json |
		jq -e 'any(.items[]; ((.status.allocatable["rivet.dev/kvm"] // "0") | tonumber) >= 1)' >/dev/null; do
		((SECONDS < deadline)) || die "${cell} did not advertise rivet.dev/kvm within 120 seconds"
		sleep 1
	done
	log "registering ${PVM_RUNNER_NAME} before connecting the ${cell} Envoy"
	register_runner_config "${cell}" "${kubeconfig}"
	encoded_hermes_key=$(printf '%s' "${hermes_key}" | base64 -w0)
	jq -n --arg key "${encoded_hermes_key}" --arg namespace "${PVM_RUNTIME_NAMESPACE}" \
		'{apiVersion:"v1",kind:"Secret",metadata:{name:"minisandbox-hermes-api",namespace:$namespace},type:"Opaque",data:{"api-key":$key}}' |
		kubectl_for "${kubeconfig}" apply -f - >/dev/null
	render_runtime "${cell}" "${kubeconfig}" | kubectl_for "${kubeconfig}" apply -f - >/dev/null
	kubectl_for "${kubeconfig}" -n "${PVM_RUNTIME_NAMESPACE}" rollout status \
		deployment/"${cell}-minisandbox-hermes" --timeout=10m
done < <(runtime_cells)

"${PVM_DIR}/verify.sh"
