#!/usr/bin/env bash
set -euo pipefail

REGISTRY_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${REGISTRY_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

for command in curl jq kubectl python3; do
	require_command "${command}"
done
cluster_exists "${HUB_CLUSTER}" || die "cluster ${HUB_CLUSTER} is missing"

kubectl_for "${HUB_KUBECONFIG}" -n actor-fdb-cell-system get \
	foundationdbcluster worker-registry-code-plane -o json | jq -e '
	.status.configured == true and
	(.status.available == true or .status.health.available == true) and
	(.status.fullReplication == true or .status.health.fullReplication == true) and
	.status.desiredProcessGroups == 3 and
	.status.reconciledProcessGroups == 3
' >/dev/null || die "Code Plane FDB is not healthy"

kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system get deployment worker-registry -o json | jq -e '
	.spec.replicas == 3 and .status.readyReplicas == 3 and
	(.spec.template.spec.volumes | length) == 1 and
	.spec.template.spec.volumes[0].configMap.name == "worker-registry-fdb" and
	([.spec.template.spec.containers[0].args[] | select(. == "--backend=fdb-cos")] | length) == 1 and
	([.spec.template.spec.containers[0].args[] | select(startswith("--data-dir="))] | length) == 0
' >/dev/null || die "Worker Registry is not the three-replica FDB/COS deployment"
[[ $(kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system get pdb worker-registry \
	-o jsonpath='{.spec.minAvailable}') == 2 ]] || die "Worker Registry PDB does not preserve two replicas"

STATE_DIR=${MESH_STATE_DIR}/worker-registry
mkdir -p "${STATE_DIR}"
chmod 0700 "${STATE_DIR}"
LOCAL_PORT=$(python3 - <<'PY'
import socket
with socket.socket() as sock:
    sock.bind(("127.0.0.1", 0))
    print(sock.getsockname()[1])
PY
)
PORT_FORWARD_LOG=${STATE_DIR}/port-forward.log
PORT_FORWARD_PID=
cleanup() {
	if [[ -n ${PORT_FORWARD_PID} ]]; then
		kill "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true
		wait "${PORT_FORWARD_PID}" >/dev/null 2>&1 || true
	fi
}
trap cleanup EXIT

BASE_URL=http://127.0.0.1:${LOCAL_PORT}
start_port_forward() {
	cleanup
	kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system port-forward \
		service/worker-registry "${LOCAL_PORT}:8080" >"${PORT_FORWARD_LOG}" 2>&1 &
	PORT_FORWARD_PID=$!
	for _ in $(seq 1 60); do
		if curl --fail --silent "${BASE_URL}/readyz" >/dev/null 2>&1; then
			return 0
		fi
		if ! kill -0 "${PORT_FORWARD_PID}" >/dev/null 2>&1; then
			die "Worker registry port-forward failed; see ${PORT_FORWARD_LOG}"
		fi
		sleep 0.25
	done
	die "Worker registry did not become ready"
}
start_port_forward

WORKER=registry-smoke
ENDPOINT=${BASE_URL}/v1/namespaces/e2e/workers/${WORKER}
payload_one=$(jq -cn '{main_module:"main.js",modules:{"main.js":"export default { fetch() { return new Response(\"one\") } }"},compatibility_date:"2026-08-14"}')
payload_two=$(jq -cn '{main_module:"main.js",modules:{"main.js":"export default { fetch() { return new Response(\"two\") } }"},compatibility_date:"2026-08-14"}')
first=$(curl --fail --silent --show-error --request PUT \
	--header 'Content-Type: application/json' --data "${payload_one}" "${ENDPOINT}")
first_version=$(jq -er '.versions[0].version_id' <<<"${first}")
second=$(curl --fail --silent --show-error --request PUT \
	--header 'Content-Type: application/json' --data "${payload_two}" "${ENDPOINT}")
second_version=$(jq -er '.versions[0].version_id' <<<"${second}")
[[ ${first_version} != "${second_version}" ]] || die "changed source did not create a new Version"

curl --fail --silent --show-error \
	"${BASE_URL}/internal/v1/namespaces/e2e/workers/${WORKER}/versions/${first_version}" | \
	jq -e '.content.modules[.content.main_module] | contains("one")' >/dev/null

log "restarting all three Registry replicas to verify FDB/COS recovery"
kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system rollout restart deployment/worker-registry >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system rollout status \
	deployment/worker-registry --timeout=3m >/dev/null
start_port_forward
for _ in $(seq 1 60); do
	active_version=$(curl --silent "${ENDPOINT}" | jq -r '.versions[0].version_id // empty' 2>/dev/null || true)
	[[ ${active_version} == "${second_version}" ]] && break
	sleep 0.25
done
[[ ${active_version:-} == "${second_version}" ]] || die "Worker deployment did not survive restart"

log "restarting the persistent local COS double"
kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system rollout restart \
	deployment/worker-registry-cos >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system rollout status \
	deployment/worker-registry-cos --timeout=3m >/dev/null
start_port_forward
curl --fail --silent --show-error \
	"${BASE_URL}/internal/v1/namespaces/e2e/workers/${WORKER}/versions/${first_version}" | \
	jq -e '.content.modules[.content.main_module] | contains("one")' >/dev/null

curl --fail --silent --show-error --request DELETE "${ENDPOINT}" >/dev/null
status=$(curl --silent --output /dev/null --write-out '%{http_code}' "${ENDPOINT}")
[[ ${status} == 404 ]] || die "deleted Worker returned HTTP ${status}, expected 404"
curl --fail --silent --show-error \
	"${BASE_URL}/internal/v1/namespaces/e2e/workers/${WORKER}/versions/${first_version}" >/dev/null

ready_replicas=$(kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system get deployment \
	worker-registry -o jsonpath='{.status.readyReplicas}')
[[ ${ready_replicas} == 3 ]] || die "Worker Registry did not restore three Ready replicas"

log "Worker registry E2E passed: dedicated FDB, persistent COS, three replicas, restart recovery, safe delete"
