#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
kubeconfig_args=()
if [[ -n ${KUBECONFIG:-} ]]; then
	kubeconfig_args=(--kubeconfig "$KUBECONFIG")
fi
namespace=${ACTOR_NAMESPACE:-actor-fdb-cell-system}
: "${ACTOR_CELL_NAME:?ACTOR_CELL_NAME must name the exact Cell}"
cell=$ACTOR_CELL_NAME
mode=${ACTOR_LOADGEN_MODE:-populate}
run_id=${ACTOR_LOADGEN_RUN_ID:?ACTOR_LOADGEN_RUN_ID is required and must be reused for resume/cleanup}
job_suffix=${ACTOR_LOADGEN_JOB_SUFFIX:-}
image=${ACTOR_LOADGEN_IMAGE:?ACTOR_LOADGEN_IMAGE must be pinned by registry digest}
target=${ACTOR_LOADGEN_TARGET_ACTORS:-1000000}
probes=${ACTOR_LOADGEN_PROBE_ACTORS:-10000}
concurrency=${ACTOR_LOADGEN_CONCURRENCY:-64}
batch_size=${ACTOR_LOADGEN_BATCH_SIZE:-512}
batch_settle_seconds=${ACTOR_LOADGEN_BATCH_SETTLE_SECONDS:-0}
operation_rate=${ACTOR_LOADGEN_OPERATION_RATE:-0}
max_idempotent_retries=${ACTOR_LOADGEN_MAX_IDEMPOTENT_RETRIES:-3}
retry_base_delay_seconds=${ACTOR_LOADGEN_RETRY_BASE_DELAY_SECONDS:-0.1}
runner_names=${ACTOR_LOADGEN_RUNNER_NAMES:-workerd}
api_mode=${ACTOR_LOADGEN_API_MODE:-actor}
engine_url=${ACTOR_LOADGEN_ENGINE_URL:-http://${cell}-engine:6420}
workers_url=${ACTOR_LOADGEN_WORKERS_URL:-http://${cell}-workers-api:8080}
worker_name=${ACTOR_LOADGEN_WORKER_NAME:-q01-fdb-autoscale-gate}
class_name=${ACTOR_LOADGEN_CLASS_NAME:-Agent}
pvc_name=${ACTOR_LOADGEN_PVC_NAME:-${cell}-fdb-autoscale-loadgen}
pvc_size=${ACTOR_LOADGEN_PVC_SIZE:-20Gi}
image_pull_secret=${ACTOR_LOADGEN_IMAGE_PULL_SECRET:-actor-fleet-tcr}
image_pull_timeout=${ACTOR_LOADGEN_IMAGE_PULL_TIMEOUT_SECONDS:-180}
preflight_only=${ACTOR_LOADGEN_PREFLIGHT_ONLY:-0}

[[ $image =~ @sha256:[0-9a-f]{64}$ ]] || {
	echo "ACTOR_LOADGEN_IMAGE must be immutable" >&2
	exit 2
}
[[ $cell =~ ^actor-[a-z0-9-]+$ && $run_id =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#run_id} -le 24 ]] || {
	echo "invalid Cell or run ID" >&2
	exit 2
}
[[ $image_pull_secret =~ ^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$ ]] || { echo "invalid image pull Secret name" >&2; exit 2; }
[[ $preflight_only == 0 || $preflight_only == 1 ]] || { echo "ACTOR_LOADGEN_PREFLIGHT_ONLY must be 0 or 1" >&2; exit 2; }
[[ -z $job_suffix || ($job_suffix =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#job_suffix} -le 12) ]] || {
	echo "invalid loadgen Job suffix" >&2
	exit 2
}
case "$mode" in populate | probe | cleanup | summary) ;; *) echo "invalid ACTOR_LOADGEN_MODE" >&2; exit 2 ;; esac
case "$api_mode" in actor | workers-v1) ;; *) echo "invalid ACTOR_LOADGEN_API_MODE" >&2; exit 2 ;; esac
for value in "$target" "$probes" "$concurrency" "$batch_size" "$image_pull_timeout"; do
	[[ $value =~ ^[1-9][0-9]*$ ]] || { echo "load parameters must be positive integers" >&2; exit 2; }
done
[[ $max_idempotent_retries =~ ^([0-9]|10)$ ]] || { echo "max idempotent retries must be between 0 and 10" >&2; exit 2; }
for value in "$batch_settle_seconds" "$operation_rate" "$retry_base_delay_seconds"; do
	[[ $value =~ ^([0-9]+)(\.[0-9]+)?$ ]] || { echo "load timing parameters must be non-negative numbers" >&2; exit 2; }
done
python3 - "$batch_settle_seconds" "$operation_rate" "$retry_base_delay_seconds" <<'PY'
import sys
settle, rate, retry = map(float, sys.argv[1:])
if settle > 300 or rate > 1000 or retry <= 0 or retry > 5:
    raise SystemExit("load timing parameters exceed harness safety bounds")
PY
((probes <= target && concurrency <= 256 && batch_size <= 4096)) || {
	echo "load parameters exceed harness safety bounds" >&2
	exit 2
}
job_name="${cell}-fdb-load-${mode}-${run_id}"
[[ -n $job_suffix ]] && job_name="${job_name}-${job_suffix}"
job_name=${job_name:0:57}

# This is an autonomous Job, but starting it is fail-closed on the same live
# durability gates used by a production FDB scale operation.
backup_url=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get foundationdbbackup "${cell}-continuous" \
	-o jsonpath='{.status.backupDetails.url}')
