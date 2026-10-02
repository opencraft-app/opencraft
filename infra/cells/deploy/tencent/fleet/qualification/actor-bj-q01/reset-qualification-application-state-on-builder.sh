#!/usr/bin/env bash
set -euo pipefail

# Reset only the disposable q01 application's FoundationDB user keyspace after
# an observed legacy cold-tier identity error. This deliberately preserves the
# FDB cluster, its nine PVC/PV/CBS identities, system keys, continuous backup,
# Kubernetes control objects and every non-q01 COS object.

cell=actor-bj-q01
namespace=actor-fdb-cell-system
required=(
	KUBECONFIG_PATH SOURCE_ROOT RESET_RECEIPT EXPECTED_CELL_UID EXPECTED_FDB_UID
	EXPECTED_BACKUP_UID EXPECTED_RUNTIME_CONFIG_UID EXPECTED_ENGINE_UID
	EXPECTED_RUNTIME_UID EXPECTED_NATS_UID EXPECTED_REGISTRY_UID
	EXPECTED_WORKERS_API_UID EXPECTED_OLD_COLD_BUCKET TARGET_COLD_BUCKET
	CENTRAL_AUDIT_INVOCATION
)
for name in "${required[@]}"; do
	[[ -n ${!name:-} ]] || { echo "required environment variable is empty: $name" >&2; exit 2; }
done
[[ ${ALLOW_Q01_APPLICATION_STATE_RESET:-0} == 1 ]] || {
	echo "set ALLOW_Q01_APPLICATION_STATE_RESET=1 after reviewing the exact q01 identities" >&2
	exit 2
}
[[ ${CENTRAL_Q01_ABSENT:-0} == 1 ]] || {
	echo "CENTRAL_Q01_ABSENT=1 must attest the independent management-cluster audit" >&2
	exit 2
}
[[ $CENTRAL_AUDIT_INVOCATION =~ ^inv-[a-z0-9]+$ ]] || { echo "invalid central audit invocation" >&2; exit 2; }
for value in "$EXPECTED_CELL_UID" "$EXPECTED_FDB_UID" "$EXPECTED_BACKUP_UID" \
	"$EXPECTED_RUNTIME_CONFIG_UID" "$EXPECTED_ENGINE_UID" "$EXPECTED_RUNTIME_UID" \
	"$EXPECTED_NATS_UID" "$EXPECTED_REGISTRY_UID" "$EXPECTED_WORKERS_API_UID"; do
	[[ $value =~ ^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$ ]] || {
		echo "an expected Kubernetes UID is invalid" >&2
		exit 2
	}
done
[[ $EXPECTED_OLD_COLD_BUCKET == actor-depot-cold-prod-bj-k01-nv1-* ]] || {
	echo "the reset is only authorized for the observed legacy k01 cold identity" >&2
	exit 2
}
[[ $TARGET_COLD_BUCKET == actor-depot-cold-prod-bj-q01-nv1-* ]] || {
	echo "target cold bucket is not q01-exclusive" >&2
	exit 2
}
[[ $EXPECTED_OLD_COLD_BUCKET != "$TARGET_COLD_BUCKET" ]] || { echo "cold identities are equal" >&2; exit 2; }
[[ -f $KUBECONFIG_PATH && ! -L $KUBECONFIG_PATH ]] || { echo "exact q01 kubeconfig is required" >&2; exit 2; }
[[ -d $SOURCE_ROOT && ! -L $SOURCE_ROOT ]] || { echo "immutable reviewed source root is required" >&2; exit 2; }
source_revision=$(tr -d '[:space:]' <"$SOURCE_ROOT/.actor-source/SOURCE_REVISION")
source_manifest=$SOURCE_ROOT/.actor-source/RELEASE_SHA256SUMS
source_manifest_sha=$(sha256sum "$source_manifest" | cut -d' ' -f1)
[[ $source_revision =~ ^[0-9a-f]{40}$ && $source_manifest_sha =~ ^[0-9a-f]{64}$ ]] || {
	echo "reviewed source identity is incomplete" >&2
	exit 2
}
(cd "$SOURCE_ROOT" && sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null)
cache_script=$SOURCE_ROOT/infra/cells/deploy/tencent/fleet/operations/cache-qualification-receipt.sh
coscli_installer=$SOURCE_ROOT/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/install-coscli.sh
[[ -x $cache_script && -x $coscli_installer ]] || { echo "reviewed reset dependencies are missing" >&2; exit 2; }
receipt_root=$(readlink -e /data/actor-qualification/receipts)
[[ $RESET_RECEIPT == "$receipt_root"/${cell}-application-state-reset-*.json && ! -e $RESET_RECEIPT ]] || {
	echo "reset receipt must be a new exact-q01 file in the qualification receipt root" >&2
	exit 2
}
for command in kubectl jq python3 sha256sum flock mktemp base64 curl; do
	command -v "$command" >/dev/null || { echo "missing reset command: $command" >&2; exit 2; }
