#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)
NAMESPACE=${LLMGATEWAY_K8S_NAMESPACE:-llmgateway-kro-demo}
SET_ID=${LLMGATEWAY_VELAGWSET_E2E_SET_ID:-operator-e2e}
DATABASE_NAME="newapi_${SET_ID//-/_}"
REDIS_DB=${LLMGATEWAY_VELAGWSET_E2E_REDIS_DB:-8}
IMAGE=${LLMGATEWAY_VELAGWSET_E2E_NEWAPI_IMAGE:-calciumion/new-api@sha256:3125e24f119fa5e767563226a5208f2902b3faed3f27b69ea275b32c9f04a066}
RUNTIME_SECRET="${SET_ID}-runtime"

approve_and_delete() {
  if ! kubectl -n "$NAMESPACE" get vgs "$SET_ID" >/dev/null 2>&1; then
    return
  fi
  local uid approved_at fleet shard database redis_db patch
  uid=$(kubectl -n "$NAMESPACE" get vgs "$SET_ID" -o jsonpath='{.metadata.uid}')
  fleet=$(kubectl -n "$NAMESPACE" get vgs "$SET_ID" -o jsonpath='{.spec.fleetRef}')
  shard=$(kubectl -n "$NAMESPACE" get vgs "$SET_ID" -o jsonpath='{.spec.shardRef}')
  database=$(kubectl -n "$NAMESPACE" get vgs "$SET_ID" -o jsonpath='{.spec.databaseName}')
  redis_db=$(kubectl -n "$NAMESPACE" get vgs "$SET_ID" -o jsonpath='{.spec.redisDB}')
  approved_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  patch=$(jq -nc \
    --arg uid "$uid" --arg approved "$approved_at" --arg fleet "$fleet" \
    --arg shard "$shard" --arg database "$database" --argjson redisDB "$redis_db" \
    '{spec:{decommissionApproval:{requestID:"orbstack-e2e",attempt:1,approvedAt:$approved,crUID:$uid,fleetRef:$fleet,shardRef:$shard,databaseName:$database,redisDB:$redisDB}}}')
  kubectl -n "$NAMESPACE" patch vgs "$SET_ID" --type=merge -p "$patch" >/dev/null
  kubectl -n "$NAMESPACE" delete vgs "$SET_ID" --wait=true --timeout=90s >/dev/null
}

cleanup_fixture() {
  approve_and_delete || true
  kubectl -n "$NAMESPACE" delete secret "$RUNTIME_SECRET" --ignore-not-found >/dev/null
}
trap cleanup_fixture EXIT

if [[ $(kubectl config current-context) != "orbstack" ]]; then
  echo "current Kubernetes context must be orbstack" >&2
  exit 1
fi

cleanup_fixture
docker build -f "$ROOT_DIR/k8s/orbstack-kro/Dockerfile.velagwset-controller" \
  -t llmgateway:velagwset-local "$ROOT_DIR" >/dev/null
kubectl apply -f "$ROOT_DIR/deploy/k8s/prod/velagwset-crd.yaml" >/dev/null
kubectl apply -f "$ROOT_DIR/deploy/k8s/prod/velagwset-delete-policy.yaml" >/dev/null
kubectl apply -f "$ROOT_DIR/k8s/orbstack-kro/55-velagwset-controller.yaml" >/dev/null
kubectl -n "$NAMESPACE" rollout restart deployment/velagwset-controller >/dev/null
kubectl -n "$NAMESPACE" rollout status deployment/velagwset-controller --timeout=120s >/dev/null

if kubectl apply --dry-run=server -f - >/dev/null 2>&1 <<EOF
apiVersion: gateway.lightvela.com/v1alpha1
kind: VelaGWSet
metadata:
  name: mutable-image-must-fail
  namespace: ${NAMESPACE}
spec:
  fleetRef: local
  shardRef: shard-a
  databaseName: newapi_mutable_image
  redisDB: 254
  runtimeSecretRef: {name: unused}
  managementPolicy: Managed
  admin: {image: calciumion/new-api:latest}
  trafficRuntimes:
    - {generation: 1, image: calciumion/new-api:latest, replicas: 1}
EOF
then
  echo "mutable new-api image was accepted by the VelaGWSet CRD" >&2
  exit 1
fi

kubectl -n "$NAMESPACE" exec deployment/shared-mysql-a -- mysql -uroot -p123456 \
  -e "CREATE DATABASE IF NOT EXISTS \`${DATABASE_NAME}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;" >/dev/null
