#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
cells_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
source "$cells_dir/deploy/local/mesh/lib.sh"

namespace=worker-registry-fdb-cos-e2e
image=${WORKER_REGISTRY_IMAGE:-rivet/worker-registry:fdb-cos-e2e}
local_port=${WORKER_REGISTRY_E2E_PORT:-18089}
fdb_key_prefix="local-fdb-cos-e2e-$(date +%s)-$$"
port_forward_pid=

cleanup() {
	status=$?
	if (( status != 0 )); then
		kubectl_for "$RUNTIME_A_KUBECONFIG" -n "$namespace" logs -l app=worker-registry \
			--tail=200 --prefix 2>/dev/null || true
	fi
	if [[ -n ${port_forward_pid} ]]; then
		kill "${port_forward_pid}" 2>/dev/null || true
	fi
	kubectl_for "$RUNTIME_A_KUBECONFIG" -n actor-fdb-cell-system delete networkpolicy \
		worker-registry-fdb-cos-e2e --ignore-not-found >/dev/null 2>&1 || true
	kubectl_for "$RUNTIME_A_KUBECONFIG" delete namespace "$namespace" --ignore-not-found --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

start_port_forward() {
	if [[ -n ${port_forward_pid} ]]; then
		kill "$port_forward_pid" 2>/dev/null || true
		wait "$port_forward_pid" 2>/dev/null || true
	fi
	kubectl_for "$RUNTIME_A_KUBECONFIG" -n "$namespace" port-forward service/worker-registry \
		"$local_port:8080" >/tmp/worker-registry-fdb-cos-e2e-port-forward.log 2>&1 &
	port_forward_pid=$!
	for _ in $(seq 1 60); do
		if curl -fsS "http://127.0.0.1:$local_port/readyz" >/dev/null 2>&1; then return; fi
		sleep 1
	done
	curl -fsS "http://127.0.0.1:$local_port/readyz" >/dev/null
}

kubectl_for "$RUNTIME_A_KUBECONFIG" delete namespace "$namespace" --ignore-not-found --wait=true >/dev/null
kubectl_for "$RUNTIME_A_KUBECONFIG" create namespace "$namespace" >/dev/null
kubectl_for "$RUNTIME_A_KUBECONFIG" apply -f "$script_dir/fdb-access.yaml" >/dev/null

if [[ ${WORKER_REGISTRY_E2E_SKIP_BUILD:-false} != true ]]; then
	"$cells_dir/deploy/local/worker-registry/build-local-image.sh" "$image" >/dev/null
fi
k3d image import "$image" --cluster "$RUNTIME_A_CLUSTER" >/dev/null

cluster_file=$(kubectl_for "$RUNTIME_A_KUBECONFIG" -n actor-fdb-cell-system get configmap local-runtime-a-config -o jsonpath='{.data.cluster-file}')
kubectl_for "$RUNTIME_A_KUBECONFIG" -n "$namespace" create configmap worker-registry-fdb \
	--from-literal=fdb.cluster="$cluster_file" >/dev/null
kubectl_for "$RUNTIME_A_KUBECONFIG" -n "$namespace" create configmap fake-cos \
	--from-file=fake_cos.py="$script_dir/fake_cos.py" >/dev/null
sed -e "s|__WORKER_REGISTRY_IMAGE__|$image|g" \
	-e "s|__FDB_KEY_PREFIX__|$fdb_key_prefix|g" "$script_dir/resources.yaml" | \
	kubectl_for "$RUNTIME_A_KUBECONFIG" -n "$namespace" apply -f - >/dev/null
kubectl_for "$RUNTIME_A_KUBECONFIG" -n "$namespace" rollout status deployment/fake-cos --timeout=3m >/dev/null
kubectl_for "$RUNTIME_A_KUBECONFIG" -n "$namespace" rollout status deployment/worker-registry --timeout=3m >/dev/null

start_port_forward

before=$(python3 "$script_dir/verify.py" "http://127.0.0.1:$local_port")
version_a=$(jq -r .version_a <<<"$before")
version_b=$(jq -r .version_b <<<"$before")
active_deployment_id=$(jq -r .active_deployment_id <<<"$before")
historical_deployment_id=$(jq -r .historical_deployment_id <<<"$before")

kubectl_for "$RUNTIME_A_KUBECONFIG" -n "$namespace" rollout restart deployment/worker-registry >/dev/null
kubectl_for "$RUNTIME_A_KUBECONFIG" -n "$namespace" rollout status deployment/worker-registry --timeout=3m >/dev/null
start_port_forward
python3 "$script_dir/verify_after_restart.py" "http://127.0.0.1:$local_port" "$version_a" "$version_b" \
	"$active_deployment_id" "$historical_deployment_id"

object_count=$(kubectl_for "$RUNTIME_A_KUBECONFIG" -n "$namespace" exec deploy/fake-cos -- \
	wget -qO- http://127.0.0.1:8080/__count)
[[ $object_count == 7 ]]
printf '%s\n' "$before"
printf '%s\n' '{"worker_registry_fdb_cos_e2e":"PASS","immutable_objects":7,"version_retention":5,"gc_mode":"report_only","durable_delete":"fail_closed"}'