backup_pod=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
	-l "foundationdb.org/deployment-name=${cell}-continuous-backup-agents" \
	-o jsonpath='{.items[0].metadata.name}')
[[ $backup_url == blobstore://* && -n $backup_pod ]] || {
	echo "continuous backup exact identity is unavailable" >&2
	exit 1
}
backup_description=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" exec "$backup_pod" \
	-c foundationdb -- timeout 45 fdbbackup describe -d "$backup_url")
grep -q '^Restorable: true$' <<<"$backup_description" || {
	echo "continuous backup exact container is not restorable" >&2
	exit 1
}
python3 - "${kubeconfig_args[@]}" "$namespace" "$cell" <<'PY'
import json, subprocess, sys
args=sys.argv[1:-2]
namespace,cell=sys.argv[-2:]
def get(*parts):
    return json.loads(subprocess.check_output(["kubectl", *args, *parts, "-o", "json"]))
fdb=get("-n",namespace,"get","foundationdbcluster",cell)
h=fdb.get("status",{}).get("health",{})
if not (h.get("available") and h.get("healthy") and h.get("fullReplication") and fdb.get("status",{}).get("generations",{}).get("reconciled") == fdb["metadata"]["generation"]):
    raise SystemExit("FDB is not fully healthy and reconciled")
backup=get("-n",namespace,"get","foundationdbbackup",cell+"-continuous").get("status",{}).get("backupDetails",{})
if not backup.get("running"):
    raise SystemExit("continuous backup agents are not Running")
PY
runtime_floor_args=(--cell "$cell" --namespace "$namespace")
[[ -n ${KUBECONFIG:-} ]] && runtime_floor_args+=(--kubeconfig "$KUBECONFIG")
python3 "$script_dir/verify_runtime_floor.py" "${runtime_floor_args[@]}"
kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret "$image_pull_secret" >/dev/null

# Force the exact registry digest through every control node before the
# long-lived Job exists. This catches missing manifests, stale credentials,
# node DNS/egress failures and architecture mismatches without a BackOff loop.
pull_probe="${cell}-pull-${mode}-${run_id}"
[[ -n $job_suffix ]] && pull_probe="${pull_probe}-${job_suffix}"
pull_probe=${pull_probe:0:63}
pull_probe=${pull_probe%-}
kubectl "${kubeconfig_args[@]}" -n "$namespace" delete daemonset "$pull_probe" \
	--ignore-not-found --wait=true >/dev/null
pull_probe_cleanup() {
	kubectl "${kubeconfig_args[@]}" -n "$namespace" delete daemonset "$pull_probe" \
		--ignore-not-found --wait=false >/dev/null 2>&1 || true
}
pull_probe_cleanup_wait() {
	kubectl "${kubeconfig_args[@]}" -n "$namespace" delete daemonset "$pull_probe" \
		--ignore-not-found --wait=true >/dev/null
	kubectl "${kubeconfig_args[@]}" -n "$namespace" wait --for=delete pod \
		-l "fleet.actor.dev/preflight-name=$pull_probe" --timeout=60s >/dev/null 2>&1 || {
		echo "image preflight Pods did not disappear after successful probe" >&2
		return 1
	}
}
trap pull_probe_cleanup EXIT INT TERM
python3 - "$namespace" "$cell" "$pull_probe" "$image" "$image_pull_secret" <<'PY' \
	| kubectl "${kubeconfig_args[@]}" apply -f - >/dev/null
import json,sys
namespace,cell,name,image,pull_secret=sys.argv[1:]
print(json.dumps({
 "apiVersion":"apps/v1","kind":"DaemonSet",
 "metadata":{"name":name,"namespace":namespace,"labels":{"app.kubernetes.io/name":"actor-loadgen-image-preflight","fleet.actor.dev/cell-name":cell}},
 "spec":{"selector":{"matchLabels":{"app.kubernetes.io/name":"actor-loadgen-image-preflight","fleet.actor.dev/preflight-name":name}},
  "template":{"metadata":{"labels":{"app.kubernetes.io/name":"actor-loadgen-image-preflight","fleet.actor.dev/preflight-name":name,"fleet.actor.dev/cell-name":cell}},
   "spec":{"automountServiceAccountToken":False,"imagePullSecrets":[{"name":pull_secret}],
    "nodeSelector":{"fleet.actor.dev/control-pool":"true"},"terminationGracePeriodSeconds":1,
    "securityContext":{"runAsNonRoot":True,"runAsUser":65532,"runAsGroup":65532,"seccompProfile":{"type":"RuntimeDefault"}},
    "containers":[{"name":"pull","image":image,"imagePullPolicy":"Always","command":["python3","-c","import time; time.sleep(300)"],
      "resources":{"requests":{"cpu":"25m","memory":"64Mi"},"limits":{"cpu":"100m","memory":"128Mi"}},
      "securityContext":{"allowPrivilegeEscalation":False,"readOnlyRootFilesystem":True,"capabilities":{"drop":["ALL"]}}}]}}}}))
PY
expected_pull_nodes=$(kubectl "${kubeconfig_args[@]}" get nodes \
	-l fleet.actor.dev/control-pool=true --no-headers | wc -l | tr -d ' ')
((expected_pull_nodes > 0)) || { echo "no control nodes exist for image preflight" >&2; exit 1; }
pull_deadline=$((SECONDS + image_pull_timeout))
pull_ready=false
while ((SECONDS < pull_deadline)); do
	read -r desired ready unavailable < <(kubectl "${kubeconfig_args[@]}" -n "$namespace" get daemonset "$pull_probe" \
		-o jsonpath='{.status.desiredNumberScheduled}{" "}{.status.numberReady}{" "}{.status.numberUnavailable}{"\n"}')
	desired=${desired:-0}; ready=${ready:-0}; unavailable=${unavailable:-0}
	if [[ $desired == "$expected_pull_nodes" && $ready == "$expected_pull_nodes" && $unavailable == 0 ]]; then
		pull_ready=true
		break
	fi
	sleep 3
done
if [[ $pull_ready != true ]]; then
	echo "immutable loadgen image did not pull on every control node" >&2
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
		-l "fleet.actor.dev/preflight-name=$pull_probe" -o wide >&2 || true
	kubectl "${kubeconfig_args[@]}" -n "$namespace" describe pods \
		-l "fleet.actor.dev/preflight-name=$pull_probe" >&2 || true
	exit 1
fi
pull_probe_cleanup_wait
trap - EXIT INT TERM
if [[ $preflight_only == 1 ]]; then
	printf 'loadgen_image_preflight=passed image=%s nodes=%s\n' "$image" "$expected_pull_nodes"
	exit 0
fi

kubectl "${kubeconfig_args[@]}" apply -f "$script_dir/storage.yaml" >/dev/null
python3 - "$namespace" "$cell" "$pvc_name" "$pvc_size" <<'PY' | kubectl "${kubeconfig_args[@]}" apply -f - >/dev/null
import json,sys
namespace,cell,name,size=sys.argv[1:]
print(json.dumps({"apiVersion":"v1","kind":"PersistentVolumeClaim","metadata":{"name":name,"namespace":namespace,
 "labels":{"app.kubernetes.io/name":"actor-fdb-autoscale-loadgen","fleet.actor.dev/cell-name":cell}},
 "spec":{"accessModes":["ReadWriteOnce"],"storageClassName":"actor-loadgen-cbs-wffc-retain","resources":{"requests":{"storage":size}}}}))
PY
existing=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get job "$job_name" -o json 2>/dev/null || true)
if [[ -n $existing ]]; then
	phase=$(printf '%s' "$existing" | python3 -c 'import json,sys;o=json.load(sys.stdin);s=o.get("status",{});print("succeeded" if s.get("succeeded") else "failed" if s.get("failed") and not s.get("active") else "active")')
	printf 'loadgen_job=%s phase=%s existing=true\n' "$job_name" "$phase"
	[[ $phase != failed ]]
	exit