kubectl -n "$NAMESPACE" create secret generic "$RUNTIME_SECRET" \
  --from-literal=SQL_DSN="root:123456@tcp(shared-mysql-a:3306)/${DATABASE_NAME}?parseTime=true&loc=Local" \
  --from-literal=REDIS_CONN_STRING="redis://:123456@shared-redis-a:6379/${REDIS_DB}" \
  --from-literal=SESSION_SECRET="velagwset-${SET_ID}-session-secret" \
  --from-literal=SQL_MAX_OPEN_CONNS=16 \
  --from-literal=SQL_MAX_IDLE_CONNS=2 \
  --from-literal=SQL_MAX_LIFETIME=60 \
  --from-literal=SUBSCRIPTION_WRITE_CONCURRENCY=8 >/dev/null

kubectl apply -f - >/dev/null <<EOF
apiVersion: gateway.lightvela.com/v1alpha1
kind: VelaGWSet
metadata:
  name: ${SET_ID}
  namespace: ${NAMESPACE}
spec:
  fleetRef: local
  shardRef: shard-a
  databaseName: ${DATABASE_NAME}
  redisDB: ${REDIS_DB}
  runtimeSecretRef: {name: ${RUNTIME_SECRET}}
  managementPolicy: Managed
  scheduling: {priorityClassName: system-node-critical}
  admin: {image: ${IMAGE}}
  trafficRuntimes:
    - {generation: 1, image: ${IMAGE}, replicas: 2}
EOF

kubectl -n "$NAMESPACE" wait --for=condition=Ready "vgs/${SET_ID}" --timeout=240s >/dev/null

if kubectl -n "$NAMESPACE" patch vgs "$SET_ID" --type=merge --dry-run=server \
  -p '{"spec":{"managementPolicy":"Observe"}}' >/dev/null 2>&1; then
  echo "Managed VelaGWSet was allowed to downgrade to Observe" >&2
  exit 1
fi

if kubectl -n "$NAMESPACE" patch vgs "$SET_ID" --type=merge --dry-run=server \
  -p '{"spec":{"trafficRuntimes":[{"generation":1,"image":"calciumion/new-api@sha256:0000000000000000000000000000000000000000000000000000000000000000","replicas":2}]}}' >/dev/null 2>&1; then
  echo "traffic runtime image was mutable within an existing generation" >&2
  exit 1
fi

traffic_deployment="local-${SET_ID}-g1-newapi-traffic"
admin_deployment="local-${SET_ID}-newapi-admin-master"
before=$(kubectl -n "$NAMESPACE" get deploy "$traffic_deployment" "$admin_deployment" -o json | jq -c '[.items[]|{name:.metadata.name,generation:.metadata.generation}]|sort_by(.name)')
sleep 5
after=$(kubectl -n "$NAMESPACE" get deploy "$traffic_deployment" "$admin_deployment" -o json | jq -c '[.items[]|{name:.metadata.name,generation:.metadata.generation}]|sort_by(.name)')
[[ "$before" == "$after" ]] || { echo "Deployment generation did not stabilize" >&2; exit 1; }

traffic_service="local-${SET_ID}-g1-newapi-traffic"
old_uid=$(kubectl -n "$NAMESPACE" get svc "$traffic_service" -o jsonpath='{.metadata.uid}')
kubectl -n "$NAMESPACE" delete svc "$traffic_service" --wait=true >/dev/null
for _ in $(seq 1 30); do
  new_uid=$(kubectl -n "$NAMESPACE" get svc "$traffic_service" -o jsonpath='{.metadata.uid}' 2>/dev/null || true)
  [[ -n "$new_uid" && "$new_uid" != "$old_uid" ]] && break
  sleep 1
done
[[ -n "${new_uid:-}" && "$new_uid" != "$old_uid" ]] || { echo "traffic Service was not healed" >&2; exit 1; }

lease=velagwset-controller.gateway.lightvela.com
old_holder=$(kubectl -n "$NAMESPACE" get lease "$lease" -o jsonpath='{.spec.holderIdentity}')
kubectl -n "$NAMESPACE" delete pod "${old_holder%%_*}" --wait=false >/dev/null
for _ in $(seq 1 45); do
  new_holder=$(kubectl -n "$NAMESPACE" get lease "$lease" -o jsonpath='{.spec.holderIdentity}' 2>/dev/null || true)
  [[ -n "$new_holder" && "$new_holder" != "$old_holder" ]] && break
  sleep 1
done
[[ -n "${new_holder:-}" && "$new_holder" != "$old_holder" ]] || { echo "controller leader did not fail over" >&2; exit 1; }

if kubectl -n "$NAMESPACE" delete vgs "$SET_ID" --dry-run=server >/dev/null 2>&1; then
  echo "unapproved VelaGWSet deletion was not rejected" >&2
  exit 1
fi

approve_and_delete
if [[ -n $(kubectl -n "$NAMESPACE" get deploy,svc,pdb -l gateway.lightvela.com/set="$SET_ID" -o name) ]]; then
  echo "approved deletion left owned Kubernetes resources" >&2
  exit 1
fi

echo "VelaGWSet OrbStack E2E passed: Ready, stable reconcile, self-heal, leader failover, protected deletion"
