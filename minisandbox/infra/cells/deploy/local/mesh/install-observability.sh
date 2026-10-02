#!/usr/bin/env bash
set -euo pipefail

MESH_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
source "${MESH_DIR}/lib.sh"

for command in helm kubectl docker sha256sum openssl python3 jq; do
	require_command "${command}"
done
require_version helm "${HELM_VERSION}" "$(helm version --template '{{.Version}}')"

FEDERATION_DIR=${CELLS_DIR}/deploy/tencent/fleet/observability/federation
OBSERVABILITY_DIR=${MESH_DIR}/manifests/observability
CHART_CACHE=${MESH_STATE_DIR}/cache/kube-prometheus-stack-${KUBE_PROMETHEUS_STACK_VERSION}.tgz
ADAPTER_VERSION=5.3.0
ADAPTER_SHA256=aa6752b6207ed788522714c3ef7f67f27d423eb4d9512fecb52dc641b6434f31
ADAPTER_CACHE=${MESH_STATE_DIR}/cache/prometheus-adapter-${ADAPTER_VERSION}.tgz
mkdir -p "$(dirname -- "${CHART_CACHE}")"
if [[ ! -f ${CHART_CACHE} ]]; then
	log "pulling kube-prometheus-stack ${KUBE_PROMETHEUS_STACK_VERSION}"
	helm pull oci://ghcr.io/prometheus-community/charts/kube-prometheus-stack \
		--version "${KUBE_PROMETHEUS_STACK_VERSION}" --destination "$(dirname -- "${CHART_CACHE}")"
fi
actual_sha=$(sha256sum "${CHART_CACHE}" | awk '{print $1}')
[[ ${actual_sha} == "${KUBE_PROMETHEUS_STACK_SHA256}" ]] || die "kube-prometheus-stack archive SHA-256 mismatch"
if [[ ! -f ${ADAPTER_CACHE} ]]; then
	log "pulling prometheus-adapter ${ADAPTER_VERSION}"
	helm pull oci://ghcr.io/prometheus-community/charts/prometheus-adapter \
		--version "${ADAPTER_VERSION}" --destination "$(dirname -- "${ADAPTER_CACHE}")"
fi
adapter_sha=$(sha256sum "${ADAPTER_CACHE}" | awk '{print $1}')
[[ ${adapter_sha} == "${ADAPTER_SHA256}" ]] || die "prometheus-adapter archive SHA-256 mismatch"

install_spoke() {
	local name=$1
	local kubeconfig=$2
	log "installing spoke Prometheus in ${name}"
	helm --kubeconfig "${kubeconfig}" upgrade --install actor-observability "${CHART_CACHE}" \
		--namespace observability --create-namespace \
		--values "${OBSERVABILITY_DIR}/spoke-values.yaml" \
		--atomic --wait --timeout 15m
	kubectl_for "${kubeconfig}" apply -f "${FEDERATION_DIR}/spoke-rules.yaml" >/dev/null
	kubectl_for "${kubeconfig}" apply -f "${CELLS_DIR}/deploy/local/pvm-runtime/manifests/metrics-monitor.yaml" >/dev/null
	kubectl_for "${kubeconfig}" apply -f "${OBSERVABILITY_DIR}/federate-service.yaml" >/dev/null
	kubectl_for "${kubeconfig}" -n observability wait --for=condition=Ready \
		pod -l app.kubernetes.io/name=prometheus --timeout=10m
}

install_spoke runtime-a "${RUNTIME_A_KUBECONFIG}"
install_spoke runtime-b "${RUNTIME_B_KUBECONFIG}"

runtime_address() {
	local cluster=$1
	# The server name is stable on the shared Docker network even when Docker
	# assigns the node a different address after a restart or reconnect.
	# The trailing dot makes the Docker name an absolute DNS name and satisfies
	# the production federation renderer's explicit DNS/private-endpoint fence.
	printf 'k3d-%s-server-0.:30090' "${cluster}"
}

targets=${MESH_STATE_DIR}/federation-targets.yaml
cat >"${targets}" <<EOF
apiVersion: fleet.actor.dev/v1alpha1
kind: PrometheusFederationTargets
targets:
  - cluster: runtime-a
    region: local
    address: $(runtime_address "${RUNTIME_A_CLUSTER}")
    scheme: http
    privateEndpoint: true
  - cluster: runtime-b
    region: local
    address: $(runtime_address "${RUNTIME_B_CLUSTER}")
    scheme: http
    privateEndpoint: true