fi

temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
python3 - "$temporary/job.json" "$namespace" "$cell" "$job_name" "$image" "$mode" "$run_id" "$job_suffix" "$target" "$probes" "$concurrency" "$batch_size" "$batch_settle_seconds" "$operation_rate" "$max_idempotent_retries" "$retry_base_delay_seconds" "$runner_names" "$api_mode" "$engine_url" "$workers_url" "$worker_name" "$class_name" "$pvc_name" "$image_pull_secret" <<'PY'
import json,sys
(path,namespace,cell,name,image,mode,run_id,job_suffix,target,probes,concurrency,batch_size,batch_settle_seconds,operation_rate,max_idempotent_retries,retry_base_delay_seconds,runners,api_mode,engine_url,workers_url,worker_name,class_name,pvc,image_pull_secret)=sys.argv[1:]
output_suffix=("-"+job_suffix) if job_suffix else ""
args=[mode,"--api-mode",api_mode,"--cell-id",cell,"--target-actors",target,"--probe-actors",probes,
      "--concurrency",concurrency,"--batch-size",batch_size,"--run-id",run_id,
      "--probe-epoch",job_suffix or "default",
      "--batch-settle-seconds",batch_settle_seconds,
      "--operation-rate",operation_rate,"--max-idempotent-retries",max_idempotent_retries,
      "--retry-base-delay-seconds",retry_base_delay_seconds,
      "--manifest",f"/state/{run_id}.sqlite","--execution-site-file","/etc/actor/cell-id",
      "--output",f"/state/{run_id}-{mode}{output_suffix}.json"]
