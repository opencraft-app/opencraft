#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../operations" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
cell=${RIVET_CELL_NAME:?RIVET_CELL_NAME must identify the exact pre-admission Cell}
datacenter=${RIVET_DATACENTER_NAME:-default}
registry_url=${QUALIFICATION_REGISTRY_URL:?QUALIFICATION_REGISTRY_URL must be the private regional Worker Registry URL}
kubeconfig_args=()
[[ -z ${KUBECONFIG:-} ]] || kubeconfig_args=(--kubeconfig "$KUBECONFIG")

[[ $cell =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ &&
   $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ &&
   $datacenter =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ &&
   $registry_url =~ ^https?://[A-Za-z0-9._:-]+$ ]] || {
	echo "qualification Workers API identity or private Registry URL is invalid" >&2
	exit 2
}

ACTOR_IMAGE_LOCK_TOOL=$script_dir/../gitops/image-seed/image-lock.py
# shellcheck source=../gitops/image-seed/bind-inventory.sh
source "$script_dir/../gitops/image-seed/bind-inventory.sh"
actor_image_inventory_require
actor_image_inventory_bind WORKERS_API_IMAGE workers-api
[[ $WORKERS_API_IMAGE =~ /actor-fleet/workers-api@sha256:[0-9a-f]{64}$ ]] || {
	echo "qualification Workers API image is not inventory-bound" >&2
	exit 2
}

cell_uid=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get rivetcell "$cell" -o jsonpath='{.metadata.uid}')
[[ $cell_uid =~ ^[0-9a-f-]{36}$ ]] || {
	echo "pre-admission Cell UID is unavailable" >&2
	exit 1
}
[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get foundationdbcluster "$cell" -o jsonpath='{.status.health.healthy}') == true &&
   $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get foundationdbcluster "$cell" -o jsonpath='{.status.health.fullReplication}') == true ]] || {
	echo "refusing qualification Code Plane on an unhealthy FoundationDB Cell" >&2
	exit 1
}
for secret in actor-fleet-tcr "${cell}-runtime-auth"; do
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret "$secret" >/dev/null
done

# The inventory can be cryptographically valid yet name an older binary whose
# CLI predates this manifest. Prove the exact immutable binary contract before
# replacing the currently running API.
ACTOR_IMAGE_PREFLIGHT_NAMESPACE=$namespace \
	ACTOR_IMAGE_PREFLIGHT_NAME="${cell}-qualification-api" \
	ACTOR_IMAGE_PREFLIGHT_IMAGE="$WORKERS_API_IMAGE" \
	ACTOR_IMAGE_PREFLIGHT_PULL_SECRET=actor-fleet-tcr \
	ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR=fleet.actor.dev/control-pool=true \
	ACTOR_IMAGE_PREFLIGHT_REQUIRED_OUTPUT=$'-engine-cell\n-max-concurrent-prepares\n-qualification-cell\n-qualification-cell-uid\n-qualification-datacenter' \
	"$operations_dir/preflight-image-pull.sh" /usr/local/bin/workers-api --help

temporary=$(mktemp /data/tmp/${cell}-qualification-workers-api.XXXXXX.yaml)
cleanup() { rm -f -- "$temporary"; }
trap cleanup EXIT INT TERM
sed -e "s|__CELL__|$cell|g" \
	-e "s|__CELL_UID__|$cell_uid|g" \
	-e "s|__NAMESPACE__|$namespace|g" \
	-e "s|__DATACENTER__|$datacenter|g" \
	-e "s|__REGISTRY_URL__|$registry_url|g" \
	-e "s|__WORKERS_API_IMAGE__|$WORKERS_API_IMAGE|g" \
	"$script_dir/qualification-workers-api.yaml" >"$temporary"
if grep -q '__[A-Z_][A-Z_]*__' "$temporary"; then
	echo "qualification Workers API manifest contains an unresolved placeholder" >&2
	exit 1
fi
deployment="${cell}-workers-api"
live=$(mktemp /data/tmp/${cell}-qualification-workers-api-live.XXXXXX.json)
trap 'rm -f -- "$temporary" "$live"' EXIT INT TERM
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "$deployment" -o json >"$live" 2>/dev/null && \
	jq -e '.spec.strategy.type == "Recreate"' "$live" >/dev/null; then
	jq -e --arg cell "$cell" '
	  .metadata.labels["fleet.actor.dev/cell-name"] == $cell and
	  .metadata.labels["fleet.actor.dev/component"] == "workers-api" and
	  .spec.selector.matchLabels == {
	    "fleet.actor.dev/cell-name":$cell,
	    "fleet.actor.dev/component":"workers-api"
	  } and
	  .spec.template.spec.serviceAccountName == ($cell + "-workers-api") and
	  any(.spec.template.spec.containers[];
	    .name == "workers-api" and any(.args[]?; . == ("--qualification-cell=" + $cell)))
	' "$live" >/dev/null || {
		echo "refusing to migrate a Workers API Deployment outside the qualification identity" >&2
		exit 1
	}
	# Upgrade the former singleton atomically. The three-replica qualification
	# API must preserve service while the immutable image is rolled.
	patch='{"spec":{"strategy":{"type":"RollingUpdate","rollingUpdate":{"maxUnavailable":1,"maxSurge":1}}}}'
	kubectl "${kubeconfig_args[@]}" -n "$namespace" patch deployment "$deployment" \
		--type=merge --patch "$patch" --dry-run=server >/dev/null
	kubectl "${kubeconfig_args[@]}" -n "$namespace" patch deployment "$deployment" \
		--type=merge --patch "$patch" >/dev/null
fi
kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts --dry-run=server \
	--field-manager=runtime-qualification-code-plane -f "$temporary" >/dev/null
kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
	--field-manager=runtime-qualification-code-plane -f "$temporary" >/dev/null
kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
	deployment/"$deployment" --timeout=10m
kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "$deployment" -o json | \
	python3 -c 'import json,sys; d=json.load(sys.stdin); spec=d["spec"]; s=spec["template"]["spec"]; c=s["containers"][0]; args=c["args"]; assert spec["replicas"]==3; assert spec["strategy"]=={"type":"RollingUpdate","rollingUpdate":{"maxSurge":1,"maxUnavailable":1}}; assert s["automountServiceAccountToken"] is False; assert c["image"]==sys.argv[1]; assert "--max-concurrent-prepares=4" in args; assert "--engine-cell="+sys.argv[2] in args; assert "--qualification-cell="+sys.argv[2] in args; assert "--qualification-cell-uid="+sys.argv[3] in args' "$WORKERS_API_IMAGE" "$cell" "$cell_uid"
echo "qualification_workers_api=ready cell=$cell uid=$cell_uid datacenter=$datacenter"
