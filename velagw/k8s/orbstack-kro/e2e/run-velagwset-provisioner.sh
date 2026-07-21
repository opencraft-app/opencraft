#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../../.." && pwd)"
NAMESPACE="llmgateway-kro-demo"
CONTROL_PORT="${LLMGATEWAY_NATIVE_CONTROL_PORT:-18091}"
IMAGE="calciumion/new-api@sha256:3125e24f119fa5e767563226a5208f2902b3faed3f27b69ea275b32c9f04a066"
SET_PREFIX="native-e2e-$(date +%s)"

if [[ "$(kubectl config current-context)" != "orbstack" ]]; then
  echo "current Kubernetes context must be orbstack" >&2
  exit 1
fi

BUILD_LOG="$(mktemp -t velagwset-provisioner-build.XXXXXX)"
if ! docker build --progress=plain -t llmgateway:local "$ROOT_DIR" >"$BUILD_LOG" 2>&1; then
  cat "$BUILD_LOG" >&2
  exit 1
fi
rm -f "$BUILD_LOG"
kubectl apply -f "$ROOT_DIR/deploy/k8s/prod/velagwset-crd.yaml" >/dev/null
kubectl apply -f "$ROOT_DIR/k8s/orbstack-kro/41-native-fleet.yaml" >/dev/null
kubectl apply -f "$ROOT_DIR/k8s/orbstack-kro/55-velagwset-controller.yaml" >/dev/null
kubectl apply -f "$ROOT_DIR/k8s/orbstack-kro/56-velagwset-provisioner.yaml" >/dev/null
for deployment in llmgateway-control llmgateway-worker-core velagwset-controller velagwset-provisioner; do
  kubectl rollout restart deployment/"$deployment" -n "$NAMESPACE" >/dev/null
  kubectl rollout status deployment/"$deployment" -n "$NAMESPACE" --timeout=240s >/dev/null
done

kubectl port-forward -n "$NAMESPACE" svc/llmgateway-control "$CONTROL_PORT:18080" >/tmp/velagwset-provisioner-port-forward.log 2>&1 &
PORT_FORWARD_PID=$!
cleanup() {
  kill "$PORT_FORWARD_PID" >/dev/null 2>&1 || true
  wait "$PORT_FORWARD_PID" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM
control_ready=false
for _ in $(seq 1 60); do
  if ! kill -0 "$PORT_FORWARD_PID" >/dev/null 2>&1; then
    cat /tmp/velagwset-provisioner-port-forward.log >&2
    exit 1
  fi
  if curl -fsS "http://127.0.0.1:${CONTROL_PORT}/readyz" >/dev/null 2>&1; then
    control_ready=true
    break
  fi
  sleep 1
done
if [[ "$control_ready" != "true" ]]; then
  echo "llmgateway-control did not become ready" >&2
  cat /tmp/velagwset-provisioner-port-forward.log >&2
  exit 1
fi

admin() {
  curl -fsS "http://127.0.0.1:${CONTROL_PORT}$1" \
    -H 'Authorization: Bearer dev-cluster-token' -H 'Content-Type: application/json' "${@:2}"
}

admin /api/admin/newapi-releases -X POST -d "{\"id\":\"native-e2e-release\",\"source\":\"kro\",\"namespace\":\"${NAMESPACE}\",\"fleet\":\"fleet-native\",\"version\":\"e2e\",\"image\":\"${IMAGE}\",\"status\":\"stable\"}" >/dev/null || true
admin /api/admin/release-rings -X POST -d "{\"id\":\"native-e2e-ring\",\"source\":\"kro\",\"namespace\":\"${NAMESPACE}\",\"fleet\":\"fleet-native\",\"name\":\"Native E2E\",\"ordinal\":10,\"serving_release_id\":\"native-e2e-release\",\"admission_enabled\":true}" >/dev/null

result="$(admin /api/admin/set-capacity/reconcile -X POST -d "{\"source\":\"kro\",\"namespace\":\"${NAMESPACE}\",\"fleet\":\"fleet-native\",\"shard_refs\":[\"shard-a\"],\"min_warm_sets\":1,\"min_ready_free_users\":100000,\"max_scale_up_per_cycle\":1,\"max_users_per_set\":100,\"set_id_prefix\":\"${SET_PREFIX}\",\"redis_db_start\":10,\"redis_db_limit\":16,\"runtime_backend\":\"velagwset\",\"writer_epoch\":1}")"
request_id="$(printf '%s' "$result" | jq -er '.data.requests[0].id // empty')"
set_id="$(printf '%s' "$result" | jq -er '.data.requests[0].set_id // empty')"
if [[ -z "$request_id" || -z "$set_id" ]]; then
  echo "capacity response did not contain a request: $result" >&2
  exit 1
fi

deadline=$((SECONDS + 600))
state=""
while (( SECONDS < deadline )); do
  state="$(admin "/api/admin/set-provision-requests?set_id=${set_id}" | jq -er --arg id "$request_id" '.data[] | select(.id == $id) | .status' 2>/dev/null || true)"
  if [[ "$state" == "managed" ]]; then break; fi
  if [[ "$state" == "error" || "$state" == "cancelled" ]]; then
    echo "request entered terminal state $state" >&2
    exit 1
  fi
  sleep 5
done

if [[ "$state" != "managed" ]]; then
  echo "request $request_id did not become managed; last state=${state:-missing}" >&2
  admin "/api/admin/set-provision-requests?set_id=${set_id}" >&2 || true
  kubectl get velagwset "$set_id" -n "$NAMESPACE" -o yaml >&2 || true
  exit 1
fi
kubectl wait --for=jsonpath='{.status.conditions[?(@.type=="Ready")].status}'=True \
  velagwset/"$set_id" -n "$NAMESPACE" --timeout=120s >/dev/null
if ! kubectl get llmfleet fleet-native -n "$NAMESPACE" -o json | jq -e '.spec.sets | length == 0' >/dev/null; then
  echo "fleet-native.spec.sets must remain empty on the VelaGWSet backend" >&2
  exit 1
fi
echo "VelaGWSet provisioner E2E passed: request=$request_id set=$set_id"
