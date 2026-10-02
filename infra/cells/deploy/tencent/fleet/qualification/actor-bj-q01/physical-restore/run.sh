#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_root=$(CDPATH= cd -- "$script_dir/../../.." && pwd)
operations_dir=$fleet_root/operations
runtime_dir=$fleet_root/runtime
cell=${RIVET_CELL_NAME:-actor-bj-q01}
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
kubeconfig=${KUBECONFIG:-/var/lib/actor-build/credentials/${cell}.kubeconfig}
qualification_worker=${DR_WORKER:-${cell##*-}-dr-physical-restore}
receipt_dir=${QUALIFICATION_RECEIPT_DIR:-/data/actor-qualification/receipts}
run_id=${DR_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(tr -d - </proc/sys/kernel/random/uuid | cut -c1-8)}
target=${DR_TARGET_CLUSTER:-${cell}-dr-${run_id,,}}
receipt=${DR_RECEIPT:-$receipt_dir/${cell}-dr-physical-restore-${run_id}.json}
execute=${DR_EXECUTE:-false}
backup_wait_seconds=${DR_BACKUP_WAIT_SECONDS:-1800}
restore_timeout_seconds=${DR_RESTORE_TIMEOUT_SECONDS:-10800}
resume_failure_receipt=${DR_RESUME_FAILURE_RECEIPT:-}
resume_failure_stage=

[[ $execute == true ]] || {
	echo "refusing physical restore: set DR_EXECUTE=true" >&2
	exit 2
}
[[ $cell =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#cell} -le 63 \
	&& $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
	&& $qualification_worker =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
	&& ${#qualification_worker} -le 63 ]] || {
	echo "physical restore Cell, namespace, or Worker identity is invalid" >&2
	exit 2
}
[[ -f $kubeconfig && $receipt == /* ]] || {
	echo "Cell kubeconfig must exist and DR_RECEIPT must be absolute" >&2
	exit 2
}
[[ -z $resume_failure_receipt || ($resume_failure_receipt == /* && -f $resume_failure_receipt) ]] || {
	echo "DR_RESUME_FAILURE_RECEIPT must be an existing absolute receipt" >&2
	exit 2
}
if [[ -n $resume_failure_receipt ]]; then
	resume_failure_stage=$(python3 - "$resume_failure_receipt" "$cell" "$namespace" <<'PY'
import json, sys
failure = json.load(open(sys.argv[1]))
if (
    failure.get("schema") != "actor-fdb-physical-restore-v1"
    or failure.get("verdict") != "failed"
    or failure.get("cell") != sys.argv[2]
    or failure.get("namespace") != sys.argv[3]
    or failure.get("failed_stage") not in ("render", "restore")
):
    raise SystemExit("only an exact Cell-scoped render/restore-stage failure can resume")
print(failure["failed_stage"])
PY
	)
fi
[[ $target =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#target} -le 63 ]] || {
	echo "DR target name is not DNS-safe: $target" >&2
	exit 2
}
for command in kubectl python3 curl timeout; do
	command -v "$command" >/dev/null || {
		echo "required command missing: $command" >&2
		exit 2
	}
done

if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
fi
AUTONOMY_WORKFLOW=dr.physical-restore \
AUTONOMY_CONTROL_CELL=$cell \
AUTONOMY_CONTROL_NAMESPACE=$namespace \
AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=${AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY:-1} \
AUTONOMY_CONTROL_DECISIONS_DIR=${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions} \
	"$operations_dir/assert-autonomy-control.sh"

mkdir -p /data/tmp "$receipt_dir"
workdir=$(mktemp -d "/data/tmp/${target}.XXXXXX")
stage=preflight
seed=$workdir/seed.json
cleanup_result=$workdir/source-cleanup.json
render_dir=$workdir/rendered
forward_pid=
workers_forward_pid=
resume_forward_pid=

write_failure_receipt() {
	local status=$1
	[[ $status -ne 0 ]] || return 0
	RECEIPT=$receipt STAGE=$stage TARGET=$target RUN_ID=$run_id WORKDIR=$workdir \
	CELL=$cell NAMESPACE=$namespace \
	RESUME_FAILURE=$resume_failure_receipt python3 - <<'PY'
import json
import os
from datetime import datetime, timezone

path = os.environ["RECEIPT"]
if os.path.exists(path):
    raise SystemExit(0)
payload = {
    "schema": "actor-fdb-physical-restore-v1",
    "verdict": "failed",
    "cell": os.environ["CELL"],
    "namespace": os.environ["NAMESPACE"],
    "run_id": os.environ["RUN_ID"],
    "target_cluster": os.environ["TARGET"],
    "failed_stage": os.environ["STAGE"],
    "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "evidence_directory": os.environ["WORKDIR"],
    "resources_retained_for_diagnosis": True,
    "resumed_from_failure_receipt": os.environ.get("RESUME_FAILURE") or None,
}
temporary = path + ".tmp"
with open(temporary, "w") as output:
    json.dump(payload, output, indent=2, sort_keys=True)
    output.write("\n")
os.replace(temporary, path)
PY
}
on_exit() {
	local status=$?
	if [[ -n ${forward_pid:-} ]]; then
		kill "$forward_pid" 2>/dev/null || true
		wait "$forward_pid" 2>/dev/null || true
	fi
	if [[ -n ${workers_forward_pid:-} ]]; then
		kill "$workers_forward_pid" 2>/dev/null || true
		wait "$workers_forward_pid" 2>/dev/null || true
	fi
	if [[ -n ${resume_forward_pid:-} ]]; then
		kill "$resume_forward_pid" 2>/dev/null || true
		wait "$resume_forward_pid" 2>/dev/null || true
	fi
	write_failure_receipt "$status"
	exit "$status"
}
trap on_exit EXIT
# A signal trap inherits the interrupted command's status, which can be zero.
# Turn interruption into an explicit failure so EXIT writes a retained receipt.
trap 'exit 130' INT
trap 'exit 143' TERM

kube=(kubectl --kubeconfig "$kubeconfig")
capture_release() {
	local output=$1 prefix=$2
	"${kube[@]}" -n "$namespace" get deployment "${cell}-engine" -o json >"$workdir/${prefix}-engine.json"
	"${kube[@]}" -n "$namespace" get statefulset "${cell}-runtime-hosts" -o json >"$workdir/${prefix}-runtime.json"
	"${kube[@]}" -n "$namespace" get pods -l "fleet.actor.dev/cell-name=$cell" -o json >"$workdir/${prefix}-pods.json"
	python3 "$runtime_dir/capture_release_binding.py" \
		--deployment "$workdir/${prefix}-engine.json" \
		--statefulset "$workdir/${prefix}-runtime.json" \
		--pods "$workdir/${prefix}-pods.json" >"$output"
}
source_json=$workdir/source-cluster.json
backup_json=$workdir/source-backup.json
"${kube[@]}" -n "$namespace" get foundationdbcluster "$cell" -o json >"$source_json"
"${kube[@]}" -n "$namespace" get foundationdbbackup "${cell}-continuous" -o json >"$backup_json"
python3 - "$source_json" "$backup_json" <<'PY'
import json
import sys

cluster = json.load(open(sys.argv[1]))
backup = json.load(open(sys.argv[2]))
health = cluster.get("status", {}).get("health", {})
if cluster.get("spec", {}).get("processCounts", {}).get("storage") != 9:
    raise SystemExit("source FDB does not have nine storage processes")
if not all(health.get(key) is True for key in ("available", "healthy", "fullReplication")):
    raise SystemExit("source FDB is not fully healthy")
if cluster.get("metadata", {}).get("generation") != cluster.get("status", {}).get("generations", {}).get("reconciled"):
    raise SystemExit("source FDB generation is not reconciled")
details = backup.get("status", {}).get("backupDetails", {})
if details.get("running") is not True or not str(details.get("url", "")).startswith("blobstore://"):
    raise SystemExit("continuous backup is not running with an exact blob URL")
PY

if "${kube[@]}" -n "$namespace" get foundationdbcluster "$target" >/dev/null 2>&1 \
	&& [[ $resume_failure_stage != restore ]]; then
	echo "DR target already exists; refusing ambiguous reuse: $target" >&2
	exit 2
fi
if [[ $resume_failure_stage == restore ]] \
	&& ! "${kube[@]}" -n "$namespace" get foundationdbcluster "$target" >/dev/null 2>&1; then
	echo "restore-stage resume target is absent: $target" >&2
	exit 2
fi

current_release=$workdir/release-current.json
capture_release "$current_release" release-current
runtime_image=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["runtime_image"])' "$current_release")
engine_manifest=$("${kube[@]}" -n "$namespace" get deployment "${cell}-engine" -o jsonpath='{.spec.template.metadata.annotations.fleet\.actor\.dev/manifest-sha256}')
runtime_manifest=$("${kube[@]}" -n "$namespace" get statefulset "${cell}-runtime-hosts" -o jsonpath='{.spec.template.metadata.annotations.fleet\.actor\.dev/manifest-sha256}')
[[ $runtime_image =~ @sha256:[0-9a-f]{64}$ ]] || {
	echo "live runtime image is not digest pinned" >&2
	exit 1
}
[[ $engine_manifest =~ ^[0-9a-f]{64}$ && $runtime_manifest == "$engine_manifest" ]] || {
	echo "live Engine/runtime release manifest identity is inconsistent" >&2
	exit 1
}
resume_failure_sha=
resume_failure_run_id=
resume_restore=false
if [[ -n $resume_failure_receipt ]]; then
	if [[ $resume_failure_stage == restore ]]; then
		stage=resume-restore
		"${kube[@]}" -n "$namespace" get foundationdbcluster "$target" -o json >"$workdir/target-live.json"
		resume_evidence=$(python3 - "$resume_failure_receipt" "$source_json" "$current_release" \
			"$cell" "$namespace" "$qualification_worker" "$target" "$workdir/target-live.json" <<'PY'
import json, os, re, sys
failure=json.load(open(sys.argv[1])); evidence=os.path.realpath(failure.get("evidence_directory", ""))
if failure.get("failed_stage") != "restore" or failure.get("target_cluster") != sys.argv[7] or not re.fullmatch(r"/data/tmp/"+re.escape(sys.argv[4])+r"-dr-[a-z0-9-]+\.[A-Za-z0-9]+", evidence): raise SystemExit("restore-stage resume identity is invalid")
for name in ("seed.json","source-cluster.json","source-backup.json","backup-description.txt","target-cluster.json","restore-agent-placement.json","release-current.json"):
    if not os.path.isfile(os.path.join(evidence,name)): raise SystemExit("restore-stage resume evidence is incomplete")
if not os.path.isdir(os.path.join(evidence,"rendered")): raise SystemExit("restore-stage resume rendered evidence is incomplete")
source=json.load(open(sys.argv[2])); prior_source=json.load(open(os.path.join(evidence,"source-cluster.json")))
live=json.load(open(sys.argv[8])); prior=json.load(open(os.path.join(evidence,"target-cluster.json")))
seed=json.load(open(os.path.join(evidence,"seed.json"))); release=json.load(open(sys.argv[3])); app=seed.get("application_api",{})
def immutable_release(value):
    return {key: item for key, item in value.items() if key not in ("engine_pod_uids", "runtime_host_pod_uids")}
if source.get("metadata",{}).get("uid") != prior_source.get("metadata",{}).get("uid"): raise SystemExit("source FDB UID changed after the failed restore")
if live.get("metadata",{}).get("uid") != prior.get("metadata",{}).get("uid") or live.get("metadata",{}).get("name") != sys.argv[7]: raise SystemExit("restore target UID changed after the failed restore")
if seed.get("verdict") != "passed" or len(seed.get("actor_records",[])) != 12 or seed.get("dr_seed",{}).get("actors_retained_asleep") is not True or seed.get("dr_seed",{}).get("temporary_shard_cache_policy") != {"retention_ms":1,"cleared":True} or app.get("worker") != sys.argv[6] or app.get("class_name") != "Agent" or immutable_release(seed.get("release_binding",{})) != immutable_release(release): raise SystemExit("restore-stage resume seed/release binding is invalid")
print(evidence)
PY
		)
		install -m 0600 "$resume_evidence/seed.json" "$seed"
		install -m 0600 "$resume_evidence/source-backup.json" "$backup_json"
		install -m 0600 "$resume_evidence/backup-description.txt" "$workdir/backup-description.txt"
		install -m 0600 "$resume_evidence/target-cluster.json" "$workdir/target-cluster.json"
		install -m 0600 "$resume_evidence/restore-agent-placement.json" "$workdir/restore-agent-placement.json"
		cp -a -- "$resume_evidence/rendered" "$render_dir"
		resume_restore=true
		resume_failure_sha=$(sha256sum "$resume_failure_receipt" | cut -d' ' -f1)
		resume_failure_run_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$resume_failure_receipt")
	else
	stage=resume-seed
	resume_seed_source=$(python3 - "$resume_failure_receipt" "$source_json" "$current_release" \
		"$cell" "$namespace" "$qualification_worker" <<'PY'
import json
import os
import re
import sys

failure_path, current_source_path, current_release_path, expected_cell, expected_namespace, expected_worker = sys.argv[1:]
failure_path = os.path.realpath(failure_path)
failure = json.load(open(failure_path))
if (
    failure.get("schema") != "actor-fdb-physical-restore-v1"
    or failure.get("verdict") != "failed"
    or failure.get("cell") != expected_cell
    or failure.get("namespace") != expected_namespace
    or failure.get("failed_stage") != "render"
):
    raise SystemExit("only an exact Cell-scoped render-stage failure can resume its frozen seed")
evidence = os.path.realpath(failure.get("evidence_directory", ""))
if not re.fullmatch(r"/data/tmp/" + re.escape(expected_cell) + r"-dr-[a-z0-9-]+\.[A-Za-z0-9]+", evidence):
    raise SystemExit("failed receipt has an unsafe evidence directory")
seed_path = os.path.realpath(os.path.join(evidence, "seed.json"))
prior_source_path = os.path.realpath(os.path.join(evidence, "source-cluster.json"))
if os.path.dirname(seed_path) != evidence or not os.path.isfile(seed_path) or not os.path.isfile(prior_source_path):
    raise SystemExit("failed render evidence has no exact seed/source pair")
current_source = json.load(open(current_source_path))
prior_source = json.load(open(prior_source_path))
current_release = json.load(open(current_release_path))
if current_source.get("metadata", {}).get("uid") != prior_source.get("metadata", {}).get("uid"):
    raise SystemExit("source FDB UID changed after the failed render")
seed = json.load(open(seed_path))
application = seed.get("application_api", {})
policy = seed.get("dr_seed", {}).get("temporary_shard_cache_policy", {})
if (
    seed.get("verdict") != "passed"
    or seed.get("public_api_only") is not True
    or len(seed.get("actor_records", [])) != 12
    or seed.get("actors_retained") is not True
    or seed.get("dr_seed", {}).get("actors_retained_asleep") is not True
    or policy != {"retention_ms": 1, "cleared": True}
    or application.get("path_prefix") != "/v1"
    or application.get("worker") != expected_worker
    or application.get("class_name") != "Agent"
    or seed.get("release_binding") != current_release
):
    raise SystemExit("failed render seed no longer satisfies the public frozen-seed contract")
version = seed.get("dr_seed", {}).get("source_fdb_read_version_after_freeze")
if not isinstance(version, int) or version <= 0:
    raise SystemExit("failed render seed has no frozen FDB read version")
print(seed_path)
PY
	)
	previous_target=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["target_cluster"])' "$resume_failure_receipt")
	[[ $previous_target =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#previous_target} -le 63 ]]
	if "${kube[@]}" -n "$namespace" get foundationdbcluster "$previous_target" >/dev/null 2>&1; then
		echo "failed render unexpectedly created its old target: $previous_target" >&2
		exit 1
	fi
	install -m 0600 "$resume_seed_source" "$seed"
	"${kube[@]}" -n "$namespace" port-forward service/"${cell}-engine" 17421:6421 >"$workdir/resume-depot-forward.log" 2>&1 &
	resume_forward_pid=$!
	for attempt in $(seq 1 60); do
		curl -fsS http://127.0.0.1:17421/health >/dev/null 2>&1 && break
		[[ $attempt -lt 60 ]] || { echo "resume Depot port-forward did not become ready" >&2; exit 1; }
		sleep 1
	done
	python3 - "$seed" <<'PY'
import json
import sys
import urllib.parse
import urllib.request

seed = json.load(open(sys.argv[1]))
bucket = seed["bottomless"]["namespace_id"]
freeze = seed["dr_seed"]["freeze"]
for record in seed["actor_records"]:
    actor = record["actor_id"]
    frozen = freeze[actor]["bottomless_state"]
    url = "http://127.0.0.1:17421/depot/inspect/buckets/{}/databases/{}/bottomless-state".format(
        urllib.parse.quote(bucket, safe=""), urllib.parse.quote(actor, safe="")
    )
    current = json.load(urllib.request.urlopen(url, timeout=40))
    if (
        current.get("branch_id") != frozen.get("branch_id")
        or current.get("head") != frozen.get("head")
        or current.get("cold_ready") is not True
        or current.get("row_counts", {}).get("hot_shards", {}).get("count") != 0
    ):
        raise SystemExit("resumed Agent is no longer at its exact frozen cold state")
print("frozen_seed_resume_preflight=passed agents=12")
PY
	kill "$resume_forward_pid" 2>/dev/null || true
	wait "$resume_forward_pid" 2>/dev/null || true
	unset resume_forward_pid
	resume_failure_sha=$(sha256sum "$resume_failure_receipt" | cut -d' ' -f1)
	resume_failure_run_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["run_id"])' "$resume_failure_receipt")
	fi
else
	stage=seed
	TMPDIR=/data/tmp \
	KUBECONFIG=$kubeconfig \
	RIVET_CELL_NAME=$cell \
	RIVET_CELL_NAMESPACE=$namespace \
	QUALIFIER=$fleet_root/../qualify_workerd_density.py \
	DR_SEED_RECEIPT=$seed \
		"$fleet_root/dr/seed-and-freeze-actors.sh"
	after_release=$workdir/release-after-seed.json
	capture_release "$after_release" release-after-seed
	python3 - "$seed" "$current_release" "$after_release" <<'PY'
import json
import os
import sys

seed_path, before_path, after_path = sys.argv[1:]
before = json.load(open(before_path))
after = json.load(open(after_path))
if before != after:
    raise SystemExit("immutable release or Pod UID set changed while freezing the DR seed")
seed = json.load(open(seed_path))
seed["release_binding"] = before
temporary = seed_path + ".tmp"
with open(temporary, "w") as output:
    json.dump(seed, output, indent=2, sort_keys=True)
    output.write("\n")
os.replace(temporary, seed_path)
PY
fi

seed_version=$(python3 - "$seed" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["dr_seed"]["source_fdb_read_version_after_freeze"])
PY
)

if [[ $resume_restore != true ]]; then
stage=backup-catchup
backup_url=$(python3 - "$backup_json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["status"]["backupDetails"]["url"])
PY
)
backup_pod=$("${kube[@]}" -n "$namespace" get pods -l "foundationdb.org/deployment-name=${cell}-continuous-backup-agents" -o jsonpath='{.items[0].metadata.name}')
[[ -n $backup_pod ]] || {
	echo "continuous backup agent is missing" >&2
	exit 1
}
deadline=$((SECONDS + backup_wait_seconds))
restore_version=0
while ((SECONDS < deadline)); do
	"${kube[@]}" -n "$namespace" exec "$backup_pod" -c foundationdb -- \
		timeout 45 fdbbackup describe -d "$backup_url" >"$workdir/backup-description.txt"
	grep -q '^Restorable: true$' "$workdir/backup-description.txt" || {
		sleep 30
		continue
	}
	restore_version=$(sed -n 's/^MaxRestorableVersion:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$workdir/backup-description.txt" | tail -1)
	if [[ $restore_version =~ ^[0-9]+$ ]] && ((restore_version >= seed_version)); then
		break
	fi
	sleep 30
done
if ! [[ $restore_version =~ ^[0-9]+$ ]] || ((restore_version < seed_version)); then
	echo "continuous backup did not cross the frozen source version" >&2
	exit 1
fi

stage=render
python3 "$script_dir/render.py" \
	--fleet-root "$fleet_root" \
	--cell "$cell" \
	--target "$target" \
	--source-cluster "$source_json" \
	--runtime-image "$runtime_image" \
	--seed "$seed" \
	--output-dir "$render_dir"
grep -R -n 'actor-bj-k01\|actor-bj-k01-dr-20260818' "$render_dir" && {
	echo "rendered DR resources retained a k01 identity" >&2
	exit 1
}
"${kube[@]}" apply --dry-run=server -f "$render_dir/isolated-fdb-cluster.yaml" >/dev/null
"${kube[@]}" apply --dry-run=server -f "$render_dir/restore-agents.yaml" >/dev/null
"${kube[@]}" apply --dry-run=server -f "$render_dir/verify-job.json" >/dev/null

stage=create-target
"${kube[@]}" apply -f "$render_dir/isolated-fdb-cluster.yaml"
deadline=$((SECONDS + 1800))
while ((SECONDS < deadline)); do
	"${kube[@]}" -n "$namespace" get foundationdbcluster "$target" -o json >"$workdir/target-cluster.json"
	if python3 - "$workdir/target-cluster.json" <<'PY'
import json, sys
cluster = json.load(open(sys.argv[1]))
health = cluster.get("status", {}).get("health", {})
ready = health.get("available") is True and health.get("fullReplication") is True
ready = ready and cluster.get("metadata", {}).get("generation") == cluster.get("status", {}).get("generations", {}).get("reconciled")
raise SystemExit(0 if ready else 1)
PY
	then
		break
	fi
	sleep 10
done
if ((SECONDS >= deadline)); then
	echo "isolated FDB target did not become fully replicated" >&2
	exit 1
fi

stage=restore
"${kube[@]}" apply -f "$render_dir/restore-agents.yaml"
"${kube[@]}" -n "$namespace" rollout status deployment/"${target}-restore-agents" --timeout=20m
"${kube[@]}" -n "$namespace" get pods -l "app.kubernetes.io/name=${target}-restore-agent" -o json >"$workdir/restore-agents.json"
"${kube[@]}" get nodes -o json >"$workdir/restore-nodes.json"
python3 - "$workdir/restore-agents.json" "$workdir/restore-nodes.json" "$workdir/restore-agent-placement.json" <<'PY'
import json, sys

pods = json.load(open(sys.argv[1]))["items"]
nodes = {
    node["metadata"]["name"]: node["metadata"].get("labels", {}).get("topology.kubernetes.io/zone")
    for node in json.load(open(sys.argv[2]))["items"]
}
ready = [
    pod for pod in pods
    if pod.get("status", {}).get("phase") == "Running"
    and pod.get("status", {}).get("containerStatuses")
    and all(container.get("ready") for container in pod["status"]["containerStatuses"])
]
placement = [
    {"pod": pod["metadata"]["name"], "node": pod["spec"]["nodeName"], "zone": nodes.get(pod["spec"]["nodeName"])}
    for pod in ready
]
if len(placement) != 3 or len({item["node"] for item in placement}) != 3 or len({item["zone"] for item in placement}) != 3:
    raise SystemExit("restore agents are not Ready in three distinct availability zones")
with open(sys.argv[3], "w") as output:
    json.dump(placement, output, indent=2, sort_keys=True)
    output.write("\n")
PY
restore_pod=$("${kube[@]}" -n "$namespace" get pod -l "app.kubernetes.io/name=${target}-restore-agent" -o jsonpath='{.items[0].metadata.name}')
restore_tag=${target}-restore
timeout "$restore_timeout_seconds" "${kube[@]}" -n "$namespace" exec "$restore_pod" -c foundationdb -- \
	fdbrestore start -w -r "$backup_url" -v "$restore_version" \
	--dest-cluster-file /var/dynamic-conf/fdb.cluster -t "$restore_tag" \
	>"$workdir/fdbrestore-start.txt"
"${kube[@]}" -n "$namespace" exec "$restore_pod" -c foundationdb -- \
	fdbrestore status -t "$restore_tag" --dest_cluster_file /var/dynamic-conf/fdb.cluster \
	>"$workdir/fdbrestore-status.txt"
grep -q 'State: completed' "$workdir/fdbrestore-status.txt" || {
	echo "FDB restore did not reach completed" >&2
	cat "$workdir/fdbrestore-status.txt" >&2
	exit 1
}
else
	stage=restore
	backup_url=$(python3 - "$backup_json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["status"]["backupDetails"]["url"])
PY
	)
	restore_version=$(sed -n 's/^MaxRestorableVersion:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$workdir/backup-description.txt" | tail -1)
	[[ $restore_version =~ ^[0-9]+$ ]] || { echo "resumed restore version is invalid" >&2; exit 1; }
	restore_tag=${target}-restore
	restore_pod=$("${kube[@]}" -n "$namespace" get pod -l "app.kubernetes.io/name=${target}-restore-agent" -o jsonpath='{.items[0].metadata.name}')
	[[ -n $restore_pod ]] || { echo "resumed restore agent is missing" >&2; exit 1; }
	deadline=$((SECONDS + restore_timeout_seconds))
	while ((SECONDS < deadline)); do
		"${kube[@]}" -n "$namespace" exec "$restore_pod" -c foundationdb -- \
			fdbrestore status -t "$restore_tag" --dest_cluster_file /var/dynamic-conf/fdb.cluster \
			>"$workdir/fdbrestore-status.txt"
		grep -q 'State: completed' "$workdir/fdbrestore-status.txt" && break
		grep -q 'State: aborted\|State: failed' "$workdir/fdbrestore-status.txt" && {
			echo "resumed FDB restore reached a terminal failure" >&2
			exit 1
		}
		sleep 30
	done
	grep -q 'State: completed' "$workdir/fdbrestore-status.txt" || {
		echo "resumed FDB restore did not reach completed" >&2
		exit 1
	}
fi

stage=verify
"${kube[@]}" apply -f "$render_dir/verify-job.json"
verifier_job=$(python3 - "$render_dir/render.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1]))["verifier_job"])
PY
)
"${kube[@]}" -n "$namespace" wait --for=condition=complete --timeout=30m "job/$verifier_job"
"${kube[@]}" -n "$namespace" logs "job/$verifier_job" >"$workdir/verifier.log"
grep -q '^restored_actor_verification=passed actors=12$' "$workdir/verifier.log"
"${kube[@]}" -n "$namespace" scale deployment "${target}-restore-agents" --replicas=0
deadline=$((SECONDS + 300))
while ((SECONDS < deadline)); do
	agent_replicas=$("${kube[@]}" -n "$namespace" get deployment "${target}-restore-agents" -o jsonpath='{.status.replicas}' 2>/dev/null || true)
	[[ -z $agent_replicas || $agent_replicas == 0 ]] && break
	sleep 5
done
((SECONDS < deadline)) || { echo "temporary restore agents did not scale to zero" >&2; exit 1; }
"${kube[@]}" -n "$namespace" get foundationdbcluster "$target" -o json >"$workdir/target-cluster.json"
"${kube[@]}" -n "$namespace" get pvc -l "foundationdb.org/fdb-cluster-name=${target}" -o json >"$workdir/target-pvcs.json"

stage=source-cleanup
"${kube[@]}" -n "$namespace" port-forward service/"${cell}-engine" 26420:6420 >"$workdir/engine-forward.log" 2>&1 &
forward_pid=$!
"${kube[@]}" -n "$namespace" port-forward service/"${cell}-workers-api" 26422:8080 >"$workdir/workers-api-forward.log" 2>&1 &
workers_forward_pid=$!
for _ in $(seq 1 60); do
	curl -fsS http://127.0.0.1:26420/health >/dev/null 2>&1 && \
		curl -fsS http://127.0.0.1:26422/readyz >/dev/null 2>&1 && break
	sleep 1
done
python3 "$fleet_root/../qualify_workerd_density.py" \
	--engine-url http://127.0.0.1:26420 \
	--workers-api-url http://127.0.0.1:26422 \
	--public-worker "$qualification_worker" \
	--public-class-name Agent \
	--verify-from "$seed" \
	--concurrency 12 \
	--cleanup-verified \
	--output "$cleanup_result"
kill "$forward_pid" 2>/dev/null || true
wait "$forward_pid" 2>/dev/null || true
unset forward_pid
kill "$workers_forward_pid" 2>/dev/null || true
wait "$workers_forward_pid" 2>/dev/null || true
unset workers_forward_pid

stage=receipt
RECEIPT=$receipt RUN_ID=$run_id TARGET=$target RESTORE_TAG=$restore_tag \
RESTORE_VERSION=$restore_version SEED_VERSION=$seed_version WORKDIR=$workdir \
RESUME_FAILURE_SHA=$resume_failure_sha RESUME_FAILURE_RUN_ID=$resume_failure_run_id \
RESUME_FAILURE_STAGE=$resume_failure_stage \
CELL=$cell NAMESPACE=$namespace \
python3 - <<'PY'
import hashlib
import json
import os
import re
from datetime import datetime, timezone

root = os.environ["WORKDIR"]
seed = json.load(open(root + "/seed.json"))
source = json.load(open(root + "/source-cluster.json"))
target = json.load(open(root + "/target-cluster.json"))
cleanup = json.load(open(root + "/source-cleanup.json"))
pvcs = json.load(open(root + "/target-pvcs.json"))
agent_placement = json.load(open(root + "/restore-agent-placement.json"))
status = open(root + "/fdbrestore-status.txt").read()
uid_match = re.search(r"UID:\s*([0-9a-f]+)", status)
if cleanup.get("verdict") != "passed" or cleanup.get("actors_removed") is not True or cleanup.get("cleanup_errors") != []:
    raise SystemExit("source qualification Actor cleanup failed")
payload = {
    "schema": "actor-fdb-physical-restore-v1",
    "verdict": "passed",
    "cell": os.environ["CELL"],
    "namespace": os.environ["NAMESPACE"],
    "run_id": os.environ["RUN_ID"],
    "started_from_release": seed.get("release_binding"),
    "public_api_only": seed.get("public_api_only"),
    "application_api": seed.get("application_api"),
    "privileged_recovery_interfaces": [
        "engine_depot_direct_restore_verification",
        "foundationdb_backup_restore_control",
        "kubernetes_isolated_target_control",
    ],
    "finished_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
    "source": {
        "cluster": source["metadata"]["name"],
        "cluster_uid": source["metadata"]["uid"],
        "frozen_read_version": int(os.environ["SEED_VERSION"]),
        "actor_manifest_sha256": seed["actor_manifest_sha256"],
        "actors": len(seed["actor_records"]),
        "actors_deleted_after_verification": True,
    },
    "restore": {
        "target_cluster": os.environ["TARGET"],
        "target_cluster_uid": target["metadata"]["uid"],
        "tag": os.environ["RESTORE_TAG"],
        "uid": uid_match.group(1) if uid_match else None,
        "version": int(os.environ["RESTORE_VERSION"]),
        "state": "completed",
        "fdb_available": target["status"]["health"]["available"],
        "fdb_full_replication": target["status"]["health"]["fullReplication"],
        "agents": {"count": len(agent_placement), "placement": agent_placement, "scaled_to_zero": True},
    },
    "verification": {
        "integrity_check": "ok",
        "actor_state_exact": True,
        "cold_objects_readable": True,
        "actors_verified": len(seed["actor_records"]),
        "runtime_image": seed["release_binding"]["runtime_image"],
    },
    "retained_target": {
        "review_required_before_cleanup": True,
        "persistent_volume_claims": sorted(item["metadata"]["name"] for item in pvcs.get("items", [])),
    },
}
if os.environ.get("RESUME_FAILURE_SHA"):
    failure_stage = os.environ["RESUME_FAILURE_STAGE"]
    payload["resume"] = {
        "failure_stage": failure_stage,
        "failure_run_id": os.environ["RESUME_FAILURE_RUN_ID"],
        "failure_receipt_sha256": os.environ["RESUME_FAILURE_SHA"],
        "frozen_seed_revalidated": True,
        "seed_reused_after_render_failure": failure_stage == "render",
        "target_reused_after_restore_interruption": failure_stage == "restore",
    }
canonical = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
payload["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
path = os.environ["RECEIPT"]
temporary = path + ".tmp"
with open(temporary, "w") as output:
    json.dump(payload, output, indent=2, sort_keys=True)
    output.write("\n")
os.replace(temporary, path)
PY

stage=complete
trap - EXIT INT TERM
python3 "$script_dir/verify-receipt.py" "$receipt" \
	--expected-cell "$cell" --expected-namespace "$namespace"
CELL=$cell CELL_NAMESPACE=$namespace KUBECONFIG_PATH=$kubeconfig \
	"$operations_dir/cache-qualification-receipt.sh" "$receipt"
sha256sum "$receipt"
printf 'physical_restore=passed receipt=%s target=%s retained_for_review=true\n' "$receipt" "$target"
