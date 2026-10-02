#!/usr/bin/env bash
set -euo pipefail
umask 077

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=${ACTOR_FLEET_SOURCE_DIR:-$(CDPATH= cd -- "$script_dir/.." && pwd)}
[[ $fleet_dir == /* && -d $fleet_dir && ! -L $fleet_dir ]] || {
	echo "ACTOR_FLEET_SOURCE_DIR must be an absolute directory" >&2; exit 2;
}
: "${ACTOR_TERRAFORM_INVENTORY:?set ACTOR_TERRAFORM_INVENTORY}"
: "${ACTOR_IMAGE_INVENTORY:?set ACTOR_IMAGE_INVENTORY}"
: "${ACTOR_CLUSTER_KUBECONFIG:?set ACTOR_CLUSTER_KUBECONFIG}"
: "${ACTOR_STORAGE_CREDENTIAL_SOURCE:?set ACTOR_STORAGE_CREDENTIAL_SOURCE}"
: "${ACTOR_CODE_PLANE_PRIVATE_DIR:?set ACTOR_CODE_PLANE_PRIVATE_DIR}"
: "${ACTOR_CODE_PLANE_DESIRED_DIR:?set ACTOR_CODE_PLANE_DESIRED_DIR}"
: "${ACTOR_CODE_PLANE_RENDER_RECEIPT:?set ACTOR_CODE_PLANE_RENDER_RECEIPT}"
: "${ACTOR_CODE_PLANE_INSTALL_RECEIPT:?set ACTOR_CODE_PLANE_INSTALL_RECEIPT}"
python=${PYTHON:-python3.11}
resume=${ACTOR_CODE_PLANE_RESUME:-false}

[[ $resume == false || $resume == true ]] || {
	echo "ACTOR_CODE_PLANE_RESUME must be true or false" >&2; exit 2;
}

for command in jq kubectl curl openssl sha256sum base64 timeout diff "$python"; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
for path in "$ACTOR_TERRAFORM_INVENTORY" "$ACTOR_IMAGE_INVENTORY" \
	"$ACTOR_CLUSTER_KUBECONFIG" "$ACTOR_STORAGE_CREDENTIAL_SOURCE"; do
	[[ $path == /* && -f $path && ! -L $path ]] || { echo "input must be an absolute regular non-symlink file: $path" >&2; exit 2; }
done
for path in "$ACTOR_CODE_PLANE_PRIVATE_DIR" "$ACTOR_CODE_PLANE_DESIRED_DIR" \
	"$ACTOR_CODE_PLANE_RENDER_RECEIPT" "$ACTOR_CODE_PLANE_INSTALL_RECEIPT"; do
	[[ $path == /* && $path != / ]] || { echo "code-plane paths must be absolute and non-root" >&2; exit 2; }
done
[[ -d $ACTOR_CODE_PLANE_PRIVATE_DIR && ! -L $ACTOR_CODE_PLANE_PRIVATE_DIR ]] || {
	echo "private directory must already exist and may not be a symlink" >&2; exit 2;
}
[[ $(stat -c '%a' "$ACTOR_CODE_PLANE_PRIVATE_DIR") == 700 ]] || {
	echo "private directory must be mode 0700" >&2; exit 2;
}
[[ -d $ACTOR_CODE_PLANE_DESIRED_DIR && ! -L $ACTOR_CODE_PLANE_DESIRED_DIR ]] || {
	echo "desired directory must already exist and may not be a symlink" >&2; exit 2;
}
[[ -d $(dirname -- "$ACTOR_CODE_PLANE_RENDER_RECEIPT") ]] || {
	echo "render receipt parent must exist" >&2; exit 2;
}
if [[ $resume == false && -e $ACTOR_CODE_PLANE_RENDER_RECEIPT ]]; then
	echo "render receipt must be a new path unless resuming" >&2; exit 2
fi
[[ -d $(dirname -- "$ACTOR_CODE_PLANE_INSTALL_RECEIPT") && ! -e $ACTOR_CODE_PLANE_INSTALL_RECEIPT ]] || {
	echo "install receipt must be a new path with an existing parent" >&2; exit 2;
}

temporary=$(mktemp -d /data/tmp/actor-regional-code-plane.XXXXXX)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
chmod 0700 "$temporary"

if [[ $resume == true && -e $ACTOR_CODE_PLANE_RENDER_RECEIPT ]]; then
	[[ -f $ACTOR_CODE_PLANE_RENDER_RECEIPT && ! -L $ACTOR_CODE_PLANE_RENDER_RECEIPT ]] || {
		echo "resumed render receipt must be a regular non-symlink file" >&2; exit 2;
	}
	mkdir "$temporary/reconstructed"
	"$python" "$script_dir/render-desired-state.py" \
		--inventory "$ACTOR_TERRAFORM_INVENTORY" --images "$ACTOR_IMAGE_INVENTORY" \
		--fleet-dir "$fleet_dir" --output-dir "$temporary/reconstructed" \
		--receipt "$temporary/reconstructed-render.json" >/dev/null
	cmp -s "$ACTOR_CODE_PLANE_RENDER_RECEIPT" "$temporary/reconstructed-render.json" || {
		echo "resumed render receipt differs from current authorities" >&2; exit 1;
	}
	diff -qr --no-dereference "$ACTOR_CODE_PLANE_DESIRED_DIR" "$temporary/reconstructed" >/dev/null || {
		echo "resumed desired manifests differ from current authorities" >&2; exit 1;
	}
else
	[[ ! -e $ACTOR_CODE_PLANE_RENDER_RECEIPT && -z $(find "$ACTOR_CODE_PLANE_DESIRED_DIR" -mindepth 1 -maxdepth 1 -print -quit) ]] || {
		echo "render output is partial; use ACTOR_CODE_PLANE_RESUME=true only with a complete rendering" >&2; exit 2;
	}
	"$python" "$script_dir/render-desired-state.py" \
		--inventory "$ACTOR_TERRAFORM_INVENTORY" --images "$ACTOR_IMAGE_INVENTORY" \
		--fleet-dir "$fleet_dir" --output-dir "$ACTOR_CODE_PLANE_DESIRED_DIR" \
		--receipt "$ACTOR_CODE_PLANE_RENDER_RECEIPT" >/dev/null
fi

management_id=$(jq -er '.managementId' "$ACTOR_CODE_PLANE_RENDER_RECEIPT")
cluster_id=$(jq -er '.clusterId' "$ACTOR_CODE_PLANE_RENDER_RECEIPT")
region=$(jq -er '.region' "$ACTOR_CODE_PLANE_RENDER_RECEIPT")
backup_bucket=$(jq -er '.storage.backupBucket' "$ACTOR_CODE_PLANE_RENDER_RECEIPT")
code_bucket=$(jq -er '.storage.codeBucket' "$ACTOR_CODE_PLANE_RENDER_RECEIPT")
inventory_digest=$(jq -er '.imageInventoryDigest' "$ACTOR_CODE_PLANE_RENDER_RECEIPT")
fdb_namespace=actor-fdb-cell-system
registry_namespace=worker-registry-system
k=(kubectl --kubeconfig "$ACTOR_CLUSTER_KUBECONFIG")

live_cluster_uid=$("${k[@]}" get namespace kube-system -o jsonpath='{.metadata.uid}')
[[ -n $live_cluster_uid ]] || { echo "management Kubernetes cluster is unavailable" >&2; exit 1; }
"${k[@]}" create namespace "$fdb_namespace" --dry-run=client -o yaml | "${k[@]}" apply -f - >/dev/null
"${k[@]}" create namespace "$registry_namespace" --dry-run=client -o yaml | "${k[@]}" apply -f - >/dev/null

ensure_secret() {
	local namespace=$1 name=$2 desired=$3 live
	live=$temporary/$namespace-$name.live.json
	if "${k[@]}" -n "$namespace" get secret "$name" -o json >"$live" 2>/dev/null; then
		# Labels are descriptive and may predate this formal bootstrap. Secret
		# authority is its immutable payload and exact namespace/name identity.
		jq -e '.immutable==true' "$desired" >/dev/null || { echo "desired Secret must be immutable" >&2; exit 1; }
		jq -S '{type,metadata:{name:.metadata.name,namespace:.metadata.namespace},data}' "$desired" >"$temporary/desired.payload"
		jq -S '{type,metadata:{name:.metadata.name,namespace:.metadata.namespace},data}' "$live" >"$temporary/live.payload"
		cmp -s "$temporary/desired.payload" "$temporary/live.payload" || {
			echo "live Secret payload differs: $namespace/$name" >&2; exit 1;
		}
		if [[ $(jq -r '.immutable // false' "$live") != true ]]; then
			# Kubernetes permits the safe one-way false -> true transition. This
			# preserves the Secret UID and running Pods while closing rotation drift.
			"${k[@]}" -n "$namespace" patch secret "$name" --type=merge -p '{"immutable":true}' >/dev/null
			"${k[@]}" -n "$namespace" get secret "$name" -o json >"$live"
		fi
		jq -S '{type,immutable,metadata:{name:.metadata.name,namespace:.metadata.namespace},data}' "$desired" >"$temporary/desired.projection"
		jq -S '{type,immutable,metadata:{name:.metadata.name,namespace:.metadata.namespace},data}' "$live" >"$temporary/live.projection"
		cmp -s "$temporary/desired.projection" "$temporary/live.projection" || {
			echo "live immutable Secret differs: $namespace/$name" >&2; exit 1;
		}
	else
		"${k[@]}" create -f "$desired" >/dev/null
		"${k[@]}" -n "$namespace" get secret "$name" -o json >"$live"
	fi
	jq -er '.metadata.uid | select(type=="string" and length>0)' "$live"
}

copy_pull_secret() {
	local namespace=$1 desired
	desired=$temporary/$namespace-actor-fleet-tcr.json
	"${k[@]}" -n argocd get secret actor-fleet-tcr -o json |
		jq --arg namespace "$namespace" '
			del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.managedFields,.metadata.ownerReferences,.metadata.annotations,.metadata.labels) |
			.metadata.name="actor-fleet-tcr" | .metadata.namespace=$namespace | .metadata.labels={"fleet.actor.dev/purpose":"image-pull"} | .immutable=true
		' >"$desired"
	ensure_secret "$namespace" actor-fleet-tcr "$desired"
}
fdb_pull_uid=$(copy_pull_secret "$fdb_namespace")
registry_pull_uid=$(copy_pull_secret "$registry_namespace")

tls_receipt=${ACTOR_FDB_TLS_RECEIPT:-$ACTOR_CODE_PLANE_PRIVATE_DIR/fdb-tls-bootstrap.json}
[[ $tls_receipt == /* && -d $(dirname -- "$tls_receipt") ]] || {
	echo "ACTOR_FDB_TLS_RECEIPT must have an existing absolute parent" >&2; exit 2;
}
export ACTOR_CELL_KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG ACTOR_CELL_ID=$management_id
export ACTOR_FDB_NAMESPACE=$fdb_namespace ACTOR_FDB_TLS_DIRECTORY=$ACTOR_CODE_PLANE_PRIVATE_DIR/fdb-tls
export ACTOR_FDB_TLS_RECEIPT=$tls_receipt
export ACTOR_FDB_BLOBSTORE_CA_FILE=${ACTOR_FDB_BLOBSTORE_CA_FILE:-/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem}
if [[ -e $tls_receipt ]]; then
	"$python" - "$tls_receipt" "$management_id" <<'PY'
import json,sys
value=json.load(open(sys.argv[1]))
if value.get("schema")!="actor-fdb-tls-bootstrap/v1" or value.get("verdict")!="passed" or value.get("cellId")!=sys.argv[2]:
    raise SystemExit("existing TLS receipt differs from management identity")
PY
else
	"$fleet_dir/fdb-operator/bootstrap-cell-tls.sh" >/dev/null
fi

backup_secret=$temporary/backup-credentials.json
account="@$backup_bucket.cos.$region.myqcloud.com"
jq -cn --arg account "$account" \
	--arg id "$(jq -er '.storageCredentials.backup.accessKeyId' "$ACTOR_STORAGE_CREDENTIAL_SOURCE")" \
	--arg key "$(jq -er '.storageCredentials.backup.secretAccessKey' "$ACTOR_STORAGE_CREDENTIAL_SOURCE")" \
	'{accounts:{($account):{api_key:$id,secret:$key}}}' >"$temporary/credentials"
"${k[@]}" -n "$fdb_namespace" create secret generic "$management_id-backup-credentials" \
	--from-file=credentials="$temporary/credentials" --dry-run=client -o json |
	jq --arg namespace "$fdb_namespace" '.metadata.namespace=$namespace | .metadata.labels={"fleet.actor.dev/purpose":"regional-code-plane-backup"} | .immutable=true' >"$backup_secret"
if "${k[@]}" -n "$fdb_namespace" get secret "$management_id-backup-credentials" -o json >"$temporary/backup-live.json" 2>/dev/null; then
	jq -jr '.data.credentials' "$temporary/backup-live.json" | base64 -d >"$temporary/backup-live-credentials.json"
	jq -cS . "$temporary/credentials" >"$temporary/backup-desired-canonical.json"
	jq -cS . "$temporary/backup-live-credentials.json" >"$temporary/backup-live-canonical.json"
	cmp -s "$temporary/backup-desired-canonical.json" "$temporary/backup-live-canonical.json" || {
		echo "live FDB backup credential JSON differs" >&2; exit 1;
	}
	# Preserve semantically equivalent historical JSON bytes while promoting
	# immutability; FDB parses the object and does not assign meaning to layout.
	jq --arg namespace "$fdb_namespace" '
		del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.managedFields,.metadata.ownerReferences,.metadata.annotations,.metadata.labels) |
		.metadata.namespace=$namespace | .metadata.labels={"fleet.actor.dev/purpose":"regional-code-plane-backup"} | .immutable=true
	' "$temporary/backup-live.json" >"$backup_secret"
fi
backup_secret_uid=$(ensure_secret "$fdb_namespace" "$management_id-backup-credentials" "$backup_secret")

context=$("${k[@]}" config current-context)
export KUBECONFIG=$ACTOR_CLUSTER_KUBECONFIG
export ACTOR_IMAGE_INVENTORY FDB_KUBE_CONTEXT=$context FDB_OPERATOR_MODE=production FDB_CELL_NAME=$management_id
"$fleet_dir/fdb-operator/install.sh" >/dev/null
"${k[@]}" apply -f "$ACTOR_CODE_PLANE_DESIRED_DIR/fdb-cluster.yaml" >/dev/null

deadline=$((SECONDS + 1200))
cluster_json=
while ((SECONDS < deadline)); do
	cluster_json=$("${k[@]}" -n "$fdb_namespace" get foundationdbcluster "$management_id" -o json 2>/dev/null || true)
	if jq -e '.metadata.generation == .status.generations.reconciled and .status.health.available == true and .status.health.healthy == true and .status.health.fullReplication == true' <<<"$cluster_json" >/dev/null 2>&1; then break; fi
	sleep 5
done
((SECONDS < deadline)) || { echo "regional FDB did not become fully replicated" >&2; exit 1; }

# Fail immediately when the protected credential source does not authorize the
# exact backup bucket. Without this probe the operator retries `fdbbackup
# start` until the much longer physical-restorability deadline, obscuring a
# deterministic bootstrap input error as an unhealthy backup subsystem.
operator_pod=$("${k[@]}" -n "$fdb_namespace" get pods \
	-l app.kubernetes.io/name=fdb-kubernetes-operator \
	-o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
[[ -n $operator_pod ]] || { echo "regional FDB operator Pod is unavailable" >&2; exit 1; }
backup_base_url="blobstore://$account:443?bucket=$backup_bucket&region=$region"
if ! timeout 45 "${k[@]}" -n "$fdb_namespace" exec "$operator_pod" -c manager -- \
	/usr/bin/fdb/7.3/fdbbackup list -b "$backup_base_url" >"$temporary/backup-access-probe" 2>&1; then
	echo "regional FDB backup credential cannot access the exact backup bucket" >&2
	exit 1
fi

"${k[@]}" apply -f "$ACTOR_CODE_PLANE_DESIRED_DIR/fdb-backup.yaml" >/dev/null
backup_name=$management_id-continuous
backup_json= backup_description=
deadline=$((SECONDS + 900))
while ((SECONDS < deadline)); do
	backup_json=$("${k[@]}" -n "$fdb_namespace" get foundationdbbackup "$backup_name" -o json 2>/dev/null || true)
	backup_url=$(jq -r '.status.backupDetails.url // empty' <<<"$backup_json")
	backup_pod=$("${k[@]}" -n "$fdb_namespace" get pods -l "foundationdb.org/deployment-name=$backup_name-backup-agents" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
	if [[ $(jq -r '.status.backupDetails.running // false' <<<"$backup_json") == true && $backup_url == blobstore://* && -n $backup_pod ]]; then
		backup_description=$(timeout 45 "${k[@]}" -n "$fdb_namespace" exec "$backup_pod" -c foundationdb -- fdbbackup describe -d "$backup_url" 2>/dev/null || true)
		grep -q '^Restorable: true$' <<<"$backup_description" && break
	fi
	sleep 5
done
((SECONDS < deadline)) || { echo "regional FDB backup is not physically restorable" >&2; exit 1; }

"${k[@]}" -n "$fdb_namespace" get configmap "$management_id-config" -o jsonpath='{.data.cluster-file}' >"$temporary/fdb.cluster"
[[ -s $temporary/fdb.cluster ]]
"${k[@]}" -n "$registry_namespace" create secret generic worker-registry-fdb --from-file=cluster-file="$temporary/fdb.cluster" --dry-run=client -o json |
	jq --arg namespace "$registry_namespace" '.metadata.namespace=$namespace | .immutable=true' >"$temporary/registry-fdb.json"
if "${k[@]}" -n "$registry_namespace" get secret worker-registry-fdb -o json >"$temporary/registry-fdb-live.json" 2>/dev/null; then
	jq -jr '.data["cluster-file"]' "$temporary/registry-fdb-live.json" | base64 -d >"$temporary/registry-fdb-live.cluster"
	"$python" - "$temporary/fdb.cluster" "$temporary/registry-fdb-live.cluster" <<'PY'
import sys
desired,live=(open(path,"rb").read().rstrip(b"\r\n") for path in sys.argv[1:])
if not desired or b"\n" in desired or b"\r" in desired or desired != live:
    raise SystemExit("live Worker Registry FDB connection string differs")
PY
	jq --arg namespace "$registry_namespace" '
		del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.managedFields,.metadata.ownerReferences,.metadata.annotations,.metadata.labels) |
		.metadata.namespace=$namespace | .immutable=true
	' "$temporary/registry-fdb-live.json" >"$temporary/registry-fdb.json"
fi
registry_fdb_uid=$(ensure_secret "$registry_namespace" worker-registry-fdb "$temporary/registry-fdb.json")
"${k[@]}" -n "$fdb_namespace" get secret "$management_id-fdb-tls" -o json |
	jq --arg namespace "$registry_namespace" 'del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.managedFields,.metadata.ownerReferences,.metadata.annotations,.metadata.labels) | .metadata.name="worker-registry-fdb-tls" | .metadata.namespace=$namespace | .immutable=true' >"$temporary/registry-tls.json"
registry_tls_uid=$(ensure_secret "$registry_namespace" worker-registry-fdb-tls "$temporary/registry-tls.json")

printf 'https://%s.cos-internal.%s.myqcloud.com' "$code_bucket" "$region" >"$temporary/bucket-url"
jq -jr '.storageCredentials.backup.accessKeyId' "$ACTOR_STORAGE_CREDENTIAL_SOURCE" >"$temporary/secret-id"
jq -jr '.storageCredentials.backup.secretAccessKey' "$ACTOR_STORAGE_CREDENTIAL_SOURCE" >"$temporary/secret-key"
"${k[@]}" -n "$registry_namespace" create secret generic worker-registry-cos \
	--from-file=bucket-url="$temporary/bucket-url" --from-file=secret-id="$temporary/secret-id" --from-file=secret-key="$temporary/secret-key" \
	--dry-run=client -o json | jq --arg namespace "$registry_namespace" '.metadata.namespace=$namespace | .immutable=true' >"$temporary/registry-cos.json"
if "${k[@]}" -n "$registry_namespace" get secret worker-registry-cos -o json >"$temporary/registry-cos-live.json" 2>/dev/null; then
	for field in bucket-url secret-id secret-key; do
		jq -jr --arg field "$field" '.data[$field]' "$temporary/registry-cos-live.json" | base64 -d >"$temporary/registry-cos-live-$field"
	done
	"$python" - \
		"$temporary/bucket-url" "$temporary/registry-cos-live-bucket-url" \
		"$temporary/secret-id" "$temporary/registry-cos-live-secret-id" \
		"$temporary/secret-key" "$temporary/registry-cos-live-secret-key" <<'PY'
import sys
for desired_path,live_path in zip(sys.argv[1::2],sys.argv[2::2]):
    desired=open(desired_path,"rb").read().rstrip(b"\r\n")
    live=open(live_path,"rb").read().rstrip(b"\r\n")
    if not desired or b"\n" in desired or b"\r" in desired or desired != live:
        raise SystemExit("live Worker Registry COS binding differs")
PY
	jq --arg namespace "$registry_namespace" '
		del(.metadata.uid,.metadata.resourceVersion,.metadata.creationTimestamp,.metadata.managedFields,.metadata.ownerReferences,.metadata.annotations,.metadata.labels) |
		.metadata.namespace=$namespace | .immutable=true
	' "$temporary/registry-cos-live.json" >"$temporary/registry-cos.json"
fi
registry_cos_uid=$(ensure_secret "$registry_namespace" worker-registry-cos "$temporary/registry-cos.json")

"${k[@]}" apply -f "$ACTOR_CODE_PLANE_DESIRED_DIR/worker-registry.yaml" >/dev/null
"${k[@]}" -n "$registry_namespace" rollout status deployment/worker-registry --timeout=10m >/dev/null
"${k[@]}" apply -f "$ACTOR_CODE_PLANE_DESIRED_DIR/worker-registry-private.yaml" >/dev/null

endpoint=
deadline=$((SECONDS + 600))
while ((SECONDS < deadline)); do
	endpoint=$("${k[@]}" -n "$registry_namespace" get service worker-registry-private -o jsonpath='{.status.loadBalancer.ingress[0].ip}' 2>/dev/null || true)
	[[ -n $endpoint ]] && curl -fsS --connect-timeout 3 --max-time 5 "http://$endpoint:8080/readyz" >"$temporary/ready.json" 2>/dev/null && break
	sleep 5
done
((SECONDS < deadline)) && jq -e '.status=="ready"' "$temporary/ready.json" >/dev/null || {
	echo "regional Worker Registry private endpoint is not ready" >&2; exit 1;
}

"${k[@]}" -n "$registry_namespace" get deployment worker-registry -o json >"$temporary/registry-deployment.json"
"${k[@]}" -n "$registry_namespace" get pods -l app.kubernetes.io/name=worker-registry -o json >"$temporary/registry-pods.json"
"${k[@]}" -n "$registry_namespace" get service worker-registry-private -o json >"$temporary/registry-service.json"
jq -e '[.items[] | select(any(.status.conditions[]?; .type=="Ready" and .status=="True")) | .spec.nodeName] | length==3 and (unique|length)==3' "$temporary/registry-pods.json" >/dev/null

inputs=$(jq -cn \
	--arg inventory "$(sha256sum "$ACTOR_TERRAFORM_INVENTORY" | cut -d' ' -f1)" \
	--arg images "$(sha256sum "$ACTOR_IMAGE_INVENTORY" | cut -d' ' -f1)" \
	--arg render "$(sha256sum "$ACTOR_CODE_PLANE_RENDER_RECEIPT" | cut -d' ' -f1)" \
	'{terraformInventorySha256:$inventory,imageInventorySha256:$images,renderReceiptSha256:$render}')
jq -cn --arg management "$management_id" --arg cluster_id "$cluster_id" --arg cluster_uid "$live_cluster_uid" \
	--arg inventory_digest "$inventory_digest" --arg fdb_uid "$(jq -er '.metadata.uid' <<<"$cluster_json")" \
	--arg backup_uid "$(jq -er '.metadata.uid' <<<"$backup_json")" --arg backup_bucket "$backup_bucket" \
	--arg registry_uid "$(jq -er '.metadata.uid' "$temporary/registry-deployment.json")" \
	--arg service_uid "$(jq -er '.metadata.uid' "$temporary/registry-service.json")" --arg endpoint "http://$endpoint:8080" \
	--arg fdb_pull_uid "$fdb_pull_uid" --arg registry_pull_uid "$registry_pull_uid" --arg backup_secret_uid "$backup_secret_uid" \
	--arg registry_fdb_uid "$registry_fdb_uid" --arg registry_tls_uid "$registry_tls_uid" --arg registry_cos_uid "$registry_cos_uid" \
	--argjson inputs "$inputs" \
	'{schema:"actor-regional-code-plane-install/v1",verdict:"passed",managementId:$management,cluster:{id:$cluster_id,uid:$cluster_uid},imageInventoryDigest:$inventory_digest,inputs:$inputs,foundationDB:{uid:$fdb_uid,healthy:true,fullReplication:true,backup:{uid:$backup_uid,bucket:$backup_bucket,running:true,restorable:true}},registry:{deploymentUid:$registry_uid,replicas:3,distinctNodes:3,privateServiceUid:$service_uid,endpoint:$endpoint},externalSecrets:{fdbPullUid:$fdb_pull_uid,registryPullUid:$registry_pull_uid,backupCredentialsUid:$backup_secret_uid,registryFdbUid:$registry_fdb_uid,registryTlsUid:$registry_tls_uid,registryCosUid:$registry_cos_uid}}' >"$temporary/install-receipt.json"
chmod 0644 "$temporary/install-receipt.json"
ln "$temporary/install-receipt.json" "$ACTOR_CODE_PLANE_INSTALL_RECEIPT"
printf 'regional_code_plane=passed management=%s endpoint=%s receipt=%s sha256=%s\n' \
	"$management_id" "http://$endpoint:8080" "$ACTOR_CODE_PLANE_INSTALL_RECEIPT" "$(sha256sum "$ACTOR_CODE_PLANE_INSTALL_RECEIPT" | cut -d' ' -f1)"
