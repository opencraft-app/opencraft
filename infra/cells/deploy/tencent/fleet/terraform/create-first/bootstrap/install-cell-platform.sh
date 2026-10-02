#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG}"
: "${ACTOR_PULL_CREDENTIAL_RECEIPT:?set ACTOR_PULL_CREDENTIAL_RECEIPT}"
: "${ACTOR_STORAGE_CREDENTIAL_RECEIPT:?set ACTOR_STORAGE_CREDENTIAL_RECEIPT}"
: "${ACTOR_FDB_TLS_RECEIPT:?set ACTOR_FDB_TLS_RECEIPT}"
: "${ACTOR_REGIONAL_PROFILE:?set ACTOR_REGIONAL_PROFILE}"
: "${ACTOR_REGIONAL_PROFILE_RECEIPT:?set ACTOR_REGIONAL_PROFILE_RECEIPT}"
: "${ACTOR_CELL_PLATFORM_RECEIPT:?set ACTOR_CELL_PLATFORM_RECEIPT}"
python=${ACTOR_BOOTSTRAP_PYTHON:-}
if [[ -z $python ]]; then
	if [[ -x /usr/local/qcloud/python/bin/python3.7 ]]; then python=/usr/local/qcloud/python/bin/python3.7; else python=python3; fi
fi

