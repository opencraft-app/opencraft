#!/usr/bin/env bash
set -euo pipefail
umask 077

STATELESS_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${STATELESS_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

for command in base64 docker jq k3d kubectl openssl python3; do require_command "${command}"; done
for cluster in "${HUB_CLUSTER}" "${RUNTIME_A_CLUSTER}" "${RUNTIME_B_CLUSTER}"; do
	cluster_exists "${cluster}" || die "cluster ${cluster} is missing; run ${MESH_DIR}/up.sh first"
done
image_file=${MESH_STATE_DIR}/local-real-runtime-image
[[ -s ${image_file} ]] || die "local runtime image identity is missing"
runtime_image=$(<"${image_file}")
runtime_image_id=$(docker image inspect "${runtime_image}" --format '{{.Id}}')
prepared_image_annotation=local.fleet.actor.dev/stateless-runtime-image-id
manifest=${CELLS_DIR}/deploy/tencent/fleet/runtime/stateless-executor.yaml
namespace=actor-stateless-system
hub_namespace=workers-api-system
temporary=$(mktemp -d /data/tmp/local-stateless-executor.XXXXXX)
cleanup() { rm -rf -- "${temporary}"; }
trap cleanup EXIT INT TERM

kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null <<EOF
apiVersion: v1
kind: Namespace
metadata:
  name: ${hub_namespace}
---
apiVersion: v1
kind: Service
metadata:
  name: workers-object-router-private
  namespace: ${hub_namespace}
  labels:
    app.kubernetes.io/name: workers-object-router
    app.kubernetes.io/part-of: rivet-workers-api
spec:
  type: NodePort
  selector:
    app.kubernetes.io/name: workers-api
  ports:
    - name: http
      port: 8081
      targetPort: object-router
      nodePort: 30083
EOF

ensure_secret() {
	local kubeconfig=$1 cell=$2 output=$3
	kubectl_for "${kubeconfig}" create namespace "${namespace}" --dry-run=client -o yaml | \
		kubectl_for "${kubeconfig}" apply -f - >/dev/null
	local valid=false existing=${temporary}/${cell}-existing.json
	if kubectl_for "${kubeconfig}" -n "${namespace}" get secret "${cell}-stateless-auth" -o json >"${existing}" 2>/dev/null; then
		if python3 - "${existing}" <<'PY'
import base64,json,sys
value=json.load(open(sys.argv[1])); tokens=[]
for key in ("executor-token","object-router-token","workerd-token"):
    try: token=base64.b64decode(value["data"][key],validate=True).decode("ascii")
    except Exception: raise SystemExit(1)
    if len(token) != 64 or any(c not in "0123456789abcdef" for c in token): raise SystemExit(1)
    tokens.append(token)
if len(set(tokens)) != 3: raise SystemExit(1)
PY
		then valid=true; fi
	fi
	if [[ ${valid} != true ]]; then
		local secret_dir=${temporary}/${cell}-secret
		mkdir -p -- "${secret_dir}"
		for key in executor-token object-router-token workerd-token; do
			openssl rand -hex 32 | tr -d '\n' >"${secret_dir}/${key}"
		done
		kubectl_for "${kubeconfig}" -n "${namespace}" create secret generic "${cell}-stateless-auth" \
			--from-file="${secret_dir}/executor-token" \
			--from-file="${secret_dir}/object-router-token" \
			--from-file="${secret_dir}/workerd-token" \
			--dry-run=client -o yaml | kubectl_for "${kubeconfig}" apply -f - >/dev/null
	fi
	kubectl_for "${kubeconfig}" -n "${namespace}" get secret "${cell}-stateless-auth" -o json >"${output}"
}

ensure_secret "${RUNTIME_A_KUBECONFIG}" local-runtime-a "${temporary}/runtime-a-secret.json"
ensure_secret "${RUNTIME_B_KUBECONFIG}" local-runtime-b "${temporary}/runtime-b-secret.json"

for binding in \
	"stateless-a-token:${temporary}/runtime-a-secret.json:executor-token" \
	"stateless-b-token:${temporary}/runtime-b-secret.json:executor-token" \
	"object-router-a-token:${temporary}/runtime-a-secret.json:object-router-token" \
	"object-router-b-token:${temporary}/runtime-b-secret.json:object-router-token"; do
	name=${binding%%:*}; rest=${binding#*:}; file=${rest%%:*}; key=${rest##*:}
	jq -er --arg key "${key}" '.data[$key]' "${file}" | base64 --decode >"${temporary}/${name}"
done
kubectl_for "${HUB_KUBECONFIG}" -n "${hub_namespace}" create secret generic workers-api-local-stateless-auth \
	--from-file="${temporary}/stateless-a-token" \
	--from-file="${temporary}/stateless-b-token" \
	--from-file="${temporary}/object-router-a-token" \
	--from-file="${temporary}/object-router-b-token" \
	--dry-run=client -o yaml | kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null

install_one() {
	local runtime=$1 cluster=$2 kubeconfig=$3 cell=local-$1 output=${temporary}/$1.yaml
	local node=k3d-${cluster}-stateless-0 node_json=${temporary}/${runtime}-stateless-node.json
	kubectl_for "${kubeconfig}" get node "${node}" -o json >"${node_json}" || \
		die "isolated stateless baseline node ${node} is missing; run ${MESH_DIR}/up.sh first"
	jq -e '.metadata.labels["local.fleet.actor.dev/stateless-base"] == "true"' "${node_json}" >/dev/null || \
		die "refusing to adopt stateless node without its local ownership label: ${node}"
	prepared=$(jq -r --arg key "${prepared_image_annotation}" '.metadata.annotations[$key] // ""' "${node_json}")
	if [[ ${prepared} != "${runtime_image_id}" ]]; then
		# Mirror production admission: the Node stays unschedulable for this
		# workload until its exact immutable runtime image is locally usable.
		kubectl_for "${kubeconfig}" taint node "${node}" \
			startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission=pending:NoSchedule \
			--overwrite >/dev/null
		kubectl_for "${kubeconfig}" label node "${node}" \
			fleet.actor.dev/stateless-admitted- >/dev/null 2>&1 || true
		k3d image import "${runtime_image}" --cluster "${cluster}" >/dev/null
		kubectl_for "${kubeconfig}" annotate node "${node}" \
			"${prepared_image_annotation}=${runtime_image_id}" --overwrite >/dev/null
	fi
	kubectl_for "${kubeconfig}" taint node "${node}" \
		rivet.dev/stateless=true:NoSchedule --overwrite >/dev/null
	kubectl_for "${kubeconfig}" label node "${node}" \
		rivet.dev/control- rivet.dev/compute- rivet.dev/stateless=true \
		fleet.actor.dev/stateless-admitted=true --overwrite >/dev/null
	kubectl_for "${kubeconfig}" taint node "${node}" \
		startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission- >/dev/null 2>&1 || true
	python3 "${STATELESS_DIR}/render.py" "${manifest}" "${output}" \
		--cell "${cell}" --image "${runtime_image}" --runtime-digest "${runtime_image_id}" \
		--registry-url "http://k3d-${HUB_CLUSTER}-server-0.:30081/" \
		--object-router-address "k3d-${HUB_CLUSTER}-server-0.:30083"
	kubectl_for "${kubeconfig}" apply -f "${output}" >/dev/null
	kubectl_for "${kubeconfig}" -n "${namespace}" rollout status \
		deployment/"${cell}-stateless-executor" --timeout=10m
}

install_one runtime-a "${RUNTIME_A_CLUSTER}" "${RUNTIME_A_KUBECONFIG}"
install_one runtime-b "${RUNTIME_B_CLUSTER}" "${RUNTIME_B_KUBECONFIG}"
log "A/B stateless executors are Ready with isolated Cell capabilities"
