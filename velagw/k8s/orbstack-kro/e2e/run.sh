#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
NAMESPACE="${LLMGATEWAY_K8S_NAMESPACE:-llmgateway-kro-demo}"
JOB_NAME="${LLMGATEWAY_K8S_E2E_JOB:-llmgateway-traffic-e2e}"

wait_for_job() {
  job_name=$1
  timeout_seconds=$2
  deadline=$(( $(date +%s) + timeout_seconds ))
  while [ "$(date +%s)" -lt "$deadline" ]; do
    succeeded=$(kubectl get job "$job_name" -n "$NAMESPACE" -o jsonpath='{.status.succeeded}' 2>/dev/null || true)
    failed=$(kubectl get job "$job_name" -n "$NAMESPACE" -o jsonpath='{.status.failed}' 2>/dev/null || true)
    if [ "${succeeded:-0}" -ge 1 ]; then
      return 0
    fi
    if [ "${failed:-0}" -ge 1 ]; then
      kubectl logs -n "$NAMESPACE" "job/$job_name" --all-containers=true || true
      return 1
    fi
    sleep 2
  done
  kubectl logs -n "$NAMESPACE" "job/$job_name" --all-containers=true || true
  return 1
}

kubectl apply -f "$SCRIPT_DIR/00-mock-openai.yaml"
kubectl rollout restart deployment/llmgateway-e2e-mock-openai -n "$NAMESPACE" >/dev/null
kubectl rollout status deployment/llmgateway-e2e-mock-openai -n "$NAMESPACE" --timeout=120s

kubectl delete job "$JOB_NAME" -n "$NAMESPACE" --ignore-not-found
kubectl apply -f "$SCRIPT_DIR/10-traffic-e2e-job.yaml"
wait_for_job "$JOB_NAME" 300
kubectl logs -n "$NAMESPACE" "job/$JOB_NAME"

printf '\nK8s traffic e2e completed from %s\n' "$ROOT_DIR"
