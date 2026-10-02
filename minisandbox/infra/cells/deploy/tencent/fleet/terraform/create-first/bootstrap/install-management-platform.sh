#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG}"
: "${ACTOR_PULL_CREDENTIAL_RECEIPT:?set ACTOR_PULL_CREDENTIAL_RECEIPT}"
: "${ACTOR_ARGOCD_HA_SOURCE:?set ACTOR_ARGOCD_HA_SOURCE}"
: "${ACTOR_MANAGEMENT_PLATFORM_RECEIPT:?set ACTOR_MANAGEMENT_PLATFORM_RECEIPT}"
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}

for command in jq kubectl "$python" sha256sum stat; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_CLUSTER_KUBECONFIG" "$ACTOR_PULL_CREDENTIAL_RECEIPT" \
	"$ACTOR_ARGOCD_HA_SOURCE" "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT"; do
	[[ $path == /* && $path != / ]] || { echo "management platform paths must be absolute and non-root" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_CLUSTER_KUBECONFIG" "$ACTOR_PULL_CREDENTIAL_RECEIPT" "$ACTOR_ARGOCD_HA_SOURCE"; do
	[[ -f $path && ! -L $path ]] || { echo "management platform input must be a regular non-symlink file: $path" >&2; exit 2; }
done
(( (8#$(stat -c '%a' "$ACTOR_CLUSTER_KUBECONFIG") & 8#077) == 0 )) || {
	echo "management kubeconfig must not be group/world accessible" >&2
	exit 2
}
receipt_parent=$(dirname -- "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT")
[[ -d $receipt_parent ]] || { echo "management platform receipt parent must already exist" >&2; exit 2; }

temporary=$(mktemp -d "$receipt_parent/.actor-management-platform.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"

"$python" "$script_dir/validate-management-platform-inputs.py" \
	--inventory "$ACTOR_TERRAFORM_INVENTORY" --images "$ACTOR_IMAGE_INVENTORY" \
	--pull-receipt "$ACTOR_PULL_CREDENTIAL_RECEIPT" >"$temporary/plan.json"
management_id=$(jq -er '.managementId' "$temporary/plan.json")
cluster_id=$(jq -er '.clusterId' "$temporary/plan.json")
cluster_uid=$(jq -er '.clusterUid' "$temporary/plan.json")
namespace_uid=$(jq -er '.argocdNamespaceUid' "$temporary/plan.json")
pull_secret_uid=$(jq -er '.argocdPullSecretUid' "$temporary/plan.json")
image_inventory_digest=$(jq -er '.imageInventoryDigest' "$temporary/plan.json")

"$python" "$fleet_dir/gitops/render_argocd_ha_install.py" \
	"$ACTOR_ARGOCD_HA_SOURCE" "$temporary/argocd.yaml" \
	--images "$ACTOR_IMAGE_INVENTORY" --receipt "$temporary/render-receipt.json" >/dev/null

kube=(kubectl --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG")
[[ $("${kube[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}') == "$cluster_uid" ]] || {
	echo "live management cluster UID differs from bootstrap evidence" >&2
	exit 1
}
[[ $("${kube[@]}" get namespace argocd -o jsonpath='{.metadata.uid}') == "$namespace_uid" ]] || {
	echo "live Argo namespace UID differs from pull bootstrap evidence" >&2
	exit 1
}
[[ $("${kube[@]}" -n argocd get secret actor-fleet-tcr -o jsonpath='{.metadata.uid}') == "$pull_secret_uid" ]] || {
	echo "live Argo pull Secret UID differs from pull bootstrap evidence" >&2
	exit 1
}

"${kube[@]}" apply --server-side --force-conflicts \
	--field-manager=actor-create-first-management \
	-f "$temporary/argocd.yaml" >/dev/null
for crd in applications.argoproj.io applicationsets.argoproj.io appprojects.argoproj.io; do
	"${kube[@]}" wait --for=condition=Established "crd/$crd" --timeout=3m >/dev/null
done

mapfile -t resources < <("$python" - "$temporary/argocd.yaml" <<'PY'
import sys,yaml
for item in yaml.safe_load_all(open(sys.argv[1])):
    if item and item.get("kind") in {"Deployment","StatefulSet"}:
        print(item["kind"].lower()+"\t"+item["metadata"]["name"])
for item in yaml.safe_load_all(open(sys.argv[1])):
    if item and item.get("kind") == "CustomResourceDefinition":
        print("customresourcedefinition\t"+item["metadata"]["name"])
PY
)
live_args=()
for resource in "${resources[@]}"; do
	IFS=$'\t' read -r kind name <<<"$resource"
	case "$kind" in
		deployment|statefulset)
			"${kube[@]}" -n argocd rollout status "$kind/$name" --timeout=10m >/dev/null
			output="$temporary/$kind-$name.json"
			"${kube[@]}" -n argocd get "$kind" "$name" -o json >"$output"
			;;
		customresourcedefinition)
			output="$temporary/crd-$name.json"
			"${kube[@]}" get crd "$name" -o json >"$output"
			;;
		*) echo "unknown rendered Argo resource kind: $kind" >&2; exit 1 ;;
	esac
	live_args+=(--live "$output")
done
"$python" "$script_dir/verify-management-platform-live.py" \
	--rendered "$temporary/argocd.yaml" --render-receipt "$temporary/render-receipt.json" \
	"${live_args[@]}" >"$temporary/live.json"

inputs=$(jq -cn \
	--arg pull "$(sha256sum "$ACTOR_PULL_CREDENTIAL_RECEIPT" | cut -d' ' -f1)" \
	--arg source "$(sha256sum "$ACTOR_ARGOCD_HA_SOURCE" | cut -d' ' -f1)" \
	--arg render "$(sha256sum "$temporary/render-receipt.json" | cut -d' ' -f1)" \
	'{pullCredentialReceiptSha256:$pull,argocdSourceSha256:$source,argocdRenderReceiptSha256:$render}')
receipt_temporary=$temporary/receipt.json
jq -cn --arg management "$management_id" --arg cluster_id "$cluster_id" \
	--arg cluster_uid "$cluster_uid" --arg namespace_uid "$namespace_uid" \
	--arg pull_uid "$pull_secret_uid" --arg images "$image_inventory_digest" \
	--argjson inputs "$inputs" --slurpfile live "$temporary/live.json" \
	'{schema:"actor-create-first-management-platform/v1",verdict:"passed",managementId:$management,
	  cluster:{id:$cluster_id,uid:$cluster_uid},imageInventoryDigest:$images,inputs:$inputs,
	  namespace:{name:"argocd",uid:$namespace_uid,pullSecretUid:$pull_uid},
	  argocd:{crds:$live[0].crds,workloads:$live[0].workloads}}' >"$receipt_temporary"

if [[ -e $ACTOR_MANAGEMENT_PLATFORM_RECEIPT ]]; then
	[[ -f $ACTOR_MANAGEMENT_PLATFORM_RECEIPT && ! -L $ACTOR_MANAGEMENT_PLATFORM_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT" || {
		echo "management platform receipt already exists with different content" >&2
		exit 1
	}
elif ! ln "$receipt_temporary" "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT" 2>/dev/null; then
	[[ -f $ACTOR_MANAGEMENT_PLATFORM_RECEIPT && ! -L $ACTOR_MANAGEMENT_PLATFORM_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT" || {
		echo "unable to publish immutable management platform receipt" >&2
		exit 1
	}
fi
chmod 0644 "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT"
printf 'management_platform=passed management=%s receipt=%s sha256=%s\n' \
	"$management_id" "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT" \
	"$(sha256sum "$ACTOR_MANAGEMENT_PLATFORM_RECEIPT" | cut -d' ' -f1)"