EOF
chmod 0600 "${targets}"
rendered=${MESH_STATE_DIR}/federation-values.yaml
python3 "${FEDERATION_DIR}/render_targets.py" --targets "${targets}" --output "${rendered}"
chmod 0600 "${rendered}"

kubectl_for "${HUB_KUBECONFIG}" create namespace mesh-observability --dry-run=client -o yaml | \
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null
if ! kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability get secret actor-mesh-observability-grafana-admin >/dev/null 2>&1; then
	password=$(openssl rand -base64 36 | tr -d '\n')
	kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability create secret generic actor-mesh-observability-grafana-admin \
		--from-literal=admin-user=admin --from-literal="admin-password=${password}" >/dev/null
fi

grafana_bind_address=127.0.0.1
grafana_http_port=18080
ingress_binding=${MESH_STATE_DIR}/local-ingress/binding.json
if [[ -f ${ingress_binding} ]]; then
	grafana_bind_address=$(jq -er '.address | select(type == "string" and length > 0)' "${ingress_binding}") || \
		die "invalid ingress address in ${ingress_binding}"
	grafana_http_port=$(jq -er '.httpPort | select(type == "number" and floor == .)' "${ingress_binding}") || \
		die "invalid ingress port in ${ingress_binding}"
fi
grafana_public_url="http://${grafana_bind_address}:${grafana_http_port}/grafana/"
kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability create configmap \
	actor-mesh-observability-grafana-public \
	--from-literal="GF_SERVER_ROOT_URL=${grafana_public_url}" --dry-run=client -o yaml | \
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null

log "installing Hub Prometheus federation and Grafana"
helm --kubeconfig "${HUB_KUBECONFIG}" upgrade --install actor-mesh-observability "${CHART_CACHE}" \
	--namespace mesh-observability \
	--values "${OBSERVABILITY_DIR}/hub-values.yaml" \
	--values "${rendered}" \
	--atomic --wait --timeout 15m
kubectl_for "${HUB_KUBECONFIG}" apply -f "${FEDERATION_DIR}/hub-rules.yaml" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" apply -f "${FEDERATION_DIR}/hub-dashboard.yaml" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" apply -f "${FEDERATION_DIR}/hub-compute-dashboard.yaml" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" apply -f "${FEDERATION_DIR}/hub-storage-dashboard.yaml" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" apply -f "${FEDERATION_DIR}/hub-cold-tier-dashboard.yaml" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" apply -f "${FEDERATION_DIR}/hub-workers-api.yaml" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" apply -f "${FEDERATION_DIR}/hub-workers-dashboard.yaml" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability wait --for=condition=Ready \
	pod -l app.kubernetes.io/name=prometheus --timeout=10m

# Use the production Router metric rules, but remove cloud-only scheduling so
# the single-node Hub remains a deterministic protocol double.
adapter_values=${MESH_STATE_DIR}/hub-prometheus-adapter-values.yaml
python3 - "${FEDERATION_DIR}/hub-prometheus-adapter-values.yaml" "${adapter_values}" <<'PY'
import pathlib,sys,yaml
source=pathlib.Path(sys.argv[1]); output=pathlib.Path(sys.argv[2])
value=yaml.safe_load(source.read_text())
value["replicas"]=1
value.pop("affinity",None)
output.write_text(yaml.safe_dump(value,sort_keys=True))
PY
chmod 0600 "${adapter_values}"
helm --kubeconfig "${HUB_KUBECONFIG}" upgrade --install actor-mesh-prometheus-adapter \
	"${ADAPTER_CACHE}" --namespace mesh-observability --values "${adapter_values}" \
	--atomic --wait --timeout 10m
kubectl_for "${HUB_KUBECONFIG}" wait --for=condition=Available \
	apiservice/v1beta1.custom.metrics.k8s.io --timeout=5m

log "observability converged; run ${CELLS_DIR}/deploy/local/ingress/up.sh to expose anonymous Viewer access at /grafana/"
