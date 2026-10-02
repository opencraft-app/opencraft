#!/usr/bin/env bash
set -euo pipefail

INGRESS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${INGRESS_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"
# shellcheck source=versions.env
source "${INGRESS_DIR}/versions.env"

for command in curl docker jq k3d kubectl python3 sed sha256sum; do
	require_command "${command}"
done
for cluster in "${HUB_CLUSTER}" "${RUNTIME_A_CLUSTER}" "${RUNTIME_B_CLUSTER}"; do
	cluster_exists "${cluster}" || die "cluster ${cluster} is missing; run ${MESH_DIR}/up.sh first"
done

STATE_DIR=${MESH_STATE_DIR}/local-ingress
BINDING_FILE=${STATE_DIR}/binding.json
mkdir -p "${STATE_DIR}"
chmod 0700 "${STATE_DIR}"

stored_bind_address=127.0.0.1
stored_http_port=18080
if [[ -f ${BINDING_FILE} ]]; then
	stored_bind_address=$(jq -er '.address | select(type == "string" and length > 0)' "${BINDING_FILE}") || \
		die "invalid ingress address in ${BINDING_FILE}"
	stored_http_port=$(jq -er '.httpPort | select(type == "number" and floor == .)' "${BINDING_FILE}") || \
		die "invalid ingress port in ${BINDING_FILE}"
fi
LOCAL_INGRESS_BIND_ADDRESS=${RIVET_LOCAL_INGRESS_BIND_ADDRESS:-${stored_bind_address}}
LOCAL_INGRESS_HTTP_PORT=${RIVET_LOCAL_INGRESS_HTTP_PORT:-${stored_http_port}}
PUBLISHER_NAME=${RIVET_LOCAL_INGRESS_PUBLISHER_NAME:-${MESH_PREFIX}-local-ingress-publisher}

if [[ ! ${LOCAL_INGRESS_HTTP_PORT} =~ ^[0-9]+$ ]] || \
	(( LOCAL_INGRESS_HTTP_PORT < 1024 || LOCAL_INGRESS_HTTP_PORT > 65535 )); then
	die "RIVET_LOCAL_INGRESS_HTTP_PORT must be an unprivileged TCP port from 1024 through 65535"
fi
python3 - "${LOCAL_INGRESS_BIND_ADDRESS}" <<'PY'
import ipaddress
import sys

address = ipaddress.ip_address(sys.argv[1])
if not isinstance(address, ipaddress.IPv4Address):
    raise SystemExit("local ingress currently requires one explicit IPv4 address")
if address.is_unspecified or address.is_multicast:
    raise SystemExit("ingress must bind one explicit loopback or unicast address, never 0.0.0.0")
PY

grafana_service=actor-mesh-observability-grafana
grafana_deployment=actor-mesh-observability-grafana
grafana_public_config=actor-mesh-observability-grafana-public
grafana_public_url="http://${LOCAL_INGRESS_BIND_ADDRESS}:${LOCAL_INGRESS_HTTP_PORT}/grafana/"
kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability get service "${grafana_service}" >/dev/null 2>&1 || \
	die "Hub Grafana is missing; run ${MESH_DIR}/install-observability.sh first"
kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system get service workers-api >/dev/null 2>&1 || \
	die "Workers API is missing; run deploy/local/workers-api/up.sh first"
grafana_env_config=$(kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability \
	get deployment "${grafana_deployment}" \
	-o jsonpath='{range .spec.template.spec.containers[?(@.name=="grafana")].envFrom[*]}{.configMapRef.name}{"\n"}{end}')
grep -Fxq "${grafana_public_config}" <<<"${grafana_env_config}" || \
	die "Hub Grafana has no public URL input; rerun ${MESH_DIR}/install-observability.sh"
kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability create configmap "${grafana_public_config}" \
	--from-literal="GF_SERVER_ROOT_URL=${grafana_public_url}" --dry-run=client -o yaml | \
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null
grafana_public_sha256=$(printf '%s' "${grafana_public_url}" | sha256sum | awk '{print $1}')
grafana_patch=$(jq -cn --arg sha "${grafana_public_sha256}" \
	'{spec:{template:{metadata:{annotations:{"local.ingress.rivet.dev/grafana-public-url-sha256":$sha}}}}}')
kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability patch deployment "${grafana_deployment}" \
	--type=merge -p "${grafana_patch}" >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n mesh-observability rollout status \
	"deployment/${grafana_deployment}" --timeout=3m >/dev/null

for entry in "${RUNTIME_A_KUBECONFIG}:local-runtime-a" "${RUNTIME_B_KUBECONFIG}:local-runtime-b"; do
	kubeconfig=${entry%%:*}
	cell=${entry#*:}
	kubectl_for "${kubeconfig}" -n actor-fdb-cell-system get service "${cell}-ingress" \
		>/dev/null 2>&1 || die "${cell} mesh gateway is missing; run ${MESH_DIR}/install-real-runtime.sh first"
done

cat >"${STATE_DIR}/Caddyfile" <<EOF
{
	admin off
	auto_https off
}

:8080 {
	header -Server

	route {
		@landing path /
		header @landing Content-Type application/json
		respond @landing "{\"service\":\"rivet-local-ingress\",\"status\":\"ok\"}" 200
		respond /healthz 200

		redir /grafana /grafana/ 308
		handle /grafana/* {
			reverse_proxy ${grafana_service}.mesh-observability.svc.cluster.local:80
		}

		respond /api/worker-registry/* 404

		handle /v1/* {
			reverse_proxy workers-api.workers-api-system.svc.cluster.local:8080
		}

		@runtime_a_host host runtime-a.local
		handle @runtime_a_host {
			reverse_proxy k3d-${RUNTIME_A_CLUSTER}-server-0.:30420 {
				health_uri /health
				health_interval 2s
				health_timeout 1s
			}
		}
		@runtime_b_host host runtime-b.local
		handle @runtime_b_host {
			reverse_proxy k3d-${RUNTIME_B_CLUSTER}-server-0.:30420 {
				health_uri /health
				health_interval 2s
				health_timeout 1s
			}
		}

		handle_path /runtime-a/* {
			reverse_proxy k3d-${RUNTIME_A_CLUSTER}-server-0.:30420
		}
		handle_path /runtime-b/* {
			reverse_proxy k3d-${RUNTIME_B_CLUSTER}-server-0.:30420
		}

		handle {
			reverse_proxy k3d-${RUNTIME_A_CLUSTER}-server-0.:30420 k3d-${RUNTIME_B_CLUSTER}-server-0.:30420 {
				lb_policy round_robin
				lb_try_duration 3s
				lb_try_interval 100ms
				health_uri /health
				health_interval 2s
				health_timeout 1s
				fail_duration 5s
				max_fails 1
			}
		}
	}
}
EOF
chmod 0600 "${STATE_DIR}/Caddyfile"

kubectl_for "${HUB_KUBECONFIG}" create namespace local-ingress-system \
	--dry-run=client -o yaml | kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n local-ingress-system create configmap local-ingress \
	--from-file=Caddyfile="${STATE_DIR}/Caddyfile" --dry-run=client -o yaml | \
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null

if ! docker image inspect "${CADDY_IMAGE_TAG}" >/dev/null 2>&1; then
	log "pulling pinned Caddy image"
	docker pull "${CADDY_IMAGE_TAG}" >/dev/null
fi
if [[ $(docker image inspect "${CADDY_IMAGE_TAG}" --format '{{json .RepoDigests}}') != *"${CADDY_IMAGE}"* ]]; then
	die "${CADDY_IMAGE_TAG} does not match pinned digest ${CADDY_IMAGE}"
fi
log "importing Caddy into the Hub cluster"
k3d image import "${CADDY_IMAGE_TAG}" --cluster "${HUB_CLUSTER}" >/dev/null
caddy_config_sha256=$(sha256sum "${STATE_DIR}/Caddyfile" | awk '{print $1}')
sed -e "s#__CADDY_IMAGE__#${CADDY_IMAGE}#" \
	-e "s#__CADDY_CONFIG_SHA256__#${caddy_config_sha256}#" \
	"${INGRESS_DIR}/manifests/caddy.yaml" | \
	kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n local-ingress-system rollout status \
	deployment/local-ingress --timeout=3m >/dev/null

cat >"${STATE_DIR}/publisher.cfg" <<EOF
global
	log stdout format raw local0

defaults
	log global
	mode tcp
	timeout connect 3s
	timeout client 1h
	timeout server 1h

frontend local_ingress
	bind :8080
	default_backend hub_caddy

backend hub_caddy
	server hub k3d-${HUB_CLUSTER}-server-0:30080 check inter 2s
EOF
chmod 0644 "${STATE_DIR}/publisher.cfg"

if ! docker image inspect "${PUBLISHER_IMAGE}" >/dev/null 2>&1; then
	log "pulling pinned TCP publisher image"
	docker pull "${PUBLISHER_IMAGE}" >/dev/null
fi
docker run --rm \
	--network "${MESH_NETWORK}" \
	--volume "${STATE_DIR}/publisher.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro" \
	"${PUBLISHER_IMAGE}" haproxy -c -f /usr/local/etc/haproxy/haproxy.cfg >/dev/null
if docker container inspect "${PUBLISHER_NAME}" >/dev/null 2>&1; then
	docker rm -f "${PUBLISHER_NAME}" >/dev/null
fi
log "publishing Caddy on ${LOCAL_INGRESS_BIND_ADDRESS}:${LOCAL_INGRESS_HTTP_PORT}"
docker run -d --name "${PUBLISHER_NAME}" --restart unless-stopped \
	--network "${MESH_NETWORK}" \
	--publish "${LOCAL_INGRESS_BIND_ADDRESS}:${LOCAL_INGRESS_HTTP_PORT}:8080" \
	--volume "${STATE_DIR}/publisher.cfg:/usr/local/etc/haproxy/haproxy.cfg:ro" \
	"${PUBLISHER_IMAGE}" >/dev/null

RIVET_LOCAL_INGRESS_BIND_ADDRESS=${LOCAL_INGRESS_BIND_ADDRESS} \
	RIVET_LOCAL_INGRESS_HTTP_PORT=${LOCAL_INGRESS_HTTP_PORT} \
	"${INGRESS_DIR}/verify.sh"

binding_tmp=${BINDING_FILE}.tmp
jq -n --arg address "${LOCAL_INGRESS_BIND_ADDRESS}" \
	--argjson httpPort "${LOCAL_INGRESS_HTTP_PORT}" \
	'{address: $address, httpPort: $httpPort}' >"${binding_tmp}"
chmod 0600 "${binding_tmp}"
mv "${binding_tmp}" "${BINDING_FILE}"
log "saved local ingress binding in ${BINDING_FILE}"
