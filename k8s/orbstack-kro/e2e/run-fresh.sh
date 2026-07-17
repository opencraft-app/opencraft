#!/usr/bin/env sh
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
ROOT_DIR=$(CDPATH= cd -- "$SCRIPT_DIR/../../.." && pwd)
KRO_DIR="$ROOT_DIR/k8s/orbstack-kro"
NAMESPACE="${LLMGATEWAY_K8S_NAMESPACE:-llmgateway-kro-demo}"

cd "$ROOT_DIR"

kubectl delete namespace "$NAMESPACE" --ignore-not-found
kubectl wait --for=delete "namespace/$NAMESPACE" --timeout=180s 2>/dev/null || true

docker build -t llmgateway:local .

kubectl apply -f "$KRO_DIR/00-namespace.yaml"
kubectl apply -f "$KRO_DIR/05-shared-infra.yaml"
kubectl apply -f "$KRO_DIR/06-llmgateway-control.yaml"
kubectl apply -f "$KRO_DIR/07-llmgateway-traffic.yaml"
kubectl apply -f "$KRO_DIR/08-llmgateway-worker.yaml"

kubectl rollout status deployment/shared-mysql-a -n "$NAMESPACE" --timeout=180s
kubectl rollout status deployment/shared-redis-a -n "$NAMESPACE" --timeout=90s
kubectl rollout status deployment/shared-mysql-b -n "$NAMESPACE" --timeout=180s
kubectl rollout status deployment/shared-redis-b -n "$NAMESPACE" --timeout=90s
kubectl rollout status deployment/llmgateway-mysql -n "$NAMESPACE" --timeout=180s
kubectl rollout status deployment/llmgateway-control -n "$NAMESPACE" --timeout=180s
kubectl rollout status deployment/llmgateway-traffic -n "$NAMESPACE" --timeout=180s
kubectl rollout status deployment/llmgateway-worker-maintenance -n "$NAMESPACE" --timeout=180s
kubectl rollout status deployment/llmgateway-worker-core -n "$NAMESPACE" --timeout=180s
kubectl rollout status deployment/llmgateway-worker-byok -n "$NAMESPACE" --timeout=180s
kubectl rollout status deployment/llmgateway-worker-observer -n "$NAMESPACE" --timeout=180s

kubectl apply -f "$KRO_DIR/30-llmfleet-rgd.yaml"
kubectl wait --for=condition=Ready rgd/llmfleets.llmgateway.io --timeout=180s
kubectl apply -f "$KRO_DIR/40-fleet.yaml"
kubectl apply -f "$KRO_DIR/50-set-manager.yaml"

kubectl wait --for=condition=Ready llmfleet/fleet-demo -n "$NAMESPACE" --timeout=360s
for deployment in $(kubectl get deployments -n "$NAMESPACE" -o name | grep 'newapi-admin-master\|newapi-traffic'); do
  kubectl rollout status "$deployment" -n "$NAMESPACE" --timeout=360s
done

kubectl delete job llmgateway-set-manager-fresh -n "$NAMESPACE" --ignore-not-found
kubectl create job llmgateway-set-manager-fresh -n "$NAMESPACE" --from=cronjob/llmgateway-set-manager
kubectl wait --for=condition=complete job/llmgateway-set-manager-fresh -n "$NAMESPACE" --timeout=360s
kubectl logs -n "$NAMESPACE" job/llmgateway-set-manager-fresh

deadline=$(( $(date +%s) + 180 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  passed=$(kubectl exec -n "$NAMESPACE" deployment/llmgateway-mysql -- \
    mysql -uroot -ptest-local-password -Nse "SELECT COUNT(*) FROM llmgateway.llmgateway_sets WHERE admission_status='passed'" 2>/dev/null || true)
  if [ "${passed:-0}" -ge 4 ]; then
    break
  fi
  sleep 3
done
if [ "${passed:-0}" -lt 4 ]; then
  kubectl logs -n "$NAMESPACE" deployment/llmgateway-worker-core --tail=200 || true
  echo "set admission did not reach 4 passed sets" >&2
  exit 1
fi

"$SCRIPT_DIR/run.sh"

printf '\nFresh K8s environment e2e completed in namespace %s\n' "$NAMESPACE"