done

export KUBECONFIG=$KUBECONFIG_PATH
lock_path=${AUTONOMY_CONTROL_LOCK_PATH:-/data/tmp/actor-autonomy-operations.lock}
exec 9>"$lock_path"
flock -n 9 || { echo "another risky Cell operation is active" >&2; exit 75; }

temporary=$(mktemp -d /data/tmp/q01-application-state-reset.XXXXXX)
chmod 0700 "$temporary"
phase=preflight
clear_committed=false
config_patched=false
quiesced=false
completed=false
config_before_sha=
config_after_sha=
cold_inventory_sha=
clear_read_version=
backup_description_before_sha=
backup_description_after_sha=
pre_state=$temporary/pre-state.json
post_state=$temporary/post-state.json
printf '{}\n' >"$pre_state"
printf '{}\n' >"$post_state"

capture_state() {
	local output=$1 prefix=$temporary/state
	kubectl -n "$namespace" get rivetcell "$cell" -o json >"$prefix-cell.json"
	kubectl -n "$namespace" get foundationdbcluster "$cell" -o json >"$prefix-fdb.json"
	kubectl -n "$namespace" get foundationdbbackup "${cell}-continuous" -o json >"$prefix-backup.json"
	kubectl -n "$namespace" get \
		deployment/${cell}-engine deployment/${cell}-worker-registry \
		deployment/${cell}-workers-api deployment/${cell}-runtime-capacity \
		deployment/${cell}-host-drain deployment/${cell}-cell-reporter \
		statefulset/${cell}-runtime-hosts statefulset/${cell}-nats \
		-o json >"$prefix-workloads.json"
	kubectl -n "$namespace" get pvc -l foundationdb.org/fdb-cluster-name="$cell" -o json >"$prefix-pvcs.json"
	jq -n --slurpfile cell "$prefix-cell.json" --slurpfile fdb "$prefix-fdb.json" \
		--slurpfile backup "$prefix-backup.json" --slurpfile workloads "$prefix-workloads.json" \
		--slurpfile pvcs "$prefix-pvcs.json" '{
	  cell:{uid:$cell[0].metadata.uid,generation:$cell[0].metadata.generation,
	    desiredState:$cell[0].spec.desiredState,phase:$cell[0].status.phase,
	    readyForPlacement:($cell[0].status.readyForPlacement//false),
	    placementCount:($cell[0].status.placementCount//0),activeWriters:($cell[0].status.activeWriters//0)},
	  foundationDB:{uid:$fdb[0].metadata.uid,generation:$fdb[0].metadata.generation,
	    reconciledGeneration:$fdb[0].status.generations.reconciled,
	    available:($fdb[0].status.health.available//false),
	    fullReplication:($fdb[0].status.health.fullReplication//false),
	    processGroups:($fdb[0].status.processGroups|length)},
	  backup:{uid:$backup[0].metadata.uid,generation:$backup[0].metadata.generation,
	    running:($backup[0].status.backupDetails.running//false),
	    url:$backup[0].status.backupDetails.url},
	  workloads:[$workloads[0].items[]|{
	    kind,name:.metadata.name,uid:.metadata.uid,
	    specReplicas:(.spec.replicas//0),readyReplicas:(.status.readyReplicas//0),
	    podTemplateSha256:(.spec.template|tojson|@base64)
	  }],
	  pvcs:[$pvcs[0].items[]|{
	    name:.metadata.name,uid:.metadata.uid,volume:.spec.volumeName,
	    ownerUid:(.metadata.ownerReferences[0].uid//null),phase:.status.phase,
	    capacity:.status.capacity.storage
	  }]
	}' >"$output"
	python3 - "$output" <<'PY'
import base64, hashlib, json, sys
path = sys.argv[1]
value = json.load(open(path))
for workload in value["workloads"]:
    raw = base64.b64decode(workload.pop("podTemplateSha256"))
    workload["podTemplateSha256"] = hashlib.sha256(raw).hexdigest()
with open(path, "w") as target:
    json.dump(value, target, sort_keys=True)
    target.write("\n")
PY
}

replicas_for() {
	jq -er --arg name "$1" '.workloads[]|select(.name==$name)|.specReplicas' "$pre_state"
}

scale_and_wait() {
	local kind=$1 name=$2 replicas=$3
	local scale_ok=false
	for _ in $(seq 1 10); do
		if kubectl --request-timeout=30s -n "$namespace" scale "$kind/$name" \
			--replicas="$replicas" >/dev/null; then
			scale_ok=true
			break
		fi
		sleep 2
	done
	[[ $scale_ok == true ]] || {
		echo "$kind/$name scale request did not reach the API server" >&2
		return 1
	}
	for _ in $(seq 1 180); do
		# The builder reaches the private TKE API over VPC networking. A short
		# control-plane or route flap must not turn a successfully committed FDB
		# reset into an operator-only recovery. Treat an unavailable observation
		# as no observation; the bounded convergence deadline still fails closed.
		observation=$(kubectl --request-timeout=30s -n "$namespace" get "$kind/$name" \
			-o jsonpath='{.spec.replicas}{" "}{.status.readyReplicas}{"\n"}' 2>/dev/null) || {
			sleep 2
			continue
		}
		read -r desired ready <<<"$observation"
		ready=${ready:-0}
		[[ $desired == "$replicas" && $ready == "$replicas" ]] && return 0
		sleep 2
	done
	echo "$kind/$name did not converge to $replicas replicas" >&2
	return 1
}

reconcile_workerd_runner_config() {
	local runtime_image job_name job_json observation
	runtime_image=$(kubectl --request-timeout=30s -n "$namespace" get \
		statefulset/${cell}-runtime-hosts -o jsonpath='{.spec.template.spec.containers[?(@.name=="workerd-host")].image}')
	[[ $runtime_image == *@sha256:* ]] || {
		echo "runtime Host image is not digest-pinned" >&2
		return 1
	}
	job_name=${cell}-pool-reset-$(printf '%s' "$RESET_RECEIPT" | sha256sum | cut -c1-12)
	job_json=$(mktemp "$temporary/pool-reset-job.XXXXXX.json")
	jq -n --arg namespace "$namespace" --arg name "$job_name" --arg cell "$cell" \
		--arg image "$runtime_image" --arg sourceRevision "$source_revision" '{
	  apiVersion:"batch/v1",kind:"Job",
	  metadata:{namespace:$namespace,name:$name,labels:{
	    "fleet.actor.dev/cell-name":$cell,
	    "fleet.actor.dev/component":"pool-reset",
	    "fleet.actor.dev/source-revision":$sourceRevision}},
	  spec:{backoffLimit:6,ttlSecondsAfterFinished:86400,template:{metadata:{labels:{
	    "fleet.actor.dev/cell-name":$cell,"fleet.actor.dev/component":"pool-reset"}},spec:{
	    restartPolicy:"OnFailure",serviceAccountName:($cell+"-runtime"),
	    automountServiceAccountToken:false,nodeSelector:{"fleet.actor.dev/control-pool":"true"},
	    securityContext:{runAsNonRoot:true,runAsUser:4059,runAsGroup:4059,
	      seccompProfile:{type:"RuntimeDefault"}},containers:[{
	      name:"pool-reset",image:$image,imagePullPolicy:"IfNotPresent",
	      command:["/bin/bash","-ec",(
	        "exec /opt/actor/bin/init-workerd-pool")],
	      env:[
	        {name:"RIVET_HEALTH_URL",value:("http://"+$cell+"-engine:6421/health")},
	        {name:"RIVET_API_URL",value:("http://"+$cell+"-engine:6420")},
	        {name:"RIVET_NAMESPACE",value:"default"},
	        {name:"RIVET_RUNNER_NAME",value:"workerd"},
	        {name:"RIVET_AUTH_TOKEN",valueFrom:{secretKeyRef:{name:($cell+"-runtime-auth"),key:"token"}}}
	      ],resources:{requests:{cpu:"20m",memory:"32Mi"},limits:{cpu:"200m",memory:"128Mi"}},
	      securityContext:{allowPrivilegeEscalation:false,readOnlyRootFilesystem:true,
	        capabilities:{drop:["ALL"]}}}]}}}
	}' >"$job_json"
	if ! kubectl --request-timeout=30s create -f "$job_json" >/dev/null; then
		# A lost create response is ambiguous. Accept only the exact deterministic
		# Job identity rendered from this immutable reset receipt and source.
		kubectl --request-timeout=30s -n "$namespace" get job "$job_name" -o json | \
			jq -e --arg cell "$cell" --arg revision "$source_revision" '
		      .metadata.labels["fleet.actor.dev/cell-name"]==$cell and
		      .metadata.labels["fleet.actor.dev/component"]=="pool-reset" and
		      .metadata.labels["fleet.actor.dev/source-revision"]==$revision
		    ' >/dev/null || return 1
	fi
	for _ in $(seq 1 180); do
		observation=$(kubectl --request-timeout=30s -n "$namespace" get job "$job_name" \
			-o json 2>/dev/null) || { sleep 2; continue; }
		if jq -e '(.status.succeeded//0)==1' <<<"$observation" >/dev/null; then
			kubectl -n "$namespace" logs job/"$job_name" >"$temporary/pool-reset.log"
			for _ in $(seq 1 10); do
				kubectl --request-timeout=30s -n "$namespace" delete job "$job_name" \
					--wait=false >/dev/null 2>&1 && return 0
				sleep 2
			done
			echo "completed runner-config Job could not be removed" >&2
			return 1
		fi
		if jq -e '(.status.failed//0)>6' <<<"$observation" >/dev/null; then
			kubectl -n "$namespace" logs job/"$job_name" --all-containers=true >&2 || true
			return 1
		fi
		sleep 2
	done
	echo "workerd runner-config reconciliation did not complete" >&2
	return 1
}

restore_preclear_state() {
	set +e
	if [[ $config_patched == true ]]; then
		kubectl -n "$namespace" get configmap "${cell}-runtime-config" -o json >"$temporary/config-current.json"
		jq -n --arg rv "$(jq -r '.metadata.resourceVersion' "$temporary/config-current.json")" \
			--rawfile value "$temporary/config-before.jsonc" \
			'[{op:"test",path:"/metadata/resourceVersion",value:$rv},{op:"replace",path:"/data/config.jsonc",value:$value}]' \
			>"$temporary/config-rollback-patch.json"
		kubectl -n "$namespace" patch configmap "${cell}-runtime-config" --type=json \
			--patch-file "$temporary/config-rollback-patch.json" >/dev/null
	fi
	if [[ $quiesced == true ]]; then
		for name in "${cell}-runtime-capacity" "${cell}-host-drain" \
			"${cell}-worker-registry" "${cell}-engine" "${cell}-workers-api"; do
			kubectl -n "$namespace" scale deployment/"$name" --replicas="$(replicas_for "$name")" >/dev/null
		done
	fi
	set -e
}

enforce_postclear_fail_closed() {
	set +e
	for name in "${cell}-runtime-capacity" "${cell}-host-drain" \
		"${cell}-workers-api" "${cell}-worker-registry" "${cell}-engine"; do
		kubectl -n "$namespace" scale deployment/"$name" --replicas=0 >/dev/null
	done
	set -e
}

write_receipt() {
	local verdict=$1 status=$2
	local tmp_receipt=$temporary/receipt.json
	jq -n --arg verdict "$verdict" --arg phase "$phase" --argjson exitCode "$status" \
		--arg timestamp "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
		--arg cell "$cell" --arg namespace "$namespace" \
		--arg sourceRevision "$source_revision" --arg sourceManifestSha "$source_manifest_sha" \
		--arg centralInvocation "$CENTRAL_AUDIT_INVOCATION" \
		--arg expectedOldBucket "$EXPECTED_OLD_COLD_BUCKET" --arg targetBucket "$TARGET_COLD_BUCKET" \
		--arg configBeforeSha "$config_before_sha" --arg configAfterSha "$config_after_sha" \
		--arg coldInventorySha "$cold_inventory_sha" --arg clearReadVersion "$clear_read_version" \
		--arg backupBeforeSha "$backup_description_before_sha" --arg backupAfterSha "$backup_description_after_sha" \
		--argjson clearCommitted "$clear_committed" --slurpfile before "$pre_state" --slurpfile after "$post_state" '{
	  schema:"actor-bj-q01-application-state-reset/v1",timestamp:$timestamp,
	  cell:$cell,namespace:$namespace,verdict:$verdict,phase:$phase,exitCode:$exitCode,
	  source:{revision:$sourceRevision,manifestSha256:$sourceManifestSha},
	  authorization:{explicit:true,centralQ01Absent:true,centralAuditInvocation:$centralInvocation,
	    expectedLegacyColdBucket:$expectedOldBucket,targetColdBucket:$targetBucket},
	  scope:{foundationDBUserKeyspaceOnly:true,foundationDBSystemKeysPreserved:true,
	    foundationDBClusterPreserved:true,persistentVolumesPreserved:true,
	    targetColdBucketRequiredEmpty:true,legacyColdBucketUntouched:true},
	  evidence:{configBeforeSha256:$configBeforeSha,configAfterSha256:$configAfterSha,
	    targetColdInventorySha256:$coldInventorySha,clearReadVersion:$clearReadVersion,
	    backupDescriptionBeforeSha256:$backupBeforeSha,backupDescriptionAfterSha256:$backupAfterSha,
	    clearCommitted:$clearCommitted},
	  before:$before[0],after:$after[0]
	}' >"$tmp_receipt"
	chmod 0400 "$tmp_receipt"
	mv "$tmp_receipt" "$RESET_RECEIPT"
}

on_exit() {
	local status=$?
	trap - EXIT INT TERM
	if [[ $status -ne 0 && $completed == false ]]; then
		if [[ $clear_committed == false ]]; then
			restore_preclear_state
		else
			enforce_postclear_fail_closed
			echo "reset failed after the user-key clear; public clients remain fail-closed" >&2
		fi
		capture_state "$post_state" 2>/dev/null || true
		write_receipt failed "$status"
		CELL=$cell CELL_NAMESPACE=$namespace KUBECONFIG_PATH=$KUBECONFIG_PATH \
			"$cache_script" "$RESET_RECEIPT" >/dev/null 2>&1 || true
	fi
	rm -rf -- "$temporary"
	exit "$status"
}
trap on_exit EXIT INT TERM

capture_state "$pre_state"
jq -e --arg cellUid "$EXPECTED_CELL_UID" --arg fdbUid "$EXPECTED_FDB_UID" \
	--arg backupUid "$EXPECTED_BACKUP_UID" '
  .cell.uid==$cellUid and .cell.phase=="Qualifying" and
  .cell.readyForPlacement==false and .cell.placementCount==0 and .cell.activeWriters==0 and
  .foundationDB.uid==$fdbUid and .foundationDB.available==true and
  .foundationDB.fullReplication==true and .foundationDB.processGroups==9 and
  .foundationDB.generation==.foundationDB.reconciledGeneration and
  .backup.uid==$backupUid and .backup.running==true and (.backup.url|startswith("blobstore://")) and
  (.pvcs|length)==9 and all(.pvcs[];.ownerUid==$fdbUid and .phase=="Bound" and .capacity=="200Gi")
' "$pre_state" >/dev/null || { echo "q01 Cell/FDB/backup/PVC precondition failed" >&2; exit 1; }

backup_url=$(jq -er '.backup.url' "$pre_state")
backup_pod=$(kubectl -n "$namespace" get pods \
	-l "foundationdb.org/deployment-name=${cell}-continuous-backup-agents" -o json | \
	jq -er '[.items[]|select(any(.status.conditions[]?;.type=="Ready" and .status=="True"))]|.[0].metadata.name')
kubectl -n "$namespace" exec "$backup_pod" -c foundationdb -- \
	timeout 45 fdbbackup describe -d "$backup_url" >"$temporary/backup-description-before.txt"
grep -q '^Restorable: true$' "$temporary/backup-description-before.txt" || {
	echo "continuous backup is not independently restorable" >&2
	exit 1
}
backup_description_before_sha=$(sha256sum "$temporary/backup-description-before.txt" | cut -d' ' -f1)

declare -A expected_uids=(
	["${cell}-engine"]="$EXPECTED_ENGINE_UID"
	["${cell}-runtime-hosts"]="$EXPECTED_RUNTIME_UID"
	["${cell}-nats"]="$EXPECTED_NATS_UID"
	["${cell}-worker-registry"]="$EXPECTED_REGISTRY_UID"
	["${cell}-workers-api"]="$EXPECTED_WORKERS_API_UID"
)
for name in "${!expected_uids[@]}"; do
	jq -e --arg name "$name" --arg uid "${expected_uids[$name]}" \
		'.workloads[]|select(.name==$name and .uid==$uid)' "$pre_state" >/dev/null || {
		echo "workload UID changed: $name" >&2
		exit 1
	}
done
[[ $(replicas_for "${cell}-engine") == 6 && $(replicas_for "${cell}-worker-registry") == 3 \
	&& $(replicas_for "${cell}-workers-api") == 3 && $(replicas_for "${cell}-runtime-hosts") == 3 \
	&& $(replicas_for "${cell}-nats") == 3 ]] || { echo "q01 is outside the reviewed warm envelope" >&2; exit 1; }
[[ -z $(kubectl -n "$namespace" get configmap "${cell}-release-ledger" --ignore-not-found -o name) ]] || {
	echo "application-state reset is forbidden after a static release ledger exists" >&2
	exit 1
}
[[ -z $(kubectl -n "$namespace" get jobs -o json | jq -r '.items[]|select((.status.active//0)>0)|.metadata.name') ]] || {
	echo "active qualification Jobs block application-state reset" >&2
	exit 1
}
[[ -z $(kubectl -n "$namespace" get fdbscaleoperations -o json | jq -r '.items[]|select(.status.phase!="Succeeded" and .status.phase!="Failed")|.metadata.name') ]] || {
	echo "unfinished FDB scale operations block application-state reset" >&2
	exit 1
}
[[ -z $(kubectl -n "$namespace" get configmap "${cell}-runtime-release-hold" --ignore-not-found -o name) ]] || {
	echo "an existing runtime release hold blocks application-state reset" >&2
	exit 1
}
[[ -z $(kubectl get service -A -l fleet.actor.dev/cell-name="$cell" -o json | \
	jq -r '.items[]|select(.spec.type=="LoadBalancer" or .spec.type=="NodePort")|.metadata.name') ]] || {
	echo "externally exposed q01 Services block application-state reset" >&2
	exit 1
}

kubectl -n "$namespace" get configmap "${cell}-runtime-config" -o json >"$temporary/configmap-before.json"
[[ $(jq -er '.metadata.uid' "$temporary/configmap-before.json") == "$EXPECTED_RUNTIME_CONFIG_UID" ]] || {
	echo "runtime ConfigMap UID changed" >&2
	exit 1
}
jq -er '.data["config.jsonc"]' "$temporary/configmap-before.json" >"$temporary/config-before.jsonc"
jq -e --arg old "$EXPECTED_OLD_COLD_BUCKET" '
  .runtime.gasoline_cell_namespace=="actor-bj-q01" and
  .foundation_db.allow_shared_cluster==false and
  .sqlite.workflow_cold_storage.s3.bucket==$old and
  .sqlite.workflow_cold_storage.s3.endpoint=="https://cos.ap-beijing.myqcloud.com" and
  .sqlite.workflow_cold_storage.s3.region=="ap-beijing" and
  .sqlite.workflow_cold_storage.s3.addressing_style=="virtual_hosted" and
  .sqlite.workflow_cold_storage.s3.recovery_window_ms==604800000 and
  .sqlite.workflow_cold_storage.s3.max_object_size_bytes==4194304
' "$temporary/config-before.jsonc" >/dev/null || { echo "legacy config is not the exact observed identity" >&2; exit 1; }
config_before_sha=$(sha256sum "$temporary/config-before.jsonc" | cut -d' ' -f1)

runtime_secret=$(kubectl -n "$namespace" get secret "${cell}-runtime-cos" -o json)
jq -e --arg cell "$cell" --arg bucket "$TARGET_COLD_BUCKET" '
  .immutable==true and .metadata.labels["fleet.actor.dev/cell-name"]==$cell and
  .metadata.labels["fleet.actor.dev/credential-scope"]=="cell-cold" and
  .metadata.labels["fleet.actor.dev/storage-bucket"]==$bucket and
  (.data.AWS_ACCESS_KEY_ID|length)>0 and (.data.AWS_SECRET_ACCESS_KEY|length)>0
' <<<"$runtime_secret" >/dev/null || { echo "runtime COS Secret is not the exact q01 identity" >&2; exit 1; }
if [[ ! -x /data/build-cache/coscli/v1.0.9/coscli ]]; then
	COSCLI_INSTALL_ROOT=/data/build-cache/coscli "$coscli_installer" >/dev/null
fi
access_key=$(jq -r '.data.AWS_ACCESS_KEY_ID|@base64d' <<<"$runtime_secret")
secret_key=$(jq -r '.data.AWS_SECRET_ACCESS_KEY|@base64d' <<<"$runtime_secret")
/data/build-cache/coscli/v1.0.9/coscli ls "cos://$TARGET_COLD_BUCKET/" -r --limit 1 \
	--endpoint cos.ap-beijing.myqcloud.com --secret-id "$access_key" --secret-key "$secret_key" \
	--init-skip --log-path "$temporary/coscli-logs" >"$temporary/cold-inventory.txt" 2>"$temporary/cold-inventory.stderr"
unset access_key secret_key runtime_secret
grep -Eq 'TOTAL OBJECTS:.*\|[[:space:]]*0[[:space:]]*$' "$temporary/cold-inventory.txt" || {
	echo "target q01 cold bucket is not empty; refusing to orphan or overwrite objects" >&2
	exit 1
}
cold_inventory_sha=$(sha256sum "$temporary/cold-inventory.txt" | cut -d' ' -f1)

if [[ ${RESET_PREFLIGHT_ONLY:-0} == 1 ]]; then
	completed=true
	echo "q01_application_state_reset_preflight=passed source_revision=$source_revision source_manifest_sha256=$source_manifest_sha fdb_uid=$EXPECTED_FDB_UID config_sha256=$config_before_sha cold_inventory_sha256=$cold_inventory_sha"
	exit 0
fi

phase=quiesce
quiesced=true
for name in "${cell}-runtime-capacity" "${cell}-host-drain" \
	"${cell}-workers-api" "${cell}-worker-registry" "${cell}-engine"; do
	scale_and_wait deployment "$name" 0
done

phase=patch-cold-identity
python3 - "$temporary/config-before.jsonc" "$temporary/config-after.jsonc" \
	"$EXPECTED_OLD_COLD_BUCKET" "$TARGET_COLD_BUCKET" <<'PY'
import json, sys
source, target, old, new = sys.argv[1:]
text = open(source).read()
if text.count(old) != 1 or new in text:
    raise SystemExit("legacy cold bucket must occur exactly once")
updated = text.replace(old, new)
value = json.loads(updated)
if value["sqlite"]["workflow_cold_storage"]["s3"]["bucket"] != new:
    raise SystemExit("target cold identity was not rendered")
open(target, "w").write(updated)
PY
config_after_sha=$(sha256sum "$temporary/config-after.jsonc" | cut -d' ' -f1)
jq -n --arg rv "$(jq -r '.metadata.resourceVersion' "$temporary/configmap-before.json")" \
	--rawfile value "$temporary/config-after.jsonc" \
	'[{op:"test",path:"/metadata/resourceVersion",value:$rv},{op:"replace",path:"/data/config.jsonc",value:$value}]' \
	>"$temporary/config-forward-patch.json"
kubectl -n "$namespace" patch configmap "${cell}-runtime-config" --type=json \
	--patch-file "$temporary/config-forward-patch.json" >/dev/null
config_patched=true
[[ $(kubectl -n "$namespace" get configmap "${cell}-runtime-config" -o jsonpath='{.metadata.uid}') == "$EXPECTED_RUNTIME_CONFIG_UID" ]]

phase=clear-user-keyspace
fdb_pod=$(kubectl -n "$namespace" get pod -l foundationdb.org/fdb-cluster-name="$cell" -o json | \
	jq -er '[.items[]|select(any(.status.conditions[]?;.type=="Ready" and .status=="True"))]|.[0].metadata.name')
kubectl -n "$namespace" exec "$fdb_pod" -c foundationdb -- \
	fdbcli -C /var/dynamic-conf/fdb.cluster --exec 'writemode on; clearrange "" \xff' \
	>"$temporary/fdb-clear.txt"
clear_committed=true
clear_read_version=$(kubectl -n "$namespace" exec "$fdb_pod" -c foundationdb -- \
	fdbcli -C /var/dynamic-conf/fdb.cluster --exec 'getversion' | grep -Eo '[0-9]+' | tail -n 1)
kubectl -n "$namespace" exec "$fdb_pod" -c foundationdb -- \
	fdbcli -C /var/dynamic-conf/fdb.cluster --exec 'getrange "" \xff 1' \
	>"$temporary/fdb-empty-range.txt"
if grep -q '^`' "$temporary/fdb-empty-range.txt"; then
	echo "FoundationDB user keyspace is not empty after the committed clear" >&2
	exit 1
fi

phase=reset-ephemeral-runtime
scale_and_wait statefulset "${cell}-nats" 0
scale_and_wait statefulset "${cell}-nats" "$(replicas_for "${cell}-nats")"
old_runtime_uids=$(kubectl -n "$namespace" get pod -l \
	"fleet.actor.dev/cell-name=$cell,fleet.actor.dev/component=workerd-host" -o json | jq -r '.items[].metadata.uid' | sort)
kubectl -n "$namespace" delete pod -l \
	"fleet.actor.dev/cell-name=$cell,fleet.actor.dev/component=workerd-host" --wait=false >/dev/null
new_runtime_uids=
for _ in $(seq 1 300); do
	runtime_pods=$(kubectl -n "$namespace" get pod -l \
		"fleet.actor.dev/cell-name=$cell,fleet.actor.dev/component=workerd-host" -o json)
	if jq -e --argjson count "$(replicas_for "${cell}-runtime-hosts")" '
	  (.items|length)==$count and all(.items[];
	    .metadata.deletionTimestamp==null and any(.status.conditions[]?;.type=="Ready" and .status=="True"))
	' <<<"$runtime_pods" >/dev/null; then
		new_runtime_uids=$(jq -r '.items[].metadata.uid' <<<"$runtime_pods" | sort)
		[[ -n $new_runtime_uids && $new_runtime_uids != "$old_runtime_uids" ]] && break
	fi
	sleep 2
done
[[ -n $new_runtime_uids && $new_runtime_uids != "$old_runtime_uids" ]] || {
	echo "runtime Hosts did not restart from empty local state" >&2
	exit 1
}

phase=restore-service
scale_and_wait deployment "${cell}-worker-registry" "$(replicas_for "${cell}-worker-registry")"
scale_and_wait deployment "${cell}-engine" "$(replicas_for "${cell}-engine")"
phase=reconcile-runner-config
reconcile_workerd_runner_config
phase=restore-service
for name in "${cell}-workers-api" "${cell}-runtime-capacity" "${cell}-host-drain"; do
	scale_and_wait deployment "$name" "$(replicas_for "$name")"
done
for pod in $(kubectl -n "$namespace" get pod -l \
	"fleet.actor.dev/cell-name=$cell,fleet.actor.dev/component=engine" -o name); do
	if kubectl -n "$namespace" logs "$pod" --tail=200 | grep -Fq 'cold-tier identity mismatch'; then
		echo "Engine still reports a cold-tier identity mismatch" >&2
		exit 1
	fi
done
kubectl -n "$namespace" get configmap "${cell}-runtime-config" -o json | \
	jq -er '.data["config.jsonc"]' >"$temporary/config-live.jsonc"
[[ $(sha256sum "$temporary/config-live.jsonc" | cut -d' ' -f1) == "$config_after_sha" ]]

phase=verify
capture_state "$post_state"
jq -er '.backup.url' "$post_state" | grep -Fxq "$backup_url"
backup_pod=$(kubectl -n "$namespace" get pods \
	-l "foundationdb.org/deployment-name=${cell}-continuous-backup-agents" -o json | \
	jq -er '[.items[]|select(any(.status.conditions[]?;.type=="Ready" and .status=="True"))]|.[0].metadata.name')
kubectl -n "$namespace" exec "$backup_pod" -c foundationdb -- \
	timeout 45 fdbbackup describe -d "$backup_url" >"$temporary/backup-description-after.txt"
grep -q '^Restorable: true$' "$temporary/backup-description-after.txt" || {
	echo "continuous backup lost physical restorability after reset" >&2
	exit 1
}
backup_description_after_sha=$(sha256sum "$temporary/backup-description-after.txt" | cut -d' ' -f1)
jq -e --arg cellUid "$EXPECTED_CELL_UID" --arg fdbUid "$EXPECTED_FDB_UID" \
	--arg backupUid "$EXPECTED_BACKUP_UID" --slurpfile before "$pre_state" '
  .cell.uid==$cellUid and .cell.readyForPlacement==false and .cell.placementCount==0 and
  .foundationDB.uid==$fdbUid and .foundationDB.available==true and
  .foundationDB.fullReplication==true and .foundationDB.processGroups==9 and
  .backup.uid==$backupUid and .backup.running==true and (.backup.url|startswith("blobstore://")) and
  (.pvcs|sort_by(.uid))==($before[0].pvcs|sort_by(.uid)) and
  all(.workloads[] as $after;
    ($before[0].workloads[]|select(.name==$after.name)|.uid)==$after.uid and
    ($before[0].workloads[]|select(.name==$after.name)|.specReplicas)==$after.specReplicas and
    $after.readyReplicas==$after.specReplicas)
' "$post_state" >/dev/null || { echo "post-reset topology differs from the authorized identity" >&2; exit 1; }

phase=complete
write_receipt passed 0
CELL=$cell CELL_NAMESPACE=$namespace KUBECONFIG_PATH=$KUBECONFIG_PATH \
	"$cache_script" "$RESET_RECEIPT"
completed=true
echo "q01_application_state_reset=passed receipt=$RESET_RECEIPT"
