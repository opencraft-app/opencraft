#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${ACTOR_CELL_KUBECONFIG:?set ACTOR_CELL_KUBECONFIG}"
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_ARGO_CONVERGENCE_RECEIPT:?set ACTOR_ARGO_CONVERGENCE_RECEIPT}"
: "${ACTOR_CELL_BACKUP_RENDER_RECEIPT:?set ACTOR_CELL_BACKUP_RENDER_RECEIPT}"
: "${ACTOR_CELL_BACKUP_RECEIPT:?set ACTOR_CELL_BACKUP_RECEIPT}"
python=${ACTOR_BOOTSTRAP_PYTHON:-python3.11}
namespace=actor-fdb-cell-system

for command in kubectl jq "$python" sha256sum stat; do
	command -v "$command" >/dev/null || { echo "missing Cell backup command: $command" >&2; exit 2; }
done
for path in "$ACTOR_CELL_KUBECONFIG" "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_ARGO_CONVERGENCE_RECEIPT" "$ACTOR_CELL_BACKUP_RENDER_RECEIPT" "$ACTOR_CELL_BACKUP_RECEIPT"; do
	[[ $path == /* && $path != / ]] || { echo "Cell backup paths must be absolute and non-root" >&2; exit 2; }
done
for path in "$ACTOR_CELL_KUBECONFIG" "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_ARGO_CONVERGENCE_RECEIPT"; do
	[[ -f $path && ! -L $path ]] || { echo "Cell backup input must be a regular non-symlink file: $path" >&2; exit 2; }
done
(( (8#$(stat -c '%a' "$ACTOR_CELL_KUBECONFIG") & 8#077) == 0 )) || {
	echo "Cell kubeconfig must not be group/world accessible" >&2
	exit 2
}
[[ -d $(dirname -- "$ACTOR_CELL_BACKUP_RENDER_RECEIPT") && -d $(dirname -- "$ACTOR_CELL_BACKUP_RECEIPT") ]] || {
	echo "Cell backup receipt parents must already exist" >&2
	exit 2
}

temporary=$(mktemp -d "$(dirname -- "$ACTOR_CELL_BACKUP_RECEIPT")/.actor-cell-backup.XXXXXX")
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"
manifest=$temporary/continuous-backup.yaml
"$python" "$script_dir/render-cell-continuous-backup.py" \
	--inventory "$ACTOR_TERRAFORM_INVENTORY" --images "$ACTOR_IMAGE_INVENTORY" \
	--convergence "$ACTOR_ARGO_CONVERGENCE_RECEIPT" --output "$manifest" \
	--receipt "$ACTOR_CELL_BACKUP_RENDER_RECEIPT"

cell_id=$(jq -er '.cellId' "$ACTOR_CELL_BACKUP_RENDER_RECEIPT")
cluster_id=$(jq -er '.clusterId' "$ACTOR_CELL_BACKUP_RENDER_RECEIPT")
cluster_uid=$(jq -er '.platformClusterUid' "$ACTOR_CELL_BACKUP_RENDER_RECEIPT")
cell_uid=$(jq -er '.cellUid' "$ACTOR_CELL_BACKUP_RENDER_RECEIPT")
backup_name=$(jq -er '.backup.name' "$ACTOR_CELL_BACKUP_RENDER_RECEIPT")
bucket=$(jq -er '.backup.bucket' "$ACTOR_CELL_BACKUP_RENDER_RECEIPT")
tag=$(jq -er '.backup.tag' "$ACTOR_CELL_BACKUP_RENDER_RECEIPT")
inventory_digest=$(jq -er '.imageInventoryDigest' "$ACTOR_CELL_BACKUP_RENDER_RECEIPT")
kube=(kubectl --kubeconfig "$ACTOR_CELL_KUBECONFIG")

[[ $("${kube[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}') == "$cluster_uid" ]] || {
	echo "live Kubernetes cluster UID differs from Argo convergence" >&2
	exit 1
}
"${kube[@]}" -n "$namespace" get rivetcell "$cell_id" -o json >"$temporary/cell.json"
[[ $(jq -er '.metadata.uid' "$temporary/cell.json") == "$cell_uid" ]] || {
	echo "live RivetCell UID differs from Argo convergence" >&2
	exit 1
}
fdb_uid=$(jq -er '.spec.foundationDB.clusterRef.uid | select(type == "string" and length > 0)' "$temporary/cell.json")
[[ $("${kube[@]}" -n "$namespace" get foundationdbcluster "$cell_id" -o jsonpath='{.metadata.uid}') == "$fdb_uid" ]] || {
	echo "live FoundationDBCluster identity differs from RivetCell binding" >&2
	exit 1
}
for secret in "$cell_id-backup-credentials" "$cell_id-backup-tls" actor-fleet-tcr; do
	"${kube[@]}" -n "$namespace" get secret "$secret" >/dev/null
done

"${kube[@]}" apply --server-side --field-manager=actor-cell-backup-bootstrap -f "$manifest" >/dev/null
deadline=$((SECONDS + ${ACTOR_CELL_BACKUP_TIMEOUT_SECONDS:-1800}))
restorable=false
while ((SECONDS < deadline)); do
	"${kube[@]}" -n "$namespace" get foundationdbbackup "$backup_name" -o json >"$temporary/backup.json"
	backup_url=$(jq -r '.status.backupDetails.url // empty' "$temporary/backup.json")
	backup_pod=$("${kube[@]}" -n "$namespace" get pods \
		-l "foundationdb.org/deployment-name=${cell_id}-continuous-backup-agents" \
		-o json 2>/dev/null | jq -r '
			[.items[]
			 | select(.status.phase == "Running")
			 | select(any(.status.containerStatuses[]?;
			     .name == "foundationdb" and .ready == true))
			 | .metadata.name] | sort | .[0] // empty' || true)
	if [[ $backup_url == blobstore://* && -n $backup_pod ]] && \
		"${kube[@]}" -n "$namespace" exec "$backup_pod" -c foundationdb -- \
		timeout 45 fdbbackup describe -d "$backup_url" 2>/dev/null | grep -q '^Restorable: true$'; then
		restorable=true
		break
	fi
	sleep 10
done
[[ $restorable == true ]] || {
	echo "continuous backup did not become independently Restorable before timeout" >&2
	exit 1
}
backup_uid=$(jq -er '.metadata.uid' "$temporary/backup.json")
[[ $(jq -er '.spec.blobStoreConfiguration.bucket' "$temporary/backup.json") == "$bucket" ]]
[[ $(jq -er '.spec.tag' "$temporary/backup.json") == "$tag" ]]

receipt_temporary=$temporary/receipt.json
jq -cn --arg cell "$cell_id" --arg cluster_id "$cluster_id" --arg cluster_uid "$cluster_uid" \
	--arg cell_uid "$cell_uid" --arg fdb_uid "$fdb_uid" --arg backup "$backup_name" \
	--arg backup_uid "$backup_uid" --arg tag "$tag" --arg bucket "$bucket" --arg url "$backup_url" \
	--arg inventory "$inventory_digest" \
	--arg terraform "$(sha256sum "$ACTOR_TERRAFORM_INVENTORY" | cut -d' ' -f1)" \
	--arg convergence "$(sha256sum "$ACTOR_ARGO_CONVERGENCE_RECEIPT" | cut -d' ' -f1)" \
	--arg render "$(sha256sum "$ACTOR_CELL_BACKUP_RENDER_RECEIPT" | cut -d' ' -f1)" \
	'{schema:"actor-cell-continuous-backup-bootstrap/v1",verdict:"passed",cellId:$cell,
	  cluster:{id:$cluster_id,uid:$cluster_uid},cellUid:$cell_uid,foundationDBClusterUid:$fdb_uid,
	  imageInventoryDigest:$inventory,backup:{name:$backup,uid:$backup_uid,tag:$tag,bucket:$bucket,url:$url,restorable:true},
	  inputs:{terraformInventorySha256:$terraform,argoConvergenceSha256:$convergence,renderReceiptSha256:$render}}' \
	>"$receipt_temporary"
if [[ -e $ACTOR_CELL_BACKUP_RECEIPT ]]; then
	[[ -f $ACTOR_CELL_BACKUP_RECEIPT && ! -L $ACTOR_CELL_BACKUP_RECEIPT ]] && \
		cmp -s "$receipt_temporary" "$ACTOR_CELL_BACKUP_RECEIPT" || {
		echo "continuous backup receipt already exists with different content" >&2
		exit 1
	}
else
	ln "$receipt_temporary" "$ACTOR_CELL_BACKUP_RECEIPT"
fi
chmod 0644 "$ACTOR_CELL_BACKUP_RECEIPT"
printf 'cell_continuous_backup=passed cell=%s receipt=%s sha256=%s\n' "$cell_id" \
	"$ACTOR_CELL_BACKUP_RECEIPT" "$(sha256sum "$ACTOR_CELL_BACKUP_RECEIPT" | cut -d' ' -f1)"
