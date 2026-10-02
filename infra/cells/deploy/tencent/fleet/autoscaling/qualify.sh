#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
loadgen_result_validator=$script_dir/validate_loadgen_result.py
[[ -f $loadgen_result_validator ]] || { echo "loadgen result validator is missing" >&2; exit 2; }
fleet_dir=$(CDPATH= cd -- "$script_dir/.." && pwd)
operations_dir=$(CDPATH= cd -- "$fleet_dir/operations" && pwd)
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")
namespace=${ACTOR_CELL_NAMESPACE:-actor-fdb-cell-system}
: "${ACTOR_CELL_NAME:?ACTOR_CELL_NAME must name the exact Cell}"
cell=$ACTOR_CELL_NAME
profile=${ACTOR_FDB_PROFILE:-rivet-fdb-operator-cbs-beijing-v1}
shard_class=${ACTOR_SHARD_CLASS:-rivet-fdb-cos-kubernetes-v1}
machine_set=${ACTOR_FDB_MACHINESET:-np-fdbpool0}
run_id=${ACTOR_QUALIFICATION_RUN_ID:?ACTOR_QUALIFICATION_RUN_ID is required}
loadgen_image=${ACTOR_LOADGEN_IMAGE:?ACTOR_LOADGEN_IMAGE must be immutable}
registry_host=${ACTOR_QUALIFICATION_REGISTRY_HOST:-${loadgen_image%%/*}}
loadgen_actors=${ACTOR_QUALIFICATION_ACTORS:-10000}
loadgen_probes=${ACTOR_QUALIFICATION_PROBES:-1000}
loadgen_concurrency=${ACTOR_QUALIFICATION_CONCURRENCY:-32}
loadgen_batch_size=${ACTOR_QUALIFICATION_BATCH_SIZE:-256}
loadgen_batch_settle_seconds=${ACTOR_QUALIFICATION_BATCH_SETTLE_SECONDS:-0}
loadgen_operation_rate=${ACTOR_QUALIFICATION_OPERATION_RATE:-0}
loadgen_max_idempotent_retries=${ACTOR_QUALIFICATION_MAX_IDEMPOTENT_RETRIES:-3}
loadgen_retry_base_delay_seconds=${ACTOR_QUALIFICATION_RETRY_BASE_DELAY_SECONDS:-0.1}
loadgen_api_mode=${ACTOR_LOADGEN_API_MODE:-workers-v1}
runtime_statefulset=${ACTOR_RUNTIME_STATEFULSET:-${cell}-runtime-hosts}
runtime_machine_set=${ACTOR_RUNTIME_MACHINESET:-np-runtime0}
runtime_baseline_replicas=${ACTOR_RUNTIME_BASELINE_REPLICAS:-}
runtime_baseline_timeout=${ACTOR_RUNTIME_BASELINE_TIMEOUT_SECONDS:-10800}
operation_timeout=${ACTOR_SCALE_OPERATION_TIMEOUT_SECONDS:-5400}
node_timeout=${ACTOR_NODE_SCALE_TIMEOUT_SECONDS:-3600}
job_timeout=${ACTOR_LOADGEN_TIMEOUT_SECONDS:-7200}
receipt=${ACTOR_AUTOSCALING_RECEIPT:?ACTOR_AUTOSCALING_RECEIPT is required}
source_revision=${ACTOR_QUALIFICATION_SOURCE_REVISION:?ACTOR_QUALIFICATION_SOURCE_REVISION is required}
source_manifest=${ACTOR_QUALIFICATION_SOURCE_MANIFEST_SHA256:?ACTOR_QUALIFICATION_SOURCE_MANIFEST_SHA256 is required}
argo_namespace=${ACTOR_QUALIFICATION_ARGO_NAMESPACE:-}
argo_application=${ACTOR_QUALIFICATION_ARGO_APPLICATION:-}
argo_recovery_service_account=${ACTOR_QUALIFICATION_ARGO_RECOVERY_SERVICE_ACCOUNT:-actor-fdb-autoscaling-recovery}
argo_recovery_kubectl_image=${ACTOR_QUALIFICATION_ARGO_RECOVERY_KUBECTL_IMAGE:-}
argo_recovery_busybox_image=${ACTOR_QUALIFICATION_ARGO_RECOVERY_BUSYBOX_IMAGE:-}

[[ $loadgen_image =~ @sha256:[0-9a-f]{64}$ \
	&& $registry_host =~ ^[a-z0-9.-]+\.tencentcloudcr\.com$ \
	&& $source_revision =~ ^[0-9a-f]{40}$ && $source_manifest =~ ^[0-9a-f]{64}$ ]] || {
	echo "qualification identities must be immutable" >&2
	exit 2
}
[[ $run_id =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#run_id} -le 24 ]] || { echo "invalid qualification run ID" >&2; exit 2; }
if [[ -n $argo_application || -n $argo_namespace || -n $argo_recovery_kubectl_image || -n $argo_recovery_busybox_image ]]; then
	[[ $argo_namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
		&& $argo_application =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
		&& $argo_recovery_service_account =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
		&& $argo_recovery_kubectl_image =~ @sha256:[0-9a-f]{64}$ \
		&& $argo_recovery_busybox_image =~ @sha256:[0-9a-f]{64}$ ]] || {
		echo "Argo qualification recovery requires exact namespace, Application, ServiceAccount and immutable images" >&2
		exit 2
	}
fi
[[ $loadgen_api_mode == workers-v1 ]] || {
	echo "production FDB qualification must use the public Workers /v1 API" >&2
	exit 2
}
for value in "$loadgen_actors" "$loadgen_probes" "$loadgen_concurrency" "$loadgen_batch_size" "$operation_timeout" "$node_timeout" "$job_timeout"; do
	[[ $value =~ ^[1-9][0-9]*$ ]] || { echo "qualification tunables must be positive integers" >&2; exit 2; }
done
[[ $loadgen_max_idempotent_retries =~ ^([0-9]|10)$ ]] || { echo "max idempotent retries must be between 0 and 10" >&2; exit 2; }
for value in "$loadgen_batch_settle_seconds" "$loadgen_operation_rate" "$loadgen_retry_base_delay_seconds"; do
	[[ $value =~ ^([0-9]+)(\.[0-9]+)?$ ]] || { echo "qualification timing parameters must be non-negative numbers" >&2; exit 2; }
done
python3 - "$loadgen_batch_settle_seconds" "$loadgen_operation_rate" "$loadgen_retry_base_delay_seconds" <<'PY'
import sys
settle, rate, retry = map(float, sys.argv[1:])
if settle > 300 or rate > 1000 or retry <= 0 or retry > 5:
    raise SystemExit("qualification timing parameters exceed harness safety bounds")
PY
if [[ -z $runtime_baseline_replicas ]]; then
	runtime_baseline_replicas=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get hpa \
		"${cell}-runtime-hosts-actor-capacity" -o jsonpath='{.spec.minReplicas}')
fi
[[ $runtime_baseline_replicas =~ ^[1-9][0-9]*$ && $runtime_baseline_replicas -ge 4 \
	&& $runtime_baseline_timeout =~ ^[1-9][0-9]*$ ]] || {
	echo "invalid Runtime isolation floor; production requires at least four Hosts" >&2
	exit 2
}
((loadgen_probes <= loadgen_actors && loadgen_actors <= 1000000)) || { echo "invalid qualification Actor cardinality" >&2; exit 2; }

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="autoscaling.qualify" \
	AUTONOMY_CONTROL_CELL="$cell" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
	"$operations_dir/assert-autonomy-control.sh"
fi

temporary=$(mktemp -d)
: >"$temporary/runtime-timeline.jsonl"
: >"$temporary/loadgen-results.jsonl"
started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
stage=preflight
verdict=failed
snapshots_ready=false
profile_modified=false
argo_self_heal_suspended=false
argo_application_uid=
argo_recovery_job=
baseline_mode=
up_operation=
down_operation=

auxiliary_storage=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods -l foundationdb.org/fdb-process-class=storage -o json | python3 -c 'import json,sys
cell=sys.argv[1]; print(sum(1 for p in json.load(sys.stdin).get("items",[]) if p.get("metadata",{}).get("deletionTimestamp") is None and p.get("metadata",{}).get("labels",{}).get("foundationdb.org/fdb-cluster-name") != cell))' "$cell")
baseline_nodes=$((((9 + auxiliary_storage + 2) / 3) * 3))
expanded_nodes=$((((12 + auxiliary_storage + 2) / 3) * 3))

backup_exact_restorable() {
	local backup_url backup_pod description
	backup_url=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get foundationdbbackup "${cell}-continuous" \
		-o jsonpath='{.status.backupDetails.url}')
	[[ $backup_url == blobstore://* ]] || return 1
	backup_pod=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
		-l "foundationdb.org/deployment-name=${cell}-continuous-backup-agents" \
		-o jsonpath='{.items[0].metadata.name}')
	[[ -n $backup_pod ]] || return 1
	description=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" exec "$backup_pod" \
		-c foundationdb -- timeout 45 fdbbackup describe -d "$backup_url")
	grep -q '^Restorable: true$' <<<"$description"
}

argo_enabled() { [[ -n $argo_application ]]; }

assert_argo_ready() {
	argo_enabled || return 0
	local application
	application=$(kubectl "${kubeconfig_args[@]}" -n "$argo_namespace" get application "$argo_application" -o json)
	argo_application_uid=$(printf '%s' "$application" | python3 -c 'import json,re,sys
d=json.load(sys.stdin); m=d.get("metadata",{}); s=d.get("spec",{}); st=d.get("status",{})
assert re.fullmatch(r"[0-9a-f-]{36}",m.get("uid", ""))
assert s.get("syncPolicy",{}).get("automated",{}).get("selfHeal") is True
assert st.get("sync",{}).get("status")=="Synced" and st.get("health",{}).get("status")=="Healthy"
assert st.get("operationState",{}).get("phase") in (None,"Succeeded")
print(m["uid"])')
	kubectl "${kubeconfig_args[@]}" -n "$argo_namespace" get serviceaccount "$argo_recovery_service_account" >/dev/null
}

start_argo_recovery_guard() {
	local direction=$1 guard_seconds=$2 manifest pod deadline state
	argo_enabled || return 0
	[[ $direction == up || $direction == down ]]
	[[ $guard_seconds =~ ^[1-9][0-9]*$ && $guard_seconds -le 7200 ]]
	assert_argo_ready
	argo_recovery_job="actor-fdb-argo-recovery-${run_id}-${direction}"
	argo_recovery_job=${argo_recovery_job:0:63}
	kubectl "${kubeconfig_args[@]}" -n "$argo_namespace" delete job "$argo_recovery_job" --ignore-not-found --wait=true >/dev/null
	manifest=$temporary/argo-recovery-${direction}.json
	python3 - "$manifest" "$argo_namespace" "$argo_recovery_job" "$cell" "$run_id" \
		"$argo_recovery_service_account" "$argo_recovery_busybox_image" "$argo_recovery_kubectl_image" \
		"$guard_seconds" "$argo_application" "$argo_application_uid" <<'PY'
import json,sys
(path,namespace,name,cell,run_id,service_account,busybox,kubectl_image,
 delay,application,application_uid)=sys.argv[1:]
patch=json.dumps([
 {"op":"test","path":"/metadata/uid","value":application_uid},
 {"op":"test","path":"/spec/syncPolicy/automated/selfHeal","value":False},
 {"op":"replace","path":"/spec/syncPolicy/automated/selfHeal","value":True},
 {"op":"add","path":"/metadata/annotations/argocd.argoproj.io~1refresh","value":"hard"},
],separators=(",",":"))
labels={"app.kubernetes.io/name":"actor-fdb-autoscaling-recovery","fleet.actor.dev/cell-name":cell,"fleet.actor.dev/qualification-run-id":run_id}
restricted={"allowPrivilegeEscalation":False,"readOnlyRootFilesystem":True,"runAsNonRoot":True,"runAsUser":65532,"runAsGroup":65532,"capabilities":{"drop":["ALL"]}}
doc={"apiVersion":"batch/v1","kind":"Job","metadata":{"name":name,"namespace":namespace,"labels":labels},
 "spec":{"backoffLimit":0,"activeDeadlineSeconds":int(delay)+300,"ttlSecondsAfterFinished":3600,
  "template":{"metadata":{"labels":labels},"spec":{"restartPolicy":"Never","serviceAccountName":service_account,
   "automountServiceAccountToken":True,"imagePullSecrets":[{"name":"actor-fleet-tcr"}],
   "securityContext":{"seccompProfile":{"type":"RuntimeDefault"}},
   "initContainers":[
    {"name":"verify-kubectl","image":kubectl_image,"imagePullPolicy":"IfNotPresent","command":["kubectl"],"args":["version","--client=true"],"securityContext":restricted,"resources":{"requests":{"cpu":"5m","memory":"16Mi"},"limits":{"cpu":"50m","memory":"64Mi"}}},
    {"name":"delay","image":busybox,"imagePullPolicy":"IfNotPresent","command":["/bin/sh","-ceu"],"args":["sleep \"$1\"","delay",delay],"securityContext":restricted,"resources":{"requests":{"cpu":"1m","memory":"4Mi"},"limits":{"cpu":"10m","memory":"16Mi"}}}],
   "containers":[{"name":"recover","image":kubectl_image,"imagePullPolicy":"IfNotPresent","command":["kubectl"],
    "args":["-n",namespace,"patch","application",application,"--type=json","-p",patch],"securityContext":restricted,
    "resources":{"requests":{"cpu":"5m","memory":"16Mi"},"limits":{"cpu":"50m","memory":"64Mi"}}}]}}}}
open(path,"w").write(json.dumps(doc,separators=(",",":"))+"\n")
PY
	kubectl "${kubeconfig_args[@]}" apply --dry-run=server -f "$manifest" >/dev/null
	kubectl "${kubeconfig_args[@]}" apply -f "$manifest" >/dev/null
	deadline=$((SECONDS + 180))
	while ((SECONDS < deadline)); do
		pod=$(kubectl "${kubeconfig_args[@]}" -n "$argo_namespace" get pods -l "job-name=$argo_recovery_job" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
		if [[ -n $pod ]]; then
			state=$(kubectl "${kubeconfig_args[@]}" -n "$argo_namespace" get pod "$pod" -o json | python3 -c 'import json,sys
d=json.load(sys.stdin); statuses={x["name"]:x for x in d.get("status",{}).get("initContainerStatuses",[])}
verified=statuses.get("verify-kubectl",{}).get("state",{}).get("terminated",{}).get("exitCode")==0
delaying="running" in statuses.get("delay",{}).get("state",{})
print("ready" if verified and delaying else "failed" if any(x.get("state",{}).get("terminated",{}).get("exitCode",0)!=0 for x in statuses.values()) else "waiting")')
			[[ $state == ready ]] && break
			[[ $state == failed ]] && { echo "Argo recovery guard image preflight failed" >&2; return 1; }
		fi
		sleep 3
	done
	[[ ${state:-} == ready ]] || { echo "Argo recovery guard did not become durable" >&2; return 1; }
	local patch
	patch=$(python3 -c 'import json,sys; print(json.dumps([{"op":"test","path":"/metadata/uid","value":sys.argv[1]},{"op":"test","path":"/spec/syncPolicy/automated/selfHeal","value":True},{"op":"replace","path":"/spec/syncPolicy/automated/selfHeal","value":False}],separators=(",",":")))' "$argo_application_uid")
	kubectl "${kubeconfig_args[@]}" -n "$argo_namespace" patch application "$argo_application" --type json -p "$patch" >/dev/null
	argo_self_heal_suspended=true
}

resume_argo_self_heal() {
	argo_enabled || return 0
	[[ $argo_self_heal_suspended == true ]] || return 0
	local patch application deadline
	patch=$(python3 -c 'import json,sys; print(json.dumps([{"op":"test","path":"/metadata/uid","value":sys.argv[1]},{"op":"test","path":"/spec/syncPolicy/automated/selfHeal","value":False},{"op":"replace","path":"/spec/syncPolicy/automated/selfHeal","value":True},{"op":"add","path":"/metadata/annotations/argocd.argoproj.io~1refresh","value":"hard"}],separators=(",",":")))' "$argo_application_uid")
	if ! kubectl "${kubeconfig_args[@]}" -n "$argo_namespace" patch application "$argo_application" --type json -p "$patch" >/dev/null; then
		application=$(kubectl "${kubeconfig_args[@]}" -n "$argo_namespace" get application "$argo_application" -o json)
		printf '%s' "$application" | python3 -c 'import json,sys; d=json.load(sys.stdin); assert d["metadata"]["uid"]==sys.argv[1] and d["spec"]["syncPolicy"]["automated"]["selfHeal"] is True' "$argo_application_uid"
	fi
	deadline=$((SECONDS + 300))
	while ((SECONDS < deadline)); do
		if kubectl "${kubeconfig_args[@]}" -n "$argo_namespace" get application "$argo_application" -o json | python3 -c 'import json,sys; d=json.load(sys.stdin); s=d.get("status",{}); assert d["spec"]["syncPolicy"]["automated"]["selfHeal"] is True and s.get("sync",{}).get("status")=="Synced" and s.get("health",{}).get("status")=="Healthy" and s.get("operationState",{}).get("phase") in (None,"Succeeded")'; then
			argo_self_heal_suspended=false
			kubectl "${kubeconfig_args[@]}" -n "$argo_namespace" delete job "$argo_recovery_job" --ignore-not-found --wait=false >/dev/null
			argo_recovery_job=
			return 0
		fi
		sleep 5
	done
	echo "Argo self-heal did not return to Synced/Healthy" >&2
	return 1
}

restore_profile() {
	local status=0
	if [[ $snapshots_ready == true && $profile_modified == true ]]; then
		kubectl "${kubeconfig_args[@]}" patch rivetcellprofile "$profile" --type merge -p "$(<"$temporary/profile-restore.json")" >/dev/null || status=$?
		kubectl "${kubeconfig_args[@]}" patch shardclass "$shard_class" --type merge -p "$(<"$temporary/class-restore.json")" >/dev/null || status=$?
		profile_modified=false
	fi
	resume_argo_self_heal || status=$?
	return "$status"
}

recover_unpublished_scale_up() (
	set -e
	[[ -n $up_operation && -z $down_operation ]] || return 0
	backup_exact_restorable
	local recovery
	recovery=$(python3 - "${kubeconfig_args[@]}" "$namespace" "$cell" "$up_operation" <<'PY'
import json,subprocess,sys
args=sys.argv[1:-3]; namespace,cell,operation_name=sys.argv[-3:]
def get(*parts): return json.loads(subprocess.check_output(["kubectl",*args,*parts,"-o","json"]))
operation=get("-n",namespace,"get","fdbscaleoperation",operation_name)
spec,status=operation.get("spec",{}),operation.get("status",{})
if status.get("phase") in ("Succeeded","Failed","RolledBack"):
    raise SystemExit(3)
source,target=spec.get("fromProcessCount"),spec.get("toProcessCount")
if spec.get("direction")!="Up" or not isinstance(source,int) or target<=source:
    raise SystemExit(3)
fdb=get("-n",namespace,"get","foundationdbcluster",cell); health=fdb.get("status",{}).get("health",{})
if (fdb.get("spec",{}).get("processCounts",{}).get("storage")!=source or
    fdb.get("status",{}).get("generations",{}).get("reconciled")!=fdb.get("metadata",{}).get("generation") or
    not health.get("available") or not health.get("healthy") or not health.get("fullReplication")):
    raise SystemExit(3)
backup=get("-n",namespace,"get","foundationdbbackup",cell+"-continuous").get("status",{}).get("backupDetails",{})
if not backup.get("running"):
    raise SystemExit(3)
machine_name=spec.get("nodeCapacityRef",{}).get("machineSetName")
auxiliary=sum(1 for p in get("-n",namespace,"get","pods","-l","foundationdb.org/fdb-process-class=storage").get("items",[]) if p.get("metadata",{}).get("deletionTimestamp") is None and p.get("metadata",{}).get("labels",{}).get("foundationdb.org/fdb-cluster-name") != cell)
source_nodes=((source+auxiliary+2)//3)*3
machine=get("get","machineset",machine_name); machine_status=machine.get("status",{})
if (machine.get("spec",{}).get("replicas")!=source_nodes or machine_status.get("replicas")!=source_nodes or
    machine_status.get("readyReplicas")!=source_nodes or machine_status.get("availableReplicas")!=source_nodes):
    raise SystemExit(3)
print(json.dumps({"source":source,"sourceNodes":source_nodes,"machineSet":machine_name},separators=(",",":")))
PY
	) || return 0
	local source source_nodes machine_set recovery_time
	source=$(printf '%s' "$recovery" | python3 -c 'import json,sys; print(json.load(sys.stdin)["source"])')
	source_nodes=$(printf '%s' "$recovery" | python3 -c 'import json,sys; print(json.load(sys.stdin)["sourceNodes"])')
	machine_set=$(printf '%s' "$recovery" | python3 -c 'import json,sys; print(json.load(sys.stdin)["machineSet"])')
	recovery_time=$(date -u +%Y-%m-%dT%H:%M:%SZ)

	# This is not a database contraction: the larger FDB target was never
	# published. Close the abandoned operation before lowering the unused TKE
	# floor so a failed qualification cannot leave a latent capacity mutation.
	kubectl "${kubeconfig_args[@]}" -n "$namespace" patch rivetcell "$cell" --subresource=status --type merge \
		-p "{\"status\":{\"foundationDBAutoscaling\":{\"mode\":\"$baseline_mode\",\"desiredProcessCount\":$source,\"observedProcessCount\":$source,\"recommendedProcessCount\":$source,\"phase\":\"Stable\",\"reason\":\"qualification recovered the unpublished scale-up target\"}}}" >/dev/null
	kubectl "${kubeconfig_args[@]}" -n "$namespace" patch fdbscaleoperation "$up_operation" --subresource=status --type merge \
		-p "{\"status\":{\"phase\":\"Failed\",\"conditions\":[{\"type\":\"Failed\",\"status\":\"True\",\"reason\":\"QualificationAbortedBeforeTargetPublication\",\"message\":\"FDB stayed fully replicated at the source topology; the unused TKE capacity floor was restored\",\"lastTransitionTime\":\"$recovery_time\"}]}}" >/dev/null
	kubectl "${kubeconfig_args[@]}" patch machineset "$machine_set" --type merge \
		-p "{\"spec\":{\"replicas\":$source_nodes,\"scaling\":{\"minReplicas\":$source_nodes}}}" >/dev/null
	echo "recovered unpublished scale-up $up_operation to $source FDB processes and $source_nodes nodes" >&2
)

write_receipt() {
	local exit_status=$1
	local backup_restorable=false
	if backup_exact_restorable; then
		backup_restorable=true
	fi
	install -d -m 0700 "$(dirname -- "$receipt")"
    python3 - "${kubeconfig_args[@]}" "$namespace" "$cell" "$machine_set" "$run_id" "$started_at" "$stage" "$verdict" "$exit_status" "$source_revision" "$source_manifest" "$loadgen_image" "$up_operation" "$down_operation" "$backup_restorable" "$temporary/runtime-timeline.jsonl" "$temporary/loadgen-results.jsonl" "$baseline_mode" "$loadgen_actors" "$loadgen_probes" "$loadgen_concurrency" "$loadgen_batch_size" "$loadgen_batch_settle_seconds" "$loadgen_operation_rate" "$loadgen_max_idempotent_retries" "$loadgen_retry_base_delay_seconds" "$runtime_baseline_replicas" "$receipt" <<'PY'
import hashlib,json,subprocess,sys
args=sys.argv[1:-27]
(namespace,cell,machine_set,run_id,started_at,stage,verdict,exit_status,source_revision,source_manifest,loadgen_image,up_name,down_name,backup_restorable,runtime_timeline,loadgen_results,baseline_mode,target_actors,probe_actors,concurrency,batch_size,batch_settle_seconds,operation_rate,max_idempotent_retries,retry_base_delay_seconds,runtime_baseline_replicas,receipt)=sys.argv[-27:]
def get(*parts):
    return json.loads(subprocess.check_output(["kubectl",*args,*parts,"-o","json"]))
def maybe(*parts):
    try: return get(*parts)
    except Exception as error: return {"captureError":str(error)}
fdb=maybe("-n",namespace,"get","foundationdbcluster",cell)
backup=maybe("-n",namespace,"get","foundationdbbackup",cell+"-continuous")
if isinstance(backup.get("status",{}).get("backupDetails"),dict):
    backup["status"]["backupDetails"]["restorable"] = backup_restorable == "true"
machine=maybe("get","machineset",machine_set)
cell_obj=maybe("-n",namespace,"get","rivetcell",cell)
report=maybe("-n",namespace,"get","rivetcellreport",cell)
class_name=cell_obj.get("spec",{}).get("className")
shard_class=maybe("get","shardclass",class_name) if class_name else {"captureError":"RivetCell className missing"}
profile_name=shard_class.get("spec",{}).get("profileRef",{}).get("name")
profile=maybe("get","rivetcellprofile",profile_name) if profile_name else {"captureError":"ShardClass profileRef missing"}
profile_spec=profile.get("spec",{})
profile_digest=("sha256:"+hashlib.sha256(json.dumps(profile_spec,sort_keys=True,separators=(",", ":")).encode()).hexdigest()) if profile_spec else None
profile_binding={
 "className":class_name,
 "profileName":profile_name,
 "profileDigest":profile_digest,
 "driverABI":profile_spec.get("driverABI"),
 "region":profile_spec.get("region"),
 "imageInventoryDigest":profile.get("metadata",{}).get("annotations",{}).get("fleet.actor.dev/image-inventory-digest"),
}
operations=maybe("-n",namespace,"get","fdbscaleoperations")
# A resumed qualification can finish after the original shell has exited.  Its
# two operation names are immutable evidence; a wall-clock filter is not.
# Capture exactly those operations when they are known, rather than silently
# producing a receipt that also contains an unrelated operation created later.
if "items" in operations:
    expected={name for name in (up_name,down_name) if name}
    operations["items"]=[x for x in operations["items"] if not expected or x.get("metadata",{}).get("name") in expected]
retirements=maybe("-n",namespace,"get","fdbvolumeretirements")
operation_uids={x.get("metadata",{}).get("uid") for x in operations.get("items",[])}
if "items" in retirements:
    retirements["items"]=[x for x in retirements["items"] if x.get("spec",{}).get("scaleOperationRef",{}).get("uid") in operation_uids]
jobs=maybe("-n",namespace,"get","jobs","-l",f"app.kubernetes.io/name=actor-fdb-autoscale-loadgen")
if "items" in jobs:
    jobs["items"]=[x for x in jobs["items"] if x.get("metadata",{}).get("annotations",{}).get("fleet.actor.dev/loadgen-run-id")==run_id]
nodes=maybe("get","nodes","-l",f"node.tke.cloud.tencent.com/machineset={machine_set}")
timeline=[]
try:
    with open(runtime_timeline) as source:
        timeline=[json.loads(line) for line in source if line.strip()]
except Exception as error:
    timeline=[{"captureError":str(error)}]
results=[]
try:
    with open(loadgen_results) as source:
        results=[json.loads(line) for line in source if line.strip()]
except Exception as error:
    results=[{"captureError":str(error)}]
document={
 "schemaVersion":"actor-fdb-autoscaling-qualification-v5","verdict":verdict,"exitStatus":int(exit_status),"stage":stage,
 "startedAt":started_at,"completedAt":__import__("datetime").datetime.utcnow().replace(microsecond=0).isoformat()+"Z",
 "sourceRevision":source_revision,"sourceManifestSHA256":source_manifest,"loadgenImage":loadgen_image,
 "cell":cell,"runID":run_id,"upOperation":up_name or None,"downOperation":down_name or None,"publicApiOnly":True,
 "baselineAutoscalingMode":baseline_mode,"profileBinding":profile_binding,
 "loadgenConfig":{"targetActors":int(target_actors),"probeActors":int(probe_actors),"concurrency":int(concurrency),
                  "batchSize":int(batch_size),"batchSettleSeconds":float(batch_settle_seconds),
                  "operationRate":float(operation_rate),"maxIdempotentRetries":int(max_idempotent_retries),
                  "retryBaseDelaySeconds":float(retry_base_delay_seconds),
                  "runtimeBaselineReplicas":int(runtime_baseline_replicas)},
 "foundationDB":fdb,"backup":backup,"machineSet":machine,"nodes":nodes,"rivetCell":cell_obj,"cellReport":report,
 "scaleOperations":operations,"volumeRetirements":retirements,"loadgenJobs":jobs,
 "runtimeIsolationTimeline":timeline,
 "loadgenResults":results,
}
payload=json.dumps(document,indent=2,sort_keys=True).encode()+b"\n"
open(receipt,"wb").write(payload)
print("autoscaling_receipt="+receipt)
print("autoscaling_receipt_sha256="+hashlib.sha256(payload).hexdigest())
PY
}

finish() {
	local status=$1
	trap - EXIT INT TERM
	set +e
	restore_profile
	local restore_status=$?
	if [[ $status -eq 0 && $restore_status -ne 0 ]]; then status=$restore_status; verdict=failed; stage=restore-production-profile; fi
	if [[ $status -ne 0 ]]; then
		recover_unpublished_scale_up || echo "unpublished scale-up recovery did not pass its safety gates; preserving live state" >&2
	fi
	write_receipt "$status"
	rm -rf -- "$temporary"
	exit "$status"
}
trap 'finish $?' EXIT
trap 'finish 130' INT
trap 'finish 143' TERM

backup_exact_restorable
python3 - "${kubeconfig_args[@]}" "$namespace" "$cell" "$profile" "$shard_class" "$machine_set" "$loadgen_image" "$registry_host" "$run_id" "$baseline_nodes" "$temporary/profile-restore.json" "$temporary/class-restore.json" <<'PY'
import hashlib,json,subprocess,sys
args=sys.argv[1:-11]
(namespace,cell,profile_name,class_name,machine_set,loadgen_image,registry_host,run_id,baseline_nodes,profile_restore,class_restore)=sys.argv[-11:]; baseline_nodes=int(baseline_nodes)
def get(*parts): return json.loads(subprocess.check_output(["kubectl",*args,*parts,"-o","json"]))
def require(value, reason):
    if not value: raise SystemExit("FDB autoscaling preflight: "+reason)
jobs=get("get","jobs","-A").get("items",[])
active=[x for x in jobs if x.get("status",{}).get("active",0)]
foreign=[x for x in active if x.get("metadata",{}).get("annotations",{}).get("fleet.actor.dev/loadgen-run-id") != run_id or
         x.get("metadata",{}).get("labels",{}).get("app.kubernetes.io/name") != "actor-fdb-autoscale-loadgen"]
require(not foreign,"another active Job exists outside this exact loadgen run")
fdb=get("-n",namespace,"get","foundationdbcluster",cell); h=fdb.get("status",{}).get("health",{})
require(fdb.get("spec",{}).get("processCounts",{}).get("storage")==9,"Cell FDB is not at the nine-storage baseline")
require(h.get("available") and h.get("healthy") and h.get("fullReplication"),"Cell FDB is not healthy and fully replicated")
require(fdb.get("status",{}).get("generations",{}).get("reconciled")==fdb["metadata"]["generation"],"Cell FDB generation is not reconciled")
backup=get("-n",namespace,"get","foundationdbbackup",cell+"-continuous").get("status",{}).get("backupDetails",{})
require(backup.get("running"),"continuous backup is not running")
cell_obj=get("-n",namespace,"get","rivetcell",cell); autoscale=cell_obj.get("status",{}).get("foundationDBAutoscaling",{})
require(cell_obj.get("spec",{}).get("className")==class_name,"Cell is not bound to the expected ShardClass")
require(autoscale.get("mode") in ("ObserveOnly", "Automatic") and autoscale.get("desiredProcessCount")==9,"Cell autoscaling status is not stable at nine processes")
report=get("-n",namespace,"get","rivetcellreport",cell); capacity=report.get("spec",{}).get("capacity",{})
require(capacity.get("fdbCapacityEvidenceReady") is True and capacity.get("fdbDataMovementBytes")==0,"Cell capacity evidence is not ready or FDB data movement is active")
machine=get("get","machineset",machine_set); scaling=machine.get("spec",{}).get("scaling",{})
require(machine.get("spec",{}).get("replicas")==baseline_nodes and scaling=={"createPolicy":"ZoneEquality","minReplicas":baseline_nodes,"maxReplicas":30},"FDB MachineSet spec/scaling policy does not match the computed baseline")
require(machine.get("status",{}).get("readyReplicas")==machine.get("status",{}).get("availableReplicas")==baseline_nodes,"FDB MachineSet is not fully Ready at the computed baseline")
controllers=get("get","deployment","-A","-l","app.kubernetes.io/name=actor-fleet-controller").get("items",[])
require(len(controllers)==1 and controllers[0]["spec"]["template"]["spec"]["containers"][0]["image"].startswith(registry_host+"/"),"fleet controller is not uniquely bound to the regional registry")
require(loadgen_image.startswith(registry_host+"/"),"loadgen image is not bound to the regional registry")
operations=get("-n",namespace,"get","fdbscaleoperations").get("items",[])
require(not [x for x in operations if x.get("status",{}).get("phase") not in ("Succeeded","Failed","RolledBack")],"another FDBScaleOperation is non-terminal")
profile=get("get","rivetcellprofile",profile_name); shard_class=get("get","shardclass",class_name)
require(shard_class.get("spec",{}).get("profileRef",{}).get("name")==profile_name,"ShardClass references another StorageProfile")
canonical=json.dumps(profile["spec"],sort_keys=True,separators=(",",":")).encode()
digest="sha256:"+hashlib.sha256(canonical).hexdigest()
require(shard_class["spec"]["profileRef"]=={"name":profile_name,"digest":digest},"ShardClass profile digest does not match the canonical StorageProfile")
json.dump({"spec":{"foundationDB":{"autoscaling":profile["spec"]["foundationDB"]["autoscaling"]}}},open(profile_restore,"w"),separators=(",",":"))
json.dump({"spec":{"profileRef":{"name":profile_name,"digest":digest}}},open(class_restore,"w"),separators=(",",":"))
PY
snapshots_ready=true
baseline_mode=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["spec"]["foundationDB"]["autoscaling"]["mode"])' "$temporary/profile-restore.json")
[[ $baseline_mode == ObserveOnly || $baseline_mode == Automatic ]]

set_profile() {
	local direction=$1
	local headroom
	headroom=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get rivetcellreport "$cell" -o jsonpath='{.spec.capacity.fdbStorageHeadroomBytes}')
	python3 - "$direction" "$headroom" "$temporary/profile-patch.json" <<'PY'
import json,sys
direction,headroom,path=sys.argv[1:]; headroom=int(headroom)
if direction=="up":
    up=headroom+1073741824; down=up+1073741824
elif direction=="down":
    up=10737418240; down=21474836480
else: raise SystemExit("invalid qualification direction")
policy={
 "mode":"Automatic","minProcessCount":9,"maxProcessCount":12,"stepProcessCount":3,
 "scaleUp":{"headroomBytes":up,"etaSeconds":3600,"sustainSeconds":300,"cooldownSeconds":300,"minimumSamples":1},
 "scaleDown":{"headroomBytes":down,"writeUtilizationPercent":50,"sustainSeconds":3600,"cooldownSeconds":3600,"minimumSamples":1},
 "volumeRetentionSeconds":2592000,"volumeGCMode":"ObserveOnly",
}
json.dump({"spec":{"foundationDB":{"autoscaling":policy}}},open(path,"w"),separators=(",",":"))
PY
	kubectl "${kubeconfig_args[@]}" patch rivetcellprofile "$profile" --type merge -p "$(<"$temporary/profile-patch.json")" >/dev/null
	profile_modified=true
	digest=$(kubectl "${kubeconfig_args[@]}" get rivetcellprofile "$profile" -o json | python3 -c 'import hashlib,json,sys; spec=json.load(sys.stdin)["spec"]; print("sha256:"+hashlib.sha256(json.dumps(spec,sort_keys=True,separators=(",",":")).encode()).hexdigest())')
	kubectl "${kubeconfig_args[@]}" patch shardclass "$shard_class" --type merge \
		-p "{\"spec\":{\"profileRef\":{\"name\":\"$profile\",\"digest\":\"$digest\"}}}" >/dev/null
}

wait_cell_desired() {
	local desired=$1 wait_seconds=${2:-600}
	local deadline=$((SECONDS + wait_seconds))
	while ((SECONDS < deadline)); do
		record_runtime_snapshot >/dev/null
		if [[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get rivetcell "$cell" -o jsonpath='{.status.foundationDBAutoscaling.mode}') == Automatic && \
			$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get rivetcell "$cell" -o jsonpath='{.status.foundationDBAutoscaling.desiredProcessCount}') == "$desired" ]]; then return 0; fi
		sleep 10
	done
	echo "Cell did not choose FDB target $desired" >&2
	return 1
}

find_operation() {
	local from=$1 to=$2 deadline=$((SECONDS + 600))
	while ((SECONDS < deadline)); do
		record_runtime_snapshot >/dev/null
		name=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get fdbscaleoperations -o json | python3 -c 'import json,sys
start,source,target=sys.argv[1:]; items=json.load(sys.stdin).get("items",[])
items=[x for x in items if x.get("metadata",{}).get("creationTimestamp","")>=start and x.get("spec",{}).get("fromProcessCount")==int(source) and x.get("spec",{}).get("toProcessCount")==int(target)]
print(sorted(items,key=lambda x:x["metadata"]["creationTimestamp"])[-1]["metadata"]["name"] if items else "")' "$started_at" "$from" "$to")
		[[ -n $name ]] && { printf '%s\n' "$name"; return 0; }
		sleep 10
	done
	return 1
}

wait_operation() {
	local name=$1 deadline=$((SECONDS + operation_timeout))
	while ((SECONDS < deadline)); do
		record_runtime_snapshot >/dev/null
		phase=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get fdbscaleoperation "$name" -o jsonpath='{.status.phase}')
		case "$phase" in Succeeded) return 0 ;; Failed | RolledBack) echo "scale operation $name ended in $phase" >&2; return 1 ;; esac
		sleep 15
	done
	echo "scale operation $name timed out" >&2
	return 1
}

wait_topology() {
	local expected_processes=$1 expected_nodes=$2 deadline=$((SECONDS + node_timeout))
	while ((SECONDS < deadline)); do
		record_runtime_snapshot >/dev/null
		if python3 - "${kubeconfig_args[@]}" "$namespace" "$cell" "$machine_set" "$expected_processes" "$expected_nodes" <<'PY'
import json,subprocess,sys
args=sys.argv[1:-5]; namespace,cell,machine_set,expected_processes,expected_nodes=sys.argv[-5:]; expected_processes=int(expected_processes); expected_nodes=int(expected_nodes)
def get(*parts): return json.loads(subprocess.check_output(["kubectl",*args,*parts,"-o","json"]))
machine=get("get","machineset",machine_set); status=machine.get("status",{})
assert status.get("readyReplicas")==status.get("availableReplicas")==expected_nodes
nodes=get("get","nodes","-l",f"node.tke.cloud.tencent.com/machineset={machine_set}").get("items",[])
node_zones=[x.get("metadata",{}).get("labels",{}).get("topology.kubernetes.io/zone") for x in nodes]
assert len(nodes)==expected_nodes and None not in node_zones and len(set(node_zones))==3
counts=[node_zones.count(zone) for zone in set(node_zones)]; assert max(counts)-min(counts)<=1
pods=get("-n",namespace,"get","pods","-l",f"foundationdb.org/fdb-cluster-name={cell},foundationdb.org/fdb-process-class=storage").get("items",[])
ready=[p for p in pods if p.get("status",{}).get("phase")=="Running" and all(c.get("ready") for c in p.get("status",{}).get("containerStatuses",[]))]
assert len(ready)==expected_processes and len({p.get("spec",{}).get("nodeName") for p in ready})==expected_processes
PY
		then return 0; fi
		sleep 15
	done
	echo "TKE/FDB topology did not converge to $expected_processes primary processes / $expected_nodes shared nodes" >&2
	return 1
}

job_name() {
	local mode=$1 suffix=$2
	local name="${cell}-fdb-load-${mode}-${run_id}"
	[[ -n $suffix ]] && name="${name}-${suffix}"
	printf '%s\n' "${name:0:57}"
}

start_loadgen() {
	local mode=$1 suffix=$2
	ACTOR_LOADGEN_MODE=$mode ACTOR_LOADGEN_JOB_SUFFIX=$suffix ACTOR_LOADGEN_RUN_ID=$run_id \
	ACTOR_LOADGEN_IMAGE=$loadgen_image ACTOR_LOADGEN_TARGET_ACTORS=$loadgen_actors \
	ACTOR_LOADGEN_PROBE_ACTORS=$loadgen_probes ACTOR_LOADGEN_CONCURRENCY=$loadgen_concurrency \
	ACTOR_LOADGEN_BATCH_SIZE=$loadgen_batch_size ACTOR_NAMESPACE=$namespace ACTOR_CELL_NAME=$cell \
	ACTOR_LOADGEN_BATCH_SETTLE_SECONDS=$loadgen_batch_settle_seconds \
	ACTOR_LOADGEN_OPERATION_RATE=$loadgen_operation_rate \
	ACTOR_LOADGEN_MAX_IDEMPOTENT_RETRIES=$loadgen_max_idempotent_retries \
	ACTOR_LOADGEN_RETRY_BASE_DELAY_SECONDS=$loadgen_retry_base_delay_seconds \
	ACTOR_LOADGEN_API_MODE=$loadgen_api_mode \
	KUBECONFIG=${KUBECONFIG:-} bash "$fleet_dir/loadgen/run.sh"
}

wait_job_started() {
	local name=$1 deadline=$((SECONDS + 600))
	while ((SECONDS < deadline)); do
		state=$(python3 - "${kubeconfig_args[@]}" "$namespace" "$name" <<'PY' 2>/dev/null || true
import json,subprocess,sys
args=sys.argv[1:-2]; namespace,name=sys.argv[-2:]
def get(*parts): return json.loads(subprocess.check_output(["kubectl",*args,*parts,"-o","json"]))
job=get("-n",namespace,"get","job",name); status=job.get("status",{})
if status.get("failed") and not status.get("active"):
    print("failed")
elif status.get("succeeded"):
    print("started")
else:
    pods=get("-n",namespace,"get","pods","-l",f"job-name={name}").get("items",[])
    ready=False
    for pod in pods:
        conditions={c.get("type"):c.get("status") for c in pod.get("status",{}).get("conditions",[])}
        containers=pod.get("status",{}).get("containerStatuses",[])
        if pod.get("status",{}).get("phase")=="Running" and conditions.get("Ready")=="True" and containers and all(c.get("ready") for c in containers):
            ready=True
    print("started" if ready else "pending")
PY
		)
		[[ $state == started ]] && return 0
		[[ $state == failed ]] && return 1
		sleep 5
	done
	return 1
}

wait_job_complete() {
	local name=$1 deadline=$((SECONDS + job_timeout))
	while ((SECONDS < deadline)); do
		record_runtime_snapshot >/dev/null
		state=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get job "$name" -o json | python3 -c 'import json,sys; d=json.load(sys.stdin).get("status",{}); print("succeeded" if d.get("succeeded") else "failed" if d.get("failed") and not d.get("active") else "active")')
		[[ $state == succeeded ]] && return 0
		[[ $state == failed ]] && { echo "loadgen Job $name failed" >&2; return 1; }
		sleep 15
	done
	echo "loadgen Job $name timed out" >&2
	return 1
}

capture_loadgen_result() {
	local name=$1 expected_mode=$2 raw pod_name pod_uid deadline=$((SECONDS + 120))
	read -r pod_name pod_uid < <(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods -l "job-name=$name" -o json | python3 -c 'import json,sys; items=[x for x in json.load(sys.stdin).get("items",[]) if x.get("status",{}).get("phase")=="Succeeded" and any(c.get("name")=="loadgen" and c.get("state",{}).get("terminated",{}).get("exitCode")==0 for c in x.get("status",{}).get("containerStatuses",[]))]; assert len(items)==1; print(items[0]["metadata"]["name"],items[0]["metadata"]["uid"])')
	while ((SECONDS < deadline)); do
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get "pod/$pod_name" -o json | \
			python3 -c 'import json,sys; d=json.load(sys.stdin); expected=sys.argv[1]; statuses=d.get("status",{}).get("containerStatuses",[]); assert d["metadata"]["uid"]==expected and d.get("status",{}).get("phase")=="Succeeded" and any(c.get("name")=="loadgen" and c.get("state",{}).get("terminated",{}).get("exitCode")==0 for c in statuses)' "$pod_uid"
		raw=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" logs "pod/$pod_name" -c loadgen 2>"$temporary/loadgen-log-error" || true)
		if [[ -n $raw ]] && printf '%s' "$raw" | python3 "$loadgen_result_validator" \
			"$expected_mode" "$run_id" "$cell" "$loadgen_actors" "$loadgen_probes" \
			"$loadgen_batch_size" "$loadgen_batch_settle_seconds" "$loadgen_operation_rate" \
			"$loadgen_max_idempotent_retries" "$name" "$pod_name" "$pod_uid" \
			>>"$temporary/loadgen-results.jsonl" 2>"$temporary/loadgen-validation-error"; then
			return 0
		fi
		sleep 2
	done
	echo "loadgen Job $name completed but exact Pod $pod_name ($pod_uid) produced no valid JSON log within 120 seconds" >&2
	[[ ! -s $temporary/loadgen-log-error ]] || cat "$temporary/loadgen-log-error" >&2
	[[ ! -s $temporary/loadgen-validation-error ]] || cat "$temporary/loadgen-validation-error" >&2
	return 1
}

record_runtime_snapshot() {
	local snapshot
	snapshot=$(python3 - "${kubeconfig_args[@]}" "$namespace" "$cell" "$runtime_statefulset" "$runtime_machine_set" <<'PY'
import datetime,json,subprocess,sys,urllib.parse
args=sys.argv[1:-4]; namespace,cell,statefulset,machine_set=sys.argv[-4:]
def get(*parts):
    return json.loads(subprocess.check_output(["kubectl",*args,*parts,"-o","json"]))
def quantity(value):
    value=str(value)
    return float(value[:-1])/1000.0 if value.endswith("m") else float(value)
selector=urllib.parse.quote("cell="+cell,safe="")
metric=json.loads(subprocess.check_output(["kubectl",*args,"get","--raw","/apis/external.metrics.k8s.io/v1beta1/namespaces/{}/rivet_workerd_active_actors_total?labelSelector={}".format(namespace,selector)]))
items=metric.get("items",[])
if len(items)!=1:
    raise SystemExit("expected one Cell occupancy metric, got {}".format(items))
sts=get("-n",namespace,"get","statefulset",statefulset)
machine=get("get","machineset",machine_set)
print(json.dumps({
 "capturedAt":datetime.datetime.utcnow().replace(microsecond=0).isoformat()+"Z",
 "stage":None,
 "activeActors":quantity(items[0]["value"]),
 "runtimeStatefulSet":{"specReplicas":sts.get("spec",{}).get("replicas"),"readyReplicas":sts.get("status",{}).get("readyReplicas",0)},
 "runtimeMachineSet":{"specReplicas":machine.get("spec",{}).get("replicas"),"readyReplicas":machine.get("status",{}).get("readyReplicas",0),"availableReplicas":machine.get("status",{}).get("availableReplicas",0)},
},sort_keys=True,separators=(",",":")))
PY
	)
	snapshot=$(printf '%s' "$snapshot" | python3 -c 'import json,sys; d=json.load(sys.stdin); d["stage"]=sys.argv[1]; print(json.dumps(d,sort_keys=True,separators=(",",":")))' "$stage")
	printf '%s\n' "$snapshot" >>"$temporary/runtime-timeline.jsonl"
	printf '%s\n' "$snapshot"
}

wait_runtime_baseline() {
	local deadline=$((SECONDS + runtime_baseline_timeout)) snapshot
	while ((SECONDS < deadline)); do
		snapshot=$(record_runtime_snapshot)
		if printf '%s' "$snapshot" | python3 -c 'import json,sys; d=json.load(sys.stdin); expected=int(sys.argv[1]); s=d["runtimeStatefulSet"]; m=d["runtimeMachineSet"]; raise SystemExit(0 if d["activeActors"]==0 and s["specReplicas"]==s["readyReplicas"]==expected and m["specReplicas"]==m["readyReplicas"]==m["availableReplicas"]==expected else 1)' "$runtime_baseline_replicas"; then
			return 0
		fi
		sleep 15
	done
	echo "public Object occupancy/runtime did not return to the isolated baseline" >&2
	return 1
}

stage=wait-runtime-baseline-before-seed
wait_runtime_baseline
# Recovery from an earlier, unrelated compute qualification is not part of
# this storage receipt. Start the isolation timeline only after the exact
# authoritative production HPA floor has converged and before the first public Object exists.
: >"$temporary/runtime-timeline.jsonl"
stage=seed-actors
start_loadgen populate seed
seed_job=$(job_name populate seed)
wait_job_started "$seed_job"
wait_job_complete "$seed_job"
capture_loadgen_result "$seed_job" populate
stage=wait-runtime-baseline-after-seed
wait_runtime_baseline

stage=scale-up
start_argo_recovery_guard up 900
set_profile up
wait_cell_desired 12
restore_profile
up_operation=$(find_operation 9 12)
wait_operation "$up_operation"
wait_topology 12 "$expanded_nodes"

stage=probe-expanded
start_loadgen probe expanded
expanded_probe=$(job_name probe expanded)
wait_job_complete "$expanded_probe"
capture_loadgen_result "$expanded_probe" probe
stage=wait-runtime-baseline-after-expanded-probe
wait_runtime_baseline

stage=scale-down
start_argo_recovery_guard down 5100
set_profile down
wait_cell_desired 9 4500
restore_profile
down_operation=$(find_operation 12 9)
wait_operation "$down_operation"
wait_topology 9 "$baseline_nodes"

stage=verify-quarantine
deadline=$((SECONDS + 900))
while ((SECONDS < deadline)); do
	record_runtime_snapshot >/dev/null
	if python3 - "${kubeconfig_args[@]}" "$namespace" "$down_operation" <<'PY'
import datetime,json,subprocess,sys
args=sys.argv[1:-2]; namespace,operation=sys.argv[-2:]
items=json.loads(subprocess.check_output(["kubectl",*args,"-n",namespace,"get","fdbvolumeretirements","-o","json"]))["items"]
items=[x for x in items if x.get("spec",{}).get("scaleOperationRef",{}).get("name")==operation]
assert len(items)==3
for item in items:
    spec=item.get("spec",{}); status=item.get("status",{})
    assert spec.get("quarantineSeconds")==2592000 and spec.get("gcMode")=="ObserveOnly"
    assert status.get("phase")=="Quarantined" and status.get("cloudState")=="Unattached"
    # The TAT builder still ships Python 3.6.  datetime.fromisoformat was
    # introduced in 3.7, while controller timestamps are RFC3339 UTC.
    released=datetime.datetime.strptime(status["releasedAt"], "%Y-%m-%dT%H:%M:%SZ")
    eligible=datetime.datetime.strptime(status["eligibleAt"], "%Y-%m-%dT%H:%M:%SZ")
    assert int((eligible-released).total_seconds())==2592000
PY
	then break; fi
	sleep 15
done
((SECONDS < deadline)) || { echo "retired CBS volumes did not enter 30-day quarantine" >&2; exit 1; }

stage=probe-contracted
start_loadgen probe contracted
contracted_probe=$(job_name probe contracted)
wait_job_complete "$contracted_probe"
capture_loadgen_result "$contracted_probe" probe
stage=wait-runtime-baseline-after-contracted-probe
wait_runtime_baseline

stage=cleanup-actors
start_loadgen cleanup final
cleanup_job=$(job_name cleanup final)
wait_job_complete "$cleanup_job"
capture_loadgen_result "$cleanup_job" cleanup
stage=wait-runtime-baseline-after-cleanup
wait_runtime_baseline

stage=restore-production-profile
restore_profile
deadline=$((SECONDS + 600))
while ((SECONDS < deadline)); do
	record_runtime_snapshot >/dev/null
	mode=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get rivetcell "$cell" -o jsonpath='{.status.foundationDBAutoscaling.mode}')
	desired=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get rivetcell "$cell" -o jsonpath='{.status.foundationDBAutoscaling.desiredProcessCount}')
	[[ $mode == "$baseline_mode" && $desired == 9 ]] && break
	sleep 10
done
[[ $mode == "$baseline_mode" && $desired == 9 ]]

stage=complete
verdict=passed