if api_mode == "workers-v1":
    args += ["--workers-url",workers_url,"--worker-name",worker_name,"--class-name",class_name]
else:
    args += ["--engine-url",engine_url]
for runner in runners.split(","):
    if not runner: raise SystemExit("empty runner name")
    args += ["--runner-name",runner]
job={
 "apiVersion":"batch/v1","kind":"Job",
 "metadata":{"name":name,"namespace":namespace,"labels":{"app.kubernetes.io/name":"actor-fdb-autoscale-loadgen","fleet.actor.dev/cell-name":cell},
             "annotations":{"fleet.actor.dev/loadgen-run-id":run_id,"fleet.actor.dev/loadgen-mode":mode,"fleet.actor.dev/loadgen-job-suffix":job_suffix,"fleet.actor.dev/target-actors":target,"fleet.actor.dev/probe-actors":probes,"fleet.actor.dev/concurrency":concurrency,"fleet.actor.dev/batch-size":batch_size,"fleet.actor.dev/batch-settle-seconds":batch_settle_seconds,"fleet.actor.dev/operation-rate":operation_rate,"fleet.actor.dev/max-idempotent-retries":max_idempotent_retries,"fleet.actor.dev/retry-base-delay-seconds":retry_base_delay_seconds,"fleet.actor.dev/public-api-only":"true" if api_mode == "workers-v1" else "false"}},
 "spec":{"backoffLimit":100,"activeDeadlineSeconds":1209600,"ttlSecondsAfterFinished":86400,"template":{"metadata":{"labels":{"app.kubernetes.io/name":"actor-fdb-autoscale-loadgen","fleet.actor.dev/cell-name":cell}},
 "spec":{"restartPolicy":"OnFailure","automountServiceAccountToken":False,"imagePullSecrets":[{"name":image_pull_secret}],"securityContext":{"runAsNonRoot":True,"runAsUser":65532,"runAsGroup":65532,"fsGroup":65532,"seccompProfile":{"type":"RuntimeDefault"}},
 "affinity":{"nodeAffinity":{"requiredDuringSchedulingIgnoredDuringExecution":{"nodeSelectorTerms":[{"matchExpressions":[{"key":"fleet.actor.dev/control-pool","operator":"In","values":["true"]}]}]}}},
 "containers":[{"name":"loadgen","image":image,"imagePullPolicy":"IfNotPresent","args":args,
   "resources":{"requests":{"cpu":"200m","memory":"512Mi"},"limits":{"cpu":"4","memory":"4Gi"}},
   "securityContext":{"allowPrivilegeEscalation":False,"capabilities":{"drop":["ALL"]}},
   "volumeMounts":[{"name":"state","mountPath":"/state"},{"name":"execution-site","mountPath":"/etc/actor","readOnly":True}]}],
 "volumes":[{"name":"state","persistentVolumeClaim":{"claimName":pvc}},
            {"name":"execution-site","configMap":{"name":name+"-site"}}]}}}}
site={"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":name+"-site","namespace":namespace},"data":{"cell-id":cell+"\n"}}
with open(path,"w") as out: json.dump({"apiVersion":"v1","kind":"List","items":[site,job]},out,separators=(",",":"))
PY
kubectl "${kubeconfig_args[@]}" apply --dry-run=server -f "$temporary/job.json" >/dev/null
kubectl "${kubeconfig_args[@]}" apply -f "$temporary/job.json" >/dev/null
printf 'loadgen_job=%s mode=%s target=%s manifest_pvc=%s autonomous=true\n' "$job_name" "$mode" "$target" "$pvc_name"
