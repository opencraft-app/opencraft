#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../../operations" && pwd)
if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
fi
ACTOR_IMAGE_LOCK_TOOL=$script_dir/../../gitops/image-seed/image-lock.py
# shellcheck source=../../gitops/image-seed/bind-inventory.sh
source "$script_dir/../../gitops/image-seed/bind-inventory.sh"
actor_image_inventory_require
actor_image_inventory_bind WORKER_REGISTRY_IMAGE worker-registry
actor_image_inventory_bind WORKERS_API_IMAGE workers-api
registry_image=$WORKER_REGISTRY_IMAGE
api_image=$WORKERS_API_IMAGE
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")
for image in "$registry_image" "$api_image"; do
	[[ $image =~ @sha256:[0-9a-f]{64}$ ]] || {
		echo "code-plane images must use immutable registry digests" >&2
		exit 2
	}
done
for secret in actor-fleet-tcr actor-bj-q01-runtime-cos actor-bj-q01-runtime-auth actor-bj-q01-fdb-tls; do
	kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system get secret "$secret" >/dev/null
done
[[ $(kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system get foundationdbcluster actor-bj-q01 \
	-o jsonpath='{.status.health.fullReplication}') == true ]]
cell_uid=$(kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system get rivetcell actor-bj-q01 \
	-o jsonpath='{.metadata.uid}')
[[ $cell_uid =~ ^[0-9a-f-]{36}$ ]] || {
	echo "qualification RivetCell UID is unavailable" >&2
	exit 1
}
ACTOR_IMAGE_PREFLIGHT_NAMESPACE=actor-fdb-cell-system \
	ACTOR_IMAGE_PREFLIGHT_NAME=q01-worker-registry \
	ACTOR_IMAGE_PREFLIGHT_IMAGE="$registry_image" \
	ACTOR_IMAGE_PREFLIGHT_PULL_SECRET=actor-fleet-tcr \
	ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR=fleet.actor.dev/control-pool=true \
	"$operations_dir/preflight-image-pull.sh" /usr/local/bin/worker-registry --help
ACTOR_IMAGE_PREFLIGHT_NAMESPACE=actor-fdb-cell-system \
	ACTOR_IMAGE_PREFLIGHT_NAME=q01-workers-api \
	ACTOR_IMAGE_PREFLIGHT_IMAGE="$api_image" \
	ACTOR_IMAGE_PREFLIGHT_PULL_SECRET=actor-fleet-tcr \
	ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR=fleet.actor.dev/control-pool=true \
	"$operations_dir/preflight-image-pull.sh" /usr/local/bin/workers-api --help
temporary=$(mktemp)
cleanup(){ rm -f -- "$temporary"; }
trap cleanup EXIT
sed -e "s|__WORKER_REGISTRY_IMAGE__|$registry_image|g" \
	-e "s|__WORKERS_API_IMAGE__|$api_image|g" \
	-e "s|__CELL_UID__|$cell_uid|g" "$script_dir/code-plane.yaml" >"$temporary"
if grep -q '__[A-Z_][A-Z_]*__' "$temporary"; then
	echo "code-plane manifest contains an unresolved placeholder" >&2
	exit 1
fi
kubectl "${kubeconfig_args[@]}" apply --server-side --dry-run=server \
	--field-manager=q01-code-plane -f "$temporary" >/dev/null
kubectl "${kubeconfig_args[@]}" apply --server-side \
	--field-manager=q01-code-plane -f "$temporary" >/dev/null
kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system rollout status \
	deployment/actor-bj-q01-worker-registry --timeout=10m
kubectl "${kubeconfig_args[@]}" -n actor-fdb-cell-system rollout status \
	deployment/actor-bj-q01-workers-api --timeout=10m
echo "q01 code plane converged"
