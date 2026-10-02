#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
bootstrap_dir=$(CDPATH= cd -- "$script_dir/../../terraform/create-first/bootstrap" && pwd)
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}
: "${HUB_KUBECONFIG:?HUB_KUBECONFIG must name management cluster C kubeconfig}"
: "${ACTOR_TERRAFORM_INVENTORY:?ACTOR_TERRAFORM_INVENTORY is required}"
: "${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY is required}"
: "${ACTOR_PULL_CREDENTIAL_RECEIPT:?ACTOR_PULL_CREDENTIAL_RECEIPT is required}"
: "${ACTOR_MANAGEMENT_PLATFORM_RECEIPT:?ACTOR_MANAGEMENT_PLATFORM_RECEIPT is required}"
: "${ACTOR_MANAGEMENT_GIT_RECEIPT:?ACTOR_MANAGEMENT_GIT_RECEIPT is required}"
: "${ACTOR_MANAGEMENT_DESIRED_RECEIPT:?ACTOR_MANAGEMENT_DESIRED_RECEIPT must be a new absolute receipt path}"
ACTOR_DESIRED_PATH_PREFIX=${ACTOR_DESIRED_PATH_PREFIX:-cells}

for command in kubectl "$python" jq; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 1; }
done
[[ -s $HUB_KUBECONFIG ]] || { echo "management kubeconfig is missing: $HUB_KUBECONFIG" >&2; exit 2; }
[[ $ACTOR_MANAGEMENT_DESIRED_RECEIPT == /* && ! -e $ACTOR_MANAGEMENT_DESIRED_RECEIPT ]] || {
	echo "ACTOR_MANAGEMENT_DESIRED_RECEIPT must be a new absolute path" >&2
	exit 2
}

temporary=$(mktemp -d /data/tmp/actor-cell-management.XXXXXX)
receipt_stage=
cleanup() {
	[[ -z ${receipt_stage:-} ]] || rm -f -- "$receipt_stage"
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

ACTOR_CLUSTER_KUBECONFIG="$HUB_KUBECONFIG" \
	"$bootstrap_dir/check-management-git.sh" >"$temporary/management-git.json"
platform_digest=$(jq -er '.managementPlatformReceiptDigest' "$temporary/management-git.json")
management_git_digest=$(jq -er '.managementGitReceiptDigest' "$temporary/management-git.json")
cluster_uid=$(jq -er '.clusterUid' "$temporary/management-git.json")
ACTOR_DESIRED_REPO_URL=$(jq -er '.repository.url' "$temporary/management-git.json")

kubectl --kubeconfig "$HUB_KUBECONFIG" -n argocd get configmap argocd-cm -o json >"$temporary/argocd-cm.json"
"$python" "$script_dir/merge-resource-inclusions.py" \
	--existing-configmap "$temporary/argocd-cm.json" \
	--required-configmap "$script_dir/resource-inclusions.yaml" \
	--output "$temporary/resource-inclusions.yaml" >/dev/null
"$python" "$script_dir/render-management.py" \
	--repo-url "$ACTOR_DESIRED_REPO_URL" \
	--path-prefix "$ACTOR_DESIRED_PATH_PREFIX" \
	--platform-receipt-digest "$platform_digest" \
	--management-git-receipt-digest "$management_git_digest" \
	--cluster-uid "$cluster_uid" \
	--output "$temporary/management.yaml" >/dev/null

# The ConfigMap is shared with Argo itself. Keep every pre-existing inclusion
# and add only the two reviewed Cell kinds.
kubectl --kubeconfig "$HUB_KUBECONFIG" apply --server-side --force-conflicts \
	--field-manager=actor-cell-bootstrap -f "$temporary/resource-inclusions.yaml" >/dev/null
kubectl --kubeconfig "$HUB_KUBECONFIG" apply --server-side --force-conflicts \
	--field-manager=actor-cell-bootstrap -f "$temporary/management.yaml" >/dev/null

kubectl --kubeconfig "$HUB_KUBECONFIG" -n argocd get appproject actor-cell-bootstrap -o json >"$temporary/project.json"
kubectl --kubeconfig "$HUB_KUBECONFIG" -n argocd get appproject actor-cell-runtime -o json >"$temporary/runtime-project.json"
kubectl --kubeconfig "$HUB_KUBECONFIG" -n argocd get applicationset actor-cells -o json >"$temporary/appset.json"
for resource in "$temporary/project.json" "$temporary/runtime-project.json" "$temporary/appset.json"; do
	jq -e --arg platform "$platform_digest" --arg git "$management_git_digest" --arg cluster "$cluster_uid" '
	  .metadata.annotations["fleet.actor.dev/management-platform-receipt-digest"] == $platform and
	  .metadata.annotations["fleet.actor.dev/management-git-receipt-digest"] == $git and
	  .metadata.annotations["fleet.actor.dev/management-cluster-uid"] == $cluster
	' "$resource" >/dev/null || { echo "live Argo management resource lost platform identity" >&2; exit 1; }
done
mkdir -p "$(dirname -- "$ACTOR_MANAGEMENT_DESIRED_RECEIPT")"
jq -cn --arg platform "$platform_digest" --arg cluster "$cluster_uid" \
	--arg git "$management_git_digest" --arg repository "$ACTOR_DESIRED_REPO_URL" --arg path "$ACTOR_DESIRED_PATH_PREFIX" \
	--arg project_uid "$(jq -er '.metadata.uid' "$temporary/project.json")" \
	--arg runtime_project_uid "$(jq -er '.metadata.uid' "$temporary/runtime-project.json")" \
	--arg appset_uid "$(jq -er '.metadata.uid' "$temporary/appset.json")" \
	'{schema:"actor-management-desired-state/v1",verdict:"passed",
	  managementPlatformReceiptDigest:$platform,managementGitReceiptDigest:$git,managementClusterUid:$cluster,
	  repository:{url:$repository,pathPrefix:$path},
	  resources:{appProject:{name:"actor-cell-bootstrap",uid:$project_uid},
	    runtimeAppProject:{name:"actor-cell-runtime",uid:$runtime_project_uid},
	    applicationSet:{name:"actor-cells",uid:$appset_uid}}}' >"$temporary/receipt.json"
receipt_stage=$(mktemp "$(dirname -- "$ACTOR_MANAGEMENT_DESIRED_RECEIPT")/.management-desired-receipt.XXXXXX")
install -m 0644 "$temporary/receipt.json" "$receipt_stage"
ln "$receipt_stage" "$ACTOR_MANAGEMENT_DESIRED_RECEIPT" || {
	echo "unable to publish immutable management desired-state receipt" >&2
	exit 1
}
rm -f -- "$receipt_stage"
receipt_stage=
printf 'actor_cell_management=installed repository=%s path=%s\n' \
	"$ACTOR_DESIRED_REPO_URL" "$ACTOR_DESIRED_PATH_PREFIX"
