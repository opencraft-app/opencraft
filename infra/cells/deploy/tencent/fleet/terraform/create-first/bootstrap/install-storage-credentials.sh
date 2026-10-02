#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_TERRAFORM_SENSITIVE_BOOTSTRAP:?set ACTOR_TERRAFORM_SENSITIVE_BOOTSTRAP}"
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG}"
: "${ACTOR_PULL_CREDENTIAL_RECEIPT:?set ACTOR_PULL_CREDENTIAL_RECEIPT}"
: "${ACTOR_STORAGE_CREDENTIAL_RECEIPT:?set ACTOR_STORAGE_CREDENTIAL_RECEIPT}"
python=${ACTOR_BOOTSTRAP_PYTHON:-}
if [[ -z $python ]]; then
	if [[ -x /usr/local/qcloud/python/bin/python3.7 ]]; then python=/usr/local/qcloud/python/bin/python3.7; else python=python3; fi
fi

for command in kubectl jq "$python" sha256sum stat; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_TERRAFORM_SENSITIVE_BOOTSTRAP" "$ACTOR_CLUSTER_KUBECONFIG" \
	"$ACTOR_PULL_CREDENTIAL_RECEIPT" "$ACTOR_STORAGE_CREDENTIAL_RECEIPT"; do
	[[ $path == /* && $path != / ]] || { echo "storage bootstrap paths must be absolute and non-root" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_TERRAFORM_SENSITIVE_BOOTSTRAP" "$ACTOR_CLUSTER_KUBECONFIG" \
	"$ACTOR_PULL_CREDENTIAL_RECEIPT"; do
	[[ -f $path && ! -L $path ]] || { echo "storage bootstrap input must be a regular non-symlink file: $path" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_SENSITIVE_BOOTSTRAP" "$ACTOR_CLUSTER_KUBECONFIG"; do
	(( (8#$(stat -c '%a' "$path") & 8#077) == 0 )) || {
		echo "protected bootstrap inputs must not be group/world accessible" >&2
		exit 2
	}
done
[[ -d $(dirname -- "$ACTOR_STORAGE_CREDENTIAL_RECEIPT") ]] || {
	echo "storage receipt parent must already exist" >&2
	exit 2
}

temporary=$(mktemp -d "$(dirname -- "$ACTOR_STORAGE_CREDENTIAL_RECEIPT")/.actor-storage-bootstrap.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"
"$python" "$script_dir/validate-storage-inputs.py" \
	--inventory "$ACTOR_TERRAFORM_INVENTORY" \
	--images "$ACTOR_IMAGE_INVENTORY" \
	--sensitive "$ACTOR_TERRAFORM_SENSITIVE_BOOTSTRAP" \
	--kubeconfig "$ACTOR_CLUSTER_KUBECONFIG" \
	--pull-receipt "$ACTOR_PULL_CREDENTIAL_RECEIPT" >"$temporary/plan.json"
chmod 0600 "$temporary/plan.json"

cell_id=$(jq -er '.cellId' "$temporary/plan.json")
region=$(jq -er '.region' "$temporary/plan.json")
cluster_id=$(jq -er '.clusterId' "$temporary/plan.json")
cluster_uid=$(jq -er '.clusterUid' "$temporary/plan.json")
namespace=$(jq -er '.namespace.name' "$temporary/plan.json")
namespace_uid=$(jq -er '.namespace.uid' "$temporary/plan.json")
pull_secret_uid=$(jq -er '.namespace.pullSecretUid' "$temporary/plan.json")
image_inventory_digest=$(jq -er '.imageInventoryDigest' "$temporary/plan.json")
kube=(kubectl --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG")

[[ $("${kube[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}') == "$cluster_uid" ]] || {
	echo "live cluster UID differs from pull credential receipt" >&2
	exit 1
}
[[ $("${kube[@]}" get namespace "$namespace" -o jsonpath='{.metadata.uid}') == "$namespace_uid" ]] || {
	echo "live FDB namespace UID differs from pull credential receipt" >&2
	exit 1
}
[[ $("${kube[@]}" -n "$namespace" get secret actor-fleet-tcr -o jsonpath='{.metadata.uid}') == "$pull_secret_uid" ]] || {
	echo "live pull Secret UID differs from pull credential receipt" >&2
	exit 1
}

cold_bucket=$(jq -er '.credentials.cold.bucket' "$temporary/plan.json")
cold_user=$(jq -er '.credentials.cold.userName' "$temporary/plan.json")
backup_bucket=$(jq -er '.credentials.backup.bucket' "$temporary/plan.json")
backup_user=$(jq -er '.credentials.backup.userName' "$temporary/plan.json")
jq -c --arg region "$region" \
	'{accounts:{("@"+.credentials.backup.bucket+".cos."+$region+".myqcloud.com"):{
	  api_key:.credentials.backup.accessKeyId,secret:.credentials.backup.secretAccessKey}}}' \
	"$temporary/plan.json" >"$temporary/backup-credentials.json"
jq -jr '.credentials.cold.accessKeyId' "$temporary/plan.json" >"$temporary/cold-access-key"
jq -jr '.credentials.cold.secretAccessKey' "$temporary/plan.json" >"$temporary/cold-secret-key"
chmod 0600 "$temporary/backup-credentials.json" "$temporary/cold-access-key" "$temporary/cold-secret-key"

declare -a secret_records=()
ensure_secret() {
	local role=$1 name=$2 desired=$3 live
	live=$temporary/$name.live.json
	if "${kube[@]}" -n "$namespace" get secret "$name" -o json >"$live" 2>/dev/null; then
		:
	else
		"${kube[@]}" create -f "$desired" >/dev/null
		"${kube[@]}" -n "$namespace" get secret "$name" -o json >"$live"
	fi
	jq -S '{immutable,type,metadata:{name:.metadata.name,namespace:.metadata.namespace,labels:.metadata.labels},data}' \
		"$desired" >"$temporary/$name.desired-projection.json"
	jq -S '{immutable,type,metadata:{name:.metadata.name,namespace:.metadata.namespace,labels:.metadata.labels},data}' \
		"$live" >"$temporary/$name.live-projection.json"
	cmp -s "$temporary/$name.desired-projection.json" "$temporary/$name.live-projection.json" || {
		echo "live immutable storage Secret differs: $namespace/$name" >&2
		exit 1
	}
	local uid
	uid=$(jq -er '.metadata.uid | select(type == "string" and length > 0)' "$live")
	secret_records+=("$(jq -cn --arg role "$role" --arg name "$name" --arg uid "$uid" \
		'{role:$role,name:$name,uid:$uid}')")
}

"${kube[@]}" -n "$namespace" create secret generic "$cell_id-backup-credentials" \
	--from-file=credentials="$temporary/backup-credentials.json" --dry-run=client -o json | \
	jq --arg cell "$cell_id" --arg bucket "$backup_bucket" --arg user "$backup_user" --arg namespace "$namespace" \
		'.type="Opaque" | .immutable=true | .metadata.namespace=$namespace | .metadata.labels={
			"fleet.actor.dev/cell-name":$cell,"fleet.actor.dev/credential-scope":"cell-backup",
			"fleet.actor.dev/storage-bucket":$bucket,"fleet.actor.dev/cam-user":$user}' \
		>"$temporary/backup-secret.json"
"${kube[@]}" -n "$namespace" create secret generic "$cell_id-runtime-cos" \
	--from-file=AWS_ACCESS_KEY_ID="$temporary/cold-access-key" \
	--from-file=AWS_SECRET_ACCESS_KEY="$temporary/cold-secret-key" --dry-run=client -o json | \
	jq --arg cell "$cell_id" --arg bucket "$cold_bucket" --arg user "$cold_user" --arg namespace "$namespace" \
		'.type="Opaque" | .immutable=true | .metadata.namespace=$namespace | .metadata.labels={
			"fleet.actor.dev/cell-name":$cell,"fleet.actor.dev/credential-scope":"cell-cold",
			"fleet.actor.dev/storage-bucket":$bucket,"fleet.actor.dev/cam-user":$user}' \
		>"$temporary/cold-secret.json"
chmod 0600 "$temporary/backup-secret.json" "$temporary/cold-secret.json"
ensure_secret backup "$cell_id-backup-credentials" "$temporary/backup-secret.json"
ensure_secret cold "$cell_id-runtime-cos" "$temporary/cold-secret.json"

records=$(printf '%s\n' "${secret_records[@]}" | jq -sc 'sort_by(.role)')
pull_receipt_sha=$(sha256sum "$ACTOR_PULL_CREDENTIAL_RECEIPT" | cut -d' ' -f1)
receipt_temporary=$temporary/receipt.json
jq -cn --arg cell "$cell_id" --arg region "$region" --arg cluster_id "$cluster_id" \
	--arg cluster_uid "$cluster_uid" --arg namespace "$namespace" --arg namespace_uid "$namespace_uid" \
	--arg inventory_digest "$image_inventory_digest" --arg pull_receipt_sha "$pull_receipt_sha" \
	--arg cold_bucket "$cold_bucket" --arg backup_bucket "$backup_bucket" --argjson secrets "$records" \
	'{schema:"actor-create-first-storage-bootstrap/v1",verdict:"passed",cellId:$cell,region:$region,
	  cluster:{id:$cluster_id,uid:$cluster_uid},namespace:{name:$namespace,uid:$namespace_uid},
	  imageInventoryDigest:$inventory_digest,pullCredentialReceiptSha256:$pull_receipt_sha,
	  buckets:{cold:$cold_bucket,backup:$backup_bucket},secrets:$secrets}' >"$receipt_temporary"
chmod 0600 "$receipt_temporary"
if [[ -e $ACTOR_STORAGE_CREDENTIAL_RECEIPT ]]; then
	[[ -f $ACTOR_STORAGE_CREDENTIAL_RECEIPT && ! -L $ACTOR_STORAGE_CREDENTIAL_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_STORAGE_CREDENTIAL_RECEIPT" || {
		echo "storage credential receipt already exists with different content" >&2
		exit 1
	}
elif ! ln "$receipt_temporary" "$ACTOR_STORAGE_CREDENTIAL_RECEIPT" 2>/dev/null; then
	[[ -f $ACTOR_STORAGE_CREDENTIAL_RECEIPT && ! -L $ACTOR_STORAGE_CREDENTIAL_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_STORAGE_CREDENTIAL_RECEIPT" || {
		echo "unable to publish immutable storage credential receipt" >&2
		exit 1
	}
fi
chmod 0644 "$ACTOR_STORAGE_CREDENTIAL_RECEIPT"
printf 'storage_bootstrap=passed cell=%s receipt=%s sha256=%s\n' \
	"$cell_id" "$ACTOR_STORAGE_CREDENTIAL_RECEIPT" \
	"$(sha256sum "$ACTOR_STORAGE_CREDENTIAL_RECEIPT" | cut -d' ' -f1)"
