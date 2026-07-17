#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../../.." && pwd)
LOCAL_E2E_DIR="$ROOT_DIR/k8s/orbstack-kro/e2e"
NAMESPACE="${LLMGATEWAY_PROD_NAMESPACE:-llmgateway}"
JOB_NAME="${LLMGATEWAY_PROD_SMOKE_JOB:-llmgateway-traffic-e2e}"
TMP_DIR="$(mktemp -d)"
MOCK_URL="${LLMGATEWAY_PROD_SMOKE_MOCK_URL:-}"
MODEL="${LLMGATEWAY_PROD_SMOKE_MODEL:-}"
UPSTREAM_KEY="${LLMGATEWAY_PROD_SMOKE_UPSTREAM_KEY:-}"
EXPECTED_MARKER="${LLMGATEWAY_PROD_SMOKE_EXPECTED_MARKER:-}"

cleanup() {
  rm -rf "$TMP_DIR"
}
trap cleanup EXIT

render_common() {
  sed \
    -e "s/namespace: llmgateway-kro-demo/namespace: $NAMESPACE/g" \
    -e "s/app.kubernetes.io\\/part-of: llmgateway-kro-demo/app.kubernetes.io\\/part-of: llmgateway/g" \
    "$1"
}

if [ -z "$MOCK_URL" ] && kubectl -n "$NAMESPACE" get service cloud-mockllm >/dev/null 2>&1; then
  MOCK_URL="http://cloud-mockllm:8080"
  MODEL="${MODEL:-llmgw-mock-chat}"
  UPSTREAM_KEY="${UPSTREAM_KEY:-sk-cloud-mock}"
  EXPECTED_MARKER="${EXPECTED_MARKER:-cloud mock answer}"
fi

if [ -z "$MOCK_URL" ]; then
  MOCK_URL="http://llmgateway-e2e-mock-openai:8080"
  MODEL="${MODEL:-llmgw-k8s-chat}"
  UPSTREAM_KEY="${UPSTREAM_KEY:-sk-k8s-e2e}"
  EXPECTED_MARKER="${EXPECTED_MARKER:-llmgateway k8s e2e}"
  render_common "$LOCAL_E2E_DIR/00-mock-openai.yaml" > "$TMP_DIR/00-mock-openai.yaml"
  kubectl apply -f "$TMP_DIR/00-mock-openai.yaml"
  kubectl rollout status deployment/llmgateway-e2e-mock-openai -n "$NAMESPACE" --timeout=180s
else
  MODEL="${MODEL:-llmgw-mock-chat}"
  UPSTREAM_KEY="${UPSTREAM_KEY:-sk-cloud-mock}"
  EXPECTED_MARKER="${EXPECTED_MARKER:-cloud mock answer}"
fi

render_common "$LOCAL_E2E_DIR/10-traffic-e2e-job.yaml" \
  | sed \
      -e "s/name: llmgateway-control-admin/name: llmgateway-control-runtime/g" \
      -e "s/key: token/key: CLUSTER_ADMIN_TOKEN/g" \
  > "$TMP_DIR/10-traffic-e2e-job.yaml"

python3 - "$TMP_DIR/10-traffic-e2e-job.yaml" "$MOCK_URL" "$MODEL" "$UPSTREAM_KEY" "$EXPECTED_MARKER" <<'PY'
import sys
from pathlib import Path

path = Path(sys.argv[1])
mock_url, model, upstream_key, marker = sys.argv[2:6]
content = path.read_text()
content = content.replace("http://llmgateway-control:18080", "http://llmgateway-control")
content = content.replace("http://llmgateway-traffic:18080", "http://llmgateway-traffic")
content = content.replace("http://llmgateway-e2e-mock-openai:8080", mock_url)
content = content.replace("llmgw-k8s-chat", model)
content = content.replace("sk-k8s-e2e", upstream_key)
content = content.replace("llmgateway k8s e2e", marker)
content = content.replace("""          command:
            - go
            - run
            - /opt/llmgateway-e2e/main.go
""", """          command:
            - /bin/sh
            - -c
            - |
              go run /opt/llmgateway-e2e/main.go > /tmp/runner.log 2>&1
              code=$?
              tail -c 3800 /tmp/runner.log > /dev/termination-log
              cat /tmp/runner.log
              exit $code
""")
path.write_text(content)
PY

kubectl delete job "$JOB_NAME" -n "$NAMESPACE" --ignore-not-found
kubectl apply -f "$TMP_DIR/10-traffic-e2e-job.yaml"

if ! kubectl wait --for=condition=complete "job/$JOB_NAME" -n "$NAMESPACE" --timeout=360s; then
  kubectl logs -n "$NAMESPACE" "job/$JOB_NAME" || true
  exit 1
fi

kubectl logs -n "$NAMESPACE" "job/$JOB_NAME" || true
printf '\nProduction traffic smoke completed in namespace %s\n' "$NAMESPACE"
