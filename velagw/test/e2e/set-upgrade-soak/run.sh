#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAMESPACE="${LLMGATEWAY_SOAK_NAMESPACE:-llmgateway-kro-demo}"
FLEET="${LLMGATEWAY_SOAK_FLEET:-fleet-demo}"
: "${LLMGATEWAY_SOAK_TARGET_SET:?set LLMGATEWAY_SOAK_TARGET_SET to the canary Set ID}"
: "${LLMGATEWAY_SOAK_RUNNER_IMAGE:?set LLMGATEWAY_SOAK_RUNNER_IMAGE to the llmgateway image containing the soak runner}"

wait_for_job() {
  timeout_seconds=$1
  deadline=$(( $(date +%s) + timeout_seconds ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    succeeded=$(kubectl -n "$NAMESPACE" get job llmgateway-upgrade-soak -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
    failed=$(kubectl -n "$NAMESPACE" get job llmgateway-upgrade-soak -o jsonpath='{.status.failed}' 2>/dev/null || true)
    if [ "${succeeded:-0}" -ge 1 ]; then
      return 0
    fi
    if [ "${failed:-0}" -ge 1 ]; then
      return 1
    fi
    sleep 3
  done
  return 1
}

TARGET_IMAGE="${LLMGATEWAY_SOAK_TARGET_IMAGE:-}"
if [ -z "$TARGET_IMAGE" ]; then
  TARGET_IMAGE=$(kubectl -n "$NAMESPACE" get llmfleet "$FLEET" -o jsonpath='{.spec.newapiImage}')
fi

rendered=$(mktemp)
trap 'rm -f "$rendered"' EXIT INT TERM

sed \
  -e "s|__NAMESPACE__|$NAMESPACE|g" \
  -e "s|__RUNNER_IMAGE__|$LLMGATEWAY_SOAK_RUNNER_IMAGE|g" \
  -e "s|__IMAGE_PULL_POLICY__|${LLMGATEWAY_SOAK_IMAGE_PULL_POLICY:-IfNotPresent}|g" \
  -e "s|__CONTROL_URL__|${LLMGATEWAY_CONTROL_URL:-http://llmgateway-control:18080}|g" \
  -e "s|__TRAFFIC_URL__|${LLMGATEWAY_TRAFFIC_URL:-http://llmgateway-traffic:18080}|g" \
  -e "s|__MOCK_URL__|${LLMGATEWAY_SOAK_MOCK_URL:-http://llmgateway-e2e-mock-openai:8080}|g" \
  -e "s|__FLEET__|$FLEET|g" \
  -e "s|__SOURCE__|${LLMGATEWAY_SOAK_SOURCE:-kro}|g" \
  -e "s|__TARGET_SET__|$LLMGATEWAY_SOAK_TARGET_SET|g" \
  -e "s|__TARGET_IMAGE__|$TARGET_IMAGE|g" \
  -e "s|__GENERATIONS__|${LLMGATEWAY_SOAK_GENERATIONS:-4}|g" \
  -e "s|__USERS__|${LLMGATEWAY_SOAK_USERS:-400}|g" \
  -e "s|__SSE_USERS__|${LLMGATEWAY_SOAK_SSE_USERS:-100}|g" \
  -e "s|__USER_CONCURRENCY__|${LLMGATEWAY_SOAK_USER_CONCURRENCY:-20}|g" \
  -e "s|__NORMAL_INTERVAL__|${LLMGATEWAY_SOAK_NORMAL_INTERVAL:-10s}|g" \
  -e "s|__SSE_DURATION__|${LLMGATEWAY_SOAK_SSE_DURATION:-20s}|g" \
  -e "s|__MIN_SSE_DURATION__|${LLMGATEWAY_SOAK_MIN_SSE_DURATION:-19s}|g" \
  -e "s|__WARMUP__|${LLMGATEWAY_SOAK_WARMUP:-30s}|g" \
  -e "s|__DRAIN_TIMEOUT__|${LLMGATEWAY_SOAK_DRAIN_TIMEOUT:-330s}|g" \
  -e "s|__ROLLBACK_WINDOW__|${LLMGATEWAY_SOAK_ROLLBACK_WINDOW:-300s}|g" \
  -e "s|__MANAGER_TIMEOUT__|${LLMGATEWAY_SOAK_MANAGER_TIMEOUT:-15m}|g" \
  -e "s|__MANAGER_CRONJOB__|${LLMGATEWAY_SOAK_MANAGER_CRONJOB:-llmgateway-set-manager}|g" \
  -e "s|__MODEL__|${LLMGATEWAY_SOAK_MODEL:-llmgw-upgrade-soak}|g" \
  -e "s|__UPSTREAM_MODEL__|${LLMGATEWAY_SOAK_UPSTREAM_MODEL:-llmgw-k8s-chat}|g" \
  -e "s|__ADMIN_SECRET__|${LLMGATEWAY_SOAK_ADMIN_SECRET:-llmgateway-control-admin}|g" \
  -e "s|__ADMIN_SECRET_KEY__|${LLMGATEWAY_SOAK_ADMIN_SECRET_KEY:-token}|g" \
  -e "s|__INTERNAL_SECRET__|${LLMGATEWAY_SOAK_INTERNAL_SECRET:-llmgateway-control-admin}|g" \
  -e "s|__INTERNAL_SECRET_KEY__|${LLMGATEWAY_SOAK_INTERNAL_SECRET_KEY:-internal-token}|g" \
  "$SCRIPT_DIR/manifest.yaml.template" >"$rendered"

kubectl -n "$NAMESPACE" delete job llmgateway-upgrade-soak --ignore-not-found --wait=true >/dev/null
kubectl apply -f "$rendered"

if ! wait_for_job "${LLMGATEWAY_SOAK_WAIT_TIMEOUT_SECONDS:-14400}"; then
  kubectl -n "$NAMESPACE" logs job/llmgateway-upgrade-soak --all-containers=true || true
  exit 1
fi
kubectl -n "$NAMESPACE" logs job/llmgateway-upgrade-soak --all-containers=true