for command in kubectl jq "$python" sha256sum stat; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_CLUSTER_KUBECONFIG" "$ACTOR_PULL_CREDENTIAL_RECEIPT" \
	"$ACTOR_STORAGE_CREDENTIAL_RECEIPT" "$ACTOR_FDB_TLS_RECEIPT" \
	"$ACTOR_REGIONAL_PROFILE" "$ACTOR_REGIONAL_PROFILE_RECEIPT" \
	"$ACTOR_CELL_PLATFORM_RECEIPT"; do
	[[ $path == /* && $path != / ]] || { echo "Cell platform paths must be absolute and non-root" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_CLUSTER_KUBECONFIG" "$ACTOR_PULL_CREDENTIAL_RECEIPT" \
	"$ACTOR_STORAGE_CREDENTIAL_RECEIPT" "$ACTOR_FDB_TLS_RECEIPT" \
	"$ACTOR_REGIONAL_PROFILE" "$ACTOR_REGIONAL_PROFILE_RECEIPT"; do
	[[ -f $path && ! -L $path ]] || { echo "Cell platform input must be a regular non-symlink file: $path" >&2; exit 2; }
done
(( (8#$(stat -c '%a' "$ACTOR_CLUSTER_KUBECONFIG") & 8#077) == 0 )) || {
	echo "Cell kubeconfig must not be group/world accessible" >&2
	exit 2
}
[[ -d $(dirname -- "$ACTOR_CELL_PLATFORM_RECEIPT") ]] || {
	echo "Cell platform receipt parent must already exist" >&2
	exit 2
}

temporary=$(mktemp -d "$(dirname -- "$ACTOR_CELL_PLATFORM_RECEIPT")/.actor-cell-platform.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"
"$python" "$script_dir/validate-cell-platform-inputs.py" \
	--inventory "$ACTOR_TERRAFORM_INVENTORY" --images "$ACTOR_IMAGE_INVENTORY" \
	--pull-receipt "$ACTOR_PULL_CREDENTIAL_RECEIPT" \
	--storage-receipt "$ACTOR_STORAGE_CREDENTIAL_RECEIPT" \
	--tls-receipt "$ACTOR_FDB_TLS_RECEIPT" --profile "$ACTOR_REGIONAL_PROFILE" \
	--profile-receipt "$ACTOR_REGIONAL_PROFILE_RECEIPT" >"$temporary/plan.json"

cell_id=$(jq -er '.cellId' "$temporary/plan.json")
cluster_id=$(jq -er '.clusterId' "$temporary/plan.json")
cluster_uid=$(jq -er '.clusterUid' "$temporary/plan.json")
namespace=$(jq -er '.namespace.name' "$temporary/plan.json")
namespace_uid=$(jq -er '.namespace.uid' "$temporary/plan.json")
namespace_pull_uid=$(jq -er '.namespace.pullSecretUid' "$temporary/plan.json")
controller_namespace=$(jq -er '.controllerNamespace.name' "$temporary/plan.json")
controller_namespace_uid=$(jq -er '.controllerNamespace.uid' "$temporary/plan.json")
controller_pull_uid=$(jq -er '.controllerNamespace.pullSecretUid' "$temporary/plan.json")
controller_image=$(jq -er '.controller.image' "$temporary/plan.json")
controller_revision=$(jq -er '.controller.sourceRevision' "$temporary/plan.json")
controller_manifest=$(jq -er '.controller.sourceManifestSha256' "$temporary/plan.json")
image_inventory_digest=$(jq -er '.imageInventoryDigest' "$temporary/plan.json")
profile_name=$(jq -er '.profile.name' "$temporary/plan.json")
class_name=$(jq -er '.profile.className' "$temporary/plan.json")
profile_digest=$(jq -er '.profile.digest' "$temporary/plan.json")
kube=(kubectl --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG")

[[ $("${kube[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}') == "$cluster_uid" ]] || {
	echo "live cluster UID differs from Cell platform evidence" >&2
	exit 1
}
for binding in \
	"$namespace:$namespace_uid:$namespace_pull_uid" \
	"$controller_namespace:$controller_namespace_uid:$controller_pull_uid"; do
	IFS=: read -r expected_namespace expected_namespace_uid expected_pull_uid <<<"$binding"
	[[ $("${kube[@]}" get namespace "$expected_namespace" -o jsonpath='{.metadata.uid}') == "$expected_namespace_uid" ]] || {
		echo "live namespace UID differs: $expected_namespace" >&2
		exit 1
	}
	[[ $("${kube[@]}" -n "$expected_namespace" get secret actor-fleet-tcr -o jsonpath='{.metadata.uid}') == "$expected_pull_uid" ]] || {
		echo "live pull Secret UID differs: $expected_namespace/actor-fleet-tcr" >&2
		exit 1
	}
done
while IFS=$'\t' read -r secret_name secret_uid; do
	[[ $("${kube[@]}" -n "$namespace" get secret "$secret_name" -o jsonpath='{.metadata.uid}') == "$secret_uid" ]] || {
		echo "live prerequisite Secret UID differs: $namespace/$secret_name" >&2
		exit 1
	}
done < <(jq -r '.prerequisiteSecrets[] | [.name,.uid] | @tsv' "$temporary/plan.json")

"${kube[@]}" apply --server-side --field-manager=actor-create-first-platform \
	-f "$fleet_dir/crds.yaml" >/dev/null
for crd in rivetcellprofiles.fleet.actor.dev shardclasses.fleet.actor.dev rivetcells.fleet.actor.dev; do
	"${kube[@]}" wait --for=condition=Established "crd/$crd" --timeout=2m >/dev/null
done

# The FDB installer verifies vendored CRDs, private images, TLS/backup Secrets
# and rollout health. KUBECONFIG and its explicit context identify one target.
fdb_context=$("${kube[@]}" config current-context)
ACTOR_IMAGE_INVENTORY="$ACTOR_IMAGE_INVENTORY" \
FDB_KUBE_CONTEXT="$fdb_context" FDB_OPERATOR_MODE=production FDB_CELL_NAME="$cell_id" \
KUBECONFIG="$ACTOR_CLUSTER_KUBECONFIG" \
	"$fleet_dir/fdb-operator/install.sh"

"${kube[@]}" apply --server-side --field-manager=actor-create-first-platform \
	-f "$ACTOR_REGIONAL_PROFILE" >/dev/null
"${kube[@]}" kustomize "$fleet_dir/controller-fdb-operator" >"$temporary/controller-source.yaml"
"$python" "$script_dir/render-cell-controller.py" \
	--input "$temporary/controller-source.yaml" --output "$temporary/controller.yaml" \
	--image "$controller_image" --inventory-digest "$image_inventory_digest" \
	--source-revision "$controller_revision" --source-manifest-sha256 "$controller_manifest"
"${kube[@]}" apply --server-side --field-manager=actor-create-first-platform \
	-f "$temporary/controller.yaml" >/dev/null
"${kube[@]}" -n "$controller_namespace" rollout status \
	deployment/fdb-operator-actor-fleet-controller --timeout=10m

"${kube[@]}" -n "$namespace" get deployment fdb-kubernetes-operator-controller-manager -o json \
	>"$temporary/fdb-operator.json"
"${kube[@]}" -n "$controller_namespace" get deployment fdb-operator-actor-fleet-controller -o json \
	>"$temporary/cell-controller.json"
"${kube[@]}" get rivetcellprofile "$profile_name" -o json >"$temporary/profile.json"
"${kube[@]}" get shardclass "$class_name" -o json >"$temporary/class.json"
jq -e --arg image "$controller_image" --arg inventory "$image_inventory_digest" \
	--arg revision "$controller_revision" --arg manifest "$controller_manifest" '
  (.spec.template.spec.containers | length) == 1 and
  .spec.template.spec.containers[0].name == "manager" and
  .spec.template.spec.containers[0].image == $image and
  .spec.template.metadata.annotations["fleet.actor.dev/image-inventory-digest"] == $inventory and
  .spec.template.metadata.annotations["fleet.actor.dev/source-commit"] == $revision and
  .spec.template.metadata.annotations["fleet.actor.dev/source-manifest-sha256"] == $manifest
' "$temporary/cell-controller.json" >/dev/null || {
	echo "live Cell controller differs from reviewed image/source identity" >&2
	exit 1
}
jq -e --arg inventory "$image_inventory_digest" \
	'.spec.template.metadata.annotations["fleet.actor.dev/image-inventory-digest"] == $inventory' \
	"$temporary/fdb-operator.json" >/dev/null || {
	echo "live FDB Operator differs from reviewed image inventory" >&2
	exit 1
}
fdb_operator_images=$(jq -cer '
  [.spec.template.spec.initContainers[]?.image, .spec.template.spec.containers[]?.image] | sort |
  if length > 0 and (unique | length) == length and all(.[]; contains("@sha256:"))
  then . else error("FDB Operator image inventory is empty, duplicated, or not digest pinned") end
' "$temporary/fdb-operator.json")
jq -S '.spec' "$temporary/profile.json" >"$temporary/live-profile-spec.json"
"$python" - "$ACTOR_REGIONAL_PROFILE" "$temporary/desired-profile-spec.json" <<'PY'
import json, sys, yaml
documents = [item for item in yaml.safe_load_all(open(sys.argv[1])) if item]
profile = next(item for item in documents if item.get("kind") == "RivetCellProfile")
json.dump(profile["spec"], open(sys.argv[2], "w"), sort_keys=True, indent=2)
PY
jq -S . "$temporary/desired-profile-spec.json" >"$temporary/desired-profile-spec.sorted.json"
cmp -s "$temporary/live-profile-spec.json" "$temporary/desired-profile-spec.sorted.json" || {
	echo "live RivetCellProfile spec differs from rendered regional profile" >&2
	exit 1
}
jq -e --arg name "$profile_name" --arg digest "$profile_digest" \
	'.spec.profileRef == {name:$name,digest:$digest}' "$temporary/class.json" >/dev/null || {
	echo "live ShardClass does not bind the rendered regional profile" >&2
	exit 1
}

inputs=$(jq -cn \
	--arg pull "$(sha256sum "$ACTOR_PULL_CREDENTIAL_RECEIPT" | cut -d' ' -f1)" \
	--arg storage "$(sha256sum "$ACTOR_STORAGE_CREDENTIAL_RECEIPT" | cut -d' ' -f1)" \
	--arg tls "$(sha256sum "$ACTOR_FDB_TLS_RECEIPT" | cut -d' ' -f1)" \
	--arg profile "$(sha256sum "$ACTOR_REGIONAL_PROFILE_RECEIPT" | cut -d' ' -f1)" \
	'{pullCredentialReceiptSha256:$pull,storageCredentialReceiptSha256:$storage,
	  fdbTlsReceiptSha256:$tls,regionalProfileReceiptSha256:$profile}')
receipt_temporary=$temporary/receipt.json
jq -cn --arg cell "$cell_id" --arg cluster_id "$cluster_id" --arg cluster_uid "$cluster_uid" \
	--arg inventory "$image_inventory_digest" --arg profile "$profile_name" --arg class "$class_name" \
	--arg profile_digest "$profile_digest" --arg controller_image "$controller_image" \
	--arg fdb_uid "$(jq -er '.metadata.uid' "$temporary/fdb-operator.json")" \
	--arg controller_uid "$(jq -er '.metadata.uid' "$temporary/cell-controller.json")" \
	--argjson fdb_images "$fdb_operator_images" \
	--arg profile_uid "$(jq -er '.metadata.uid' "$temporary/profile.json")" \
	--arg class_uid "$(jq -er '.metadata.uid' "$temporary/class.json")" \
	--argjson inputs "$inputs" \
	'{schema:"actor-create-first-cell-platform/v1",verdict:"passed",cellId:$cell,
	  cluster:{id:$cluster_id,uid:$cluster_uid},imageInventoryDigest:$inventory,inputs:$inputs,
	  profile:{name:$profile,uid:$profile_uid,digest:$profile_digest,className:$class,classUid:$class_uid},
	  workloads:{fdbOperatorUid:$fdb_uid,fdbOperatorImages:$fdb_images,
	    cellControllerUid:$controller_uid,cellControllerImage:$controller_image}}' \
	>"$receipt_temporary"
if [[ -e $ACTOR_CELL_PLATFORM_RECEIPT ]]; then
	[[ -f $ACTOR_CELL_PLATFORM_RECEIPT && ! -L $ACTOR_CELL_PLATFORM_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_CELL_PLATFORM_RECEIPT" || {
		echo "Cell platform receipt already exists with different content" >&2
		exit 1
	}
elif ! ln "$receipt_temporary" "$ACTOR_CELL_PLATFORM_RECEIPT" 2>/dev/null; then
	[[ -f $ACTOR_CELL_PLATFORM_RECEIPT && ! -L $ACTOR_CELL_PLATFORM_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_CELL_PLATFORM_RECEIPT" || {
		echo "unable to publish immutable Cell platform receipt" >&2
		exit 1
	}
fi
chmod 0644 "$ACTOR_CELL_PLATFORM_RECEIPT"
printf 'cell_platform=passed cell=%s receipt=%s sha256=%s\n' \
	"$cell_id" "$ACTOR_CELL_PLATFORM_RECEIPT" \
	"$(sha256sum "$ACTOR_CELL_PLATFORM_RECEIPT" | cut -d' ' -f1)"
