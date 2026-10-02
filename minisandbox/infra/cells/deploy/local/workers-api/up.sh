#!/usr/bin/env bash
set -euo pipefail

API_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
MESH_DIR=$(cd -- "${API_DIR}/../mesh" && pwd)
# shellcheck source=../mesh/lib.sh
source "${MESH_DIR}/lib.sh"

for command in curl docker jq k3d kubectl python3 sed; do
	require_command "${command}"
done
for cluster in "${HUB_CLUSTER}" "${RUNTIME_A_CLUSTER}" "${RUNTIME_B_CLUSTER}"; do
	cluster_exists "${cluster}" || die "cluster ${cluster} is missing; run ${MESH_DIR}/up.sh first"
done
kubectl_for "${HUB_KUBECONFIG}" -n worker-registry-system get service worker-registry >/dev/null 2>&1 || \
	die "Worker Registry is missing; run deploy/local/worker-registry/up.sh first"
kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system get secret workers-api-local-stateless-auth >/dev/null 2>&1 || \
	die "stateless capabilities are missing; run deploy/local/stateless-executor/up.sh first"
for binding in \
	"${RUNTIME_A_KUBECONFIG}:local-runtime-a" \
	"${RUNTIME_B_KUBECONFIG}:local-runtime-b"; do
	kubeconfig=${binding%%:*}; cell=${binding##*:}
	kubectl_for "${kubeconfig}" -n actor-stateless-system rollout status \
		deployment/"${cell}-stateless-executor" --timeout=3m
done

WORKERS_API_IMAGE=${WORKERS_API_IMAGE:-rivet/workers-api:local}
WORKERS_API_BUILD_IMAGE=${WORKERS_API_BUILD_IMAGE:-golang:1.25.4-bookworm}
WORKERS_API_RUNTIME_IMAGE=${WORKERS_API_RUNTIME_IMAGE:-gcr.io/distroless/static-debian12:nonroot}
log "building Workers API image ${WORKERS_API_IMAGE}"
docker build \
	--build-arg "WORKERS_API_BUILD_IMAGE=${WORKERS_API_BUILD_IMAGE}" \
	--build-arg "WORKERS_API_RUNTIME_IMAGE=${WORKERS_API_RUNTIME_IMAGE}" \
	--file "${CELLS_DIR}/Dockerfile.workers-api" --tag "${WORKERS_API_IMAGE}" "${CELLS_DIR}"
log "importing Workers API into Hub cluster ${HUB_CLUSTER}"
imported=false
for attempt in 1 2 3; do
	if k3d image import "${WORKERS_API_IMAGE}" --cluster "${HUB_CLUSTER}" >/dev/null; then
		imported=true
		break
	fi
	log "k3d image import attempt ${attempt} failed; retrying"
done
[[ ${imported} == true ]] || die "could not import Workers API image into ${HUB_CLUSTER}"
WORKERS_API_IMAGE_ID=$(docker image inspect "${WORKERS_API_IMAGE}" --format '{{.Id}}')

# Local-only reconstruction of immutable route records. Production routes are
# published from Terraform/Argo convergence receipts; this double binds the
# same live Pool UID and spoke Cell UID so the serving resolver exercises the
# identical fail-closed contract.
kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null <<'EOF'
apiVersion: v1
kind: Namespace
metadata:
  name: workers-api-system
EOF
pool=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get shardpool local-mesh -o json)
cells=$(kubectl_for "${HUB_KUBECONFIG}" -n actor-fleet-system get rivetcell -l fleet.actor.dev/pool=local-mesh -o json)
pool_uid=$(jq -er '.metadata.uid | select(type == "string" and length > 0)' <<<"$pool")
cell_name_a=$(jq -er '.items[] | select(.spec.managementCluster == "runtime-a") | .metadata.name | select(type == "string" and length > 0)' <<<"$cells")
cell_name_b=$(jq -er '.items[] | select(.spec.managementCluster == "runtime-b") | .metadata.name | select(type == "string" and length > 0)' <<<"$cells")
cell_uid_a=$(jq -er '.items[] | select(.spec.managementCluster == "runtime-a") | .status.spokeCellRef.uid | select(type == "string" and length > 0)' <<<"$cells")
cell_uid_b=$(jq -er '.items[] | select(.spec.managementCluster == "runtime-b") | .status.spokeCellRef.uid | select(type == "string" and length > 0)' <<<"$cells")
route_dir=$(mktemp -d /data/tmp/local-workers-routes.XXXXXX)
trap 'rm -rf -- "$route_dir"' EXIT INT TERM
python3 - "$pool" "$cells" "$route_dir" <<'PY'
import hashlib,json,pathlib,sys
pool=json.loads(sys.argv[1]); cells=json.loads(sys.argv[2]); root=pathlib.Path(sys.argv[3])
pool_name=pool["metadata"]["name"]; pool_uid=pool["metadata"]["uid"]
for cell in cells["items"]:
    name=cell["metadata"]["name"]
    spoke_uid=cell.get("status",{}).get("spokeCellRef",{}).get("uid","")
    cluster=cell.get("spec",{}).get("managementCluster","")
    if not spoke_uid or cluster not in {"runtime-a","runtime-b"}:
        raise SystemExit("local Cell route identity is incomplete: " + name)
    datacenter="local-runtime-a" if cluster == "runtime-a" else "local-runtime-b"
    proof="sha256:"+hashlib.sha256((pool_uid+"\0"+spoke_uid+"\0"+datacenter).encode()).hexdigest()
    route={"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"actor-cell-route-"+name,
      "namespace":"workers-api-system","labels":{"fleet.actor.dev/cell-route":"true"}},"immutable":True,
      "data":{"pool-name":pool_name,"pool-uid":pool_uid,"cell-name":name,"cell-uid":spoke_uid,
              "datacenter":datacenter,"convergence-receipt-digest":proof}}
    (root/(name+".json")).write_text(json.dumps(route,sort_keys=True)+"\n")
PY
for route in "$route_dir"/*.json; do
	name=$(jq -r '.metadata.name' "$route")
	if existing=$(kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system get configmap "$name" -o json 2>/dev/null); then
		if ! jq -e --slurpfile want "$route" '
          .immutable == true and .data == $want[0].data and
          .metadata.labels["fleet.actor.dev/cell-route"] == "true"
        ' <<<"$existing" >/dev/null; then
			kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system delete configmap "$name" --wait=true >/dev/null
		else
			continue
		fi
	fi
	kubectl_for "${HUB_KUBECONFIG}" create -f "$route" >/dev/null
done

sed -e "s#__WORKERS_API_IMAGE__#${WORKERS_API_IMAGE}#" \
	-e "s#__WORKERS_API_IMAGE_ID__#${WORKERS_API_IMAGE_ID}#" \
	-e "s#__RUNTIME_A_CLUSTER__#${RUNTIME_A_CLUSTER}#" \
	-e "s#__RUNTIME_B_CLUSTER__#${RUNTIME_B_CLUSTER}#" \
	-e "s#__CELL_NAME_A__#${cell_name_a}#" \
	-e "s#__CELL_NAME_B__#${cell_name_b}#" \
	-e "s#__CELL_UID_A__#${cell_uid_a}#" \
	-e "s#__CELL_UID_B__#${cell_uid_b}#" \
	-e "s#__POOL_UID__#${pool_uid}#" \
	"${API_DIR}/manifests/api.yaml" | kubectl_for "${HUB_KUBECONFIG}" apply -f - >/dev/null
kubectl_for "${HUB_KUBECONFIG}" -n workers-api-system rollout status deployment/workers-api --timeout=3m

"${API_DIR}/verify.sh"
