#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
NAMESPACE="${LLMGATEWAY_K8S_NAMESPACE:-llmgateway-kro-demo}"
REQUEST_JOB="${LLMGATEWAY_K8S_AUTOSCALE_REQUEST_JOB:-llmgateway-autoscale-request-e2e}"
MANAGER_JOB="${LLMGATEWAY_K8S_AUTOSCALE_MANAGER_JOB:-llmgateway-set-manager-autoscale}"
TRAFFIC_JOB="${LLMGATEWAY_K8S_AUTOSCALE_TRAFFIC_JOB:-llmgateway-traffic-autoscale-e2e}"
SET_PREFIX="${LLMGATEWAY_K8S_AUTOSCALE_SET_PREFIX:-set-e2e-$(date +%s)}"
REDIS_DB_START="${LLMGATEWAY_K8S_AUTOSCALE_REDIS_DB_START:-3}"
REDIS_DB_LIMIT="${LLMGATEWAY_K8S_AUTOSCALE_REDIS_DB_LIMIT:-16}"

"$SCRIPT_DIR/run.sh"

kubectl delete job "$REQUEST_JOB" -n "$NAMESPACE" --ignore-not-found
sed \
  -e "s/value: set-e2e/value: $SET_PREFIX/g" \
  -e "/name: LLMGATEWAY_E2E_REDIS_DB_START/{n;s/value: \".*\"/value: \"$REDIS_DB_START\"/;}" \
  -e "/name: LLMGATEWAY_E2E_REDIS_DB_LIMIT/{n;s/value: \".*\"/value: \"$REDIS_DB_LIMIT\"/;}" \
  "$SCRIPT_DIR/20-autoscale-request-job.yaml" | kubectl apply -f -
kubectl wait --for=condition=complete "job/$REQUEST_JOB" -n "$NAMESPACE" --timeout=180s
kubectl logs -n "$NAMESPACE" "job/$REQUEST_JOB"

kubectl delete job "$MANAGER_JOB" -n "$NAMESPACE" --ignore-not-found
kubectl create job "$MANAGER_JOB" -n "$NAMESPACE" --from=cronjob/llmgateway-set-manager
kubectl wait --for=condition=complete "job/$MANAGER_JOB" -n "$NAMESPACE" --timeout=360s
kubectl logs -n "$NAMESPACE" "job/$MANAGER_JOB"

deadline=$(( $(date +%s) + 180 ))
until kubectl run llmgateway-autoscale-ready-check --rm -i --restart=Never -n "$NAMESPACE" --image=curlimages/curl:8.8.0 --command -- \
  sh -c "curl -fsS -H 'Authorization: Bearer test-cluster-token' http://llmgateway-control:18080/api/sets | grep -Eq '\"id\":\"$SET_PREFIX-[^\"]*\"[^}]*\"setup\":true'"; do
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "timed out waiting for autoscaled set to become managed" >&2
    exit 1
  fi
  sleep 5
done

kubectl delete job "$TRAFFIC_JOB" -n "$NAMESPACE" --ignore-not-found
sed "s/value: set-e2e/value: $SET_PREFIX/g" "$SCRIPT_DIR/30-traffic-autoscale-e2e-job.yaml" | kubectl apply -f -
kubectl wait --for=condition=complete "job/$TRAFFIC_JOB" -n "$NAMESPACE" --timeout=300s
kubectl logs -n "$NAMESPACE" "job/$TRAFFIC_JOB"

printf '\nK8s autoscale e2e completed in namespace %s\n' "$NAMESPACE"
