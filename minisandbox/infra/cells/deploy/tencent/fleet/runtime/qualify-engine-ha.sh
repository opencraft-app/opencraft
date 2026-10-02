#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell_name=$RIVET_CELL_NAME
deployment=${ENGINE_DEPLOYMENT:-${cell_name}-engine}
pdb=${ENGINE_PDB:-${cell_name}-engine}
receipt=${ENGINE_HA_RECEIPT:-$script_dir/runtime-engine-ha.json}
operations_dir=$(CDPATH= cd -- "$script_dir/../operations" && pwd)
dynamic_runtime_capacity=${ENGINE_HA_DYNAMIC_RUNTIME_CAPACITY:-false}
case "$dynamic_runtime_capacity" in
true | false) ;;
*) echo "ENGINE_HA_DYNAMIC_RUNTIME_CAPACITY must be true or false" >&2; exit 2 ;;
esac
kubeconfig_args=()
if [[ -n ${KUBECONFIG:-} ]]; then
	kubeconfig_args=(--kubeconfig "$KUBECONFIG")
fi

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="runtime.engine-ha" \
	AUTONOMY_CONTROL_CELL="$cell_name" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
	"$operations_dir/assert-autonomy-control.sh"
fi

if [[ ${RUNTIME_SCALE_IN_HOLD_HELD:-0} != 1 ]]; then
	exec "$script_dir/with-runtime-scale-in-hold.sh" "$0" "$@"
fi

for artifact in "$script_dir/engine-ha-probe.sh" "$script_dir/engine-ha-probe-job.yaml"; do
	[[ -f "$artifact" ]] || {
		echo "Engine HA qualification artifact is missing: $artifact" >&2
		exit 2
	}
done
release_binding_helper=$script_dir/capture_release_binding.py
[[ -f $release_binding_helper ]] || {
	echo "release binding helper is missing: $release_binding_helper" >&2
	exit 2
}
[[ -x "$script_dir/engine-ha-probe.sh" ]] || {
	echo "Engine HA probe must be executable: $script_dir/engine-ha-probe.sh" >&2
	exit 2
}

mkdir -p /data/tmp
temporary=$(mktemp -d /data/tmp/q01-engine-ha.XXXXXX)
qualification_worker=${ENGINE_HA_WORKER:-${cell_name##*-}-engine-ha-gate}
[[ $qualification_worker =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#qualification_worker} -le 63 ]] || {
	echo "Engine HA Worker identity is not DNS-safe: $qualification_worker" >&2
	exit 2
}
cleanup() {
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

capture_release() {
	local phase=$1
	local dynamic_args=()
	if [[ $dynamic_runtime_capacity == true ]]; then
		dynamic_args+=(--dynamic-runtime-capacity)
	fi
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "$deployment" -o json \
		>"$temporary/$phase-release-engine.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-runtime-hosts" -o json \
		>"$temporary/$phase-release-runtime.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
		-l "fleet.actor.dev/cell-name=$cell_name" -o json \
		>"$temporary/$phase-release-pods.json"
	python3 "$release_binding_helper" \
		--deployment "$temporary/$phase-release-engine.json" \
		--statefulset "$temporary/$phase-release-runtime.json" \
		--pods "$temporary/$phase-release-pods.json" "${dynamic_args[@]}" \
		>"$temporary/$phase-release-binding.json"
}

snapshot() {
	local phase=$1
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "$deployment" -o json \
		>"$temporary/$phase-deployment.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get pdb "$pdb" -o json \
		>"$temporary/$phase-pdb.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
		-l "fleet.actor.dev/cell-name=$cell_name,fleet.actor.dev/component=engine" -o json \
		>"$temporary/$phase-pods.json"
	kubectl "${kubeconfig_args[@]}" get nodes -o json >"$temporary/$phase-nodes.json"

	python3 - "$phase" "$temporary/$phase-summary.json" \
		"$temporary/$phase-deployment.json" "$temporary/$phase-pdb.json" \
		"$temporary/$phase-pods.json" "$temporary/$phase-nodes.json" <<'PY'
import json
import sys
from pathlib import Path

phase, output_path, deployment_path, pdb_path, pods_path, nodes_path = sys.argv[1:]
deployment = json.load(open(deployment_path))
pdb = json.load(open(pdb_path))
pod_list = json.load(open(pods_path))["items"]
nodes = {
    node["metadata"]["name"]: node
    for node in json.load(open(nodes_path))["items"]
}

spec = deployment["spec"]
rolling = spec.get("strategy", {}).get("rollingUpdate", {})
if spec.get("replicas") != 6 or spec.get("strategy", {}).get("type") != "RollingUpdate":
    raise SystemExit("Engine must have six steady Deployment replicas")
if str(rolling.get("maxUnavailable")) != "0" or str(rolling.get("maxSurge")) != "1":
    raise SystemExit("Engine rolling update must retain the qualified unavailable=0/surge=1 policy")
if pdb.get("spec", {}).get("minAvailable") != 4:
    raise SystemExit("Engine PDB must retain four replicas")

ready = []
for pod in pod_list:
    if pod.get("metadata", {}).get("deletionTimestamp"):
        continue
    conditions = {
        condition.get("type"): condition.get("status")
        for condition in pod.get("status", {}).get("conditions", [])
    }
    containers = pod.get("status", {}).get("containerStatuses", [])
    if (
        pod.get("status", {}).get("phase") == "Running"
        and conditions.get("Ready") == "True"
        and containers
        and all(container.get("ready") for container in containers)
    ):
        ready.append(pod)

if len(ready) != 6:
    raise SystemExit(f"{phase}: expected exactly six non-terminating Ready Engine Pods, got {len(ready)}")
if deployment.get("status", {}).get("availableReplicas") != 6:
    raise SystemExit(f"{phase}: Deployment did not report six available Engine replicas")

topology = []
for pod in sorted(ready, key=lambda item: item["metadata"]["name"]):
    node_name = pod.get("spec", {}).get("nodeName")
    node = nodes.get(node_name)
    if not node:
        raise SystemExit(f"{phase}: Engine Pod has no resolved Node: {pod['metadata']['name']}")
    labels = node.get("metadata", {}).get("labels", {})
    hostname = labels.get("kubernetes.io/hostname")
    zone = labels.get("topology.kubernetes.io/zone")
    if not hostname or not zone:
        raise SystemExit(f"{phase}: Engine Node lacks standard hostname/zone labels")
    status = pod.get("status", {}).get("containerStatuses", [])
    topology.append({
        "pod": pod["metadata"]["name"],
        "uid": pod["metadata"]["uid"],
        "node": node_name,
        "hostname": hostname,
        "zone": zone,
        "image": pod["spec"]["containers"][0]["image"],
        "image_id": status[0].get("imageID"),
        "restart_count": sum(item.get("restartCount", 0) for item in status),
    })

hostname_counts = {}
zone_counts = {}
for item in topology:
    hostname_counts[item["hostname"]] = hostname_counts.get(item["hostname"], 0) + 1
    zone_counts[item["zone"]] = zone_counts.get(item["zone"], 0) + 1
if len(hostname_counts) != 3 or max(hostname_counts.values()) - min(hostname_counts.values()) > 1:
    raise SystemExit(f"{phase}: Engine replicas are not evenly spread over three hostnames")
if len(zone_counts) != 3 or max(zone_counts.values()) - min(zone_counts.values()) > 1:
    raise SystemExit(f"{phase}: Engine replicas are not evenly spread over three zones")
if len({item["image"] for item in topology}) != 1:
    raise SystemExit(f"{phase}: Engine replicas do not use one immutable release image")

pdb_status = pdb.get("status", {})
if phase == "before" and pdb_status.get("disruptionsAllowed", 0) < 1:
    raise SystemExit("Engine PDB does not currently permit one disruption")

summary = {
    "phase": phase,
    "deployment_generation": deployment["metadata"].get("generation"),
    "deployment_replicas": 6,
    "deployment_available": deployment.get("status", {}).get("availableReplicas"),
    "pdb_min_available": 4,
    "pdb_current_healthy": pdb_status.get("currentHealthy"),
    "pdb_disruptions_allowed": pdb_status.get("disruptionsAllowed"),
    "image": topology[0]["image"],
    "topology": topology,
}
Path(output_path).write_text(json.dumps(summary, sort_keys=True) + "\n")
PY
}

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
snapshot before
capture_release before
image=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["image"])' \
	"$temporary/before-summary.json")
victim_pod=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["topology"][0]["pod"])' \
	"$temporary/before-summary.json")
victim_uid=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["topology"][0]["uid"])' \
	"$temporary/before-summary.json")
victim_node=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["topology"][0]["node"])' \
	"$temporary/before-summary.json")
victim_zone=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["topology"][0]["zone"])' \
	"$temporary/before-summary.json")

job_name="${cell_name}-engine-ha-$(date +%s)-$$"
kubectl "${kubeconfig_args[@]}" -n "$namespace" create configmap "$job_name" \
	--from-file=engine-ha-probe.sh="$script_dir/engine-ha-probe.sh" \
	--dry-run=client -o yaml >"$temporary/configmap.yaml"
kubectl "${kubeconfig_args[@]}" apply -f "$temporary/configmap.yaml" >/dev/null
kubectl "${kubeconfig_args[@]}" -n "$namespace" label configmap "$job_name" \
	"fleet.actor.dev/cell-name=$cell_name" \
	"fleet.actor.dev/component=engine-ha-probe" --overwrite >/dev/null

python3 - "$script_dir/engine-ha-probe-job.yaml" "$temporary/job.yaml" \
	"$job_name" "$namespace" "$cell_name" "$image" "$qualification_worker" <<'PY'
import sys
from pathlib import Path

source, destination, job_name, namespace, cell_name, image, worker = sys.argv[1:]
rendered = Path(source).read_text()
for token, value in {
    "__ENGINE_HA_PROBE_JOB__": job_name,
    "__RIVET_CELL_NAMESPACE__": namespace,
    "__RIVET_CELL_NAME__": cell_name,
    "__RIVET_RUNTIME_IMAGE__": image,
    "__ENGINE_HA_WORKER__": worker,
}.items():
    rendered = rendered.replace(token, value)
if "__" in rendered:
    raise SystemExit("unresolved Engine HA Job template token")
Path(destination).write_text(rendered)
PY
kubectl "${kubeconfig_args[@]}" apply -f "$temporary/job.yaml" >/dev/null

probe_ready=false
for _ in $(seq 1 660); do
	if kubectl "${kubeconfig_args[@]}" -n "$namespace" logs "job/$job_name" 2>/dev/null \
		| grep -q '^probe_ready '; then
		probe_ready=true
		break
	fi
	failed=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get job "$job_name" \
		-o jsonpath='{.status.failed}' 2>/dev/null || true)
	if [[ ${failed:-0} -gt 0 ]]; then
		kubectl "${kubeconfig_args[@]}" -n "$namespace" logs "job/$job_name" >&2 || true
		echo "Engine HA probe failed before fault injection" >&2
		exit 1
	fi
	sleep 1
done
if [[ $probe_ready != true ]]; then
	kubectl "${kubeconfig_args[@]}" -n "$namespace" logs "job/$job_name" >&2 || true
	echo "Engine HA probe did not become ready" >&2
	exit 1
fi

current_victim_uid=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pod "$victim_pod" \
	-o jsonpath='{.metadata.uid}')
if [[ $current_victim_uid != "$victim_uid" ]]; then
	echo "selected Engine victim changed after the read-only preflight" >&2
	exit 1
fi
injected_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
injected_at_epoch_ms=$(date +%s%3N)
cat >"$temporary/delete-options.json" <<JSON
{
  "apiVersion": "v1",
  "kind": "DeleteOptions",
  "gracePeriodSeconds": 0,
  "propagationPolicy": "Background",
  "preconditions": {"uid": "$victim_uid"}
}
JSON
kubectl "${kubeconfig_args[@]}" delete \
	--raw "/api/v1/namespaces/$namespace/pods/$victim_pod" \
	-f "$temporary/delete-options.json" >"$temporary/delete-response.json"
python3 - "$temporary/delete-response.json" "$victim_uid" <<'PY'
import json
import sys

response = json.load(open(sys.argv[1]))
expected_uid = sys.argv[2]
if response.get("metadata", {}).get("uid") != expected_uid:
    raise SystemExit("Kubernetes did not acknowledge deletion of the exact selected Engine Pod UID")
PY

job_complete=false
for _ in $(seq 1 1860); do
	succeeded=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get job "$job_name" \
		-o jsonpath='{.status.succeeded}' 2>/dev/null || true)
	failed=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get job "$job_name" \
		-o jsonpath='{.status.failed}' 2>/dev/null || true)
	if [[ ${succeeded:-0} -gt 0 ]]; then
		job_complete=true
		break
	fi
	if [[ ${failed:-0} -gt 0 ]]; then
		break
	fi
	sleep 1
done
if [[ $job_complete != true ]]; then
	kubectl "${kubeconfig_args[@]}" -n "$namespace" logs "job/$job_name" >&2 || true
	echo "Engine HA probe did not complete successfully" >&2
	exit 1
fi
kubectl "${kubeconfig_args[@]}" -n "$namespace" logs "job/$job_name" \
	>"$temporary/probe.log"
python3 - "$temporary/probe.log" "$temporary/probe-result.json" "$injected_at_epoch_ms" "$qualification_worker" <<'PY'
import json
import sys
from pathlib import Path

result = None
injected_at_ms = int(sys.argv[3])
expected_worker = sys.argv[4]
for line in reversed(Path(sys.argv[1]).read_text().splitlines()):
    try:
        candidate = json.loads(line)
    except json.JSONDecodeError:
        continue
    if candidate.get("verdict") in {"passed", "failed"}:
        result = candidate
        break
if result is None:
    raise SystemExit("Engine HA probe emitted no result")
if result.get("verdict") != "passed" or result.get("failures") != 0:
    raise SystemExit(f"Engine HA request continuity failed: {result}")
if result.get("public_api") != "/v1":
    raise SystemExit("Engine HA probe bypassed the public /v1 Workers API")
if result.get("object_count") != 10 or result.get("concurrency") != 10:
    raise SystemExit("Engine HA probe did not exercise ten independent public Objects in parallel")
if result.get("cleanup") != "passed":
    raise SystemExit("Engine HA probe did not clean up its public Objects")
if result.get("worker") != expected_worker or result.get("worker_fixture_retained") is not True:
    raise SystemExit("Engine HA probe did not use the fixed retained Cell-scoped Worker fixture")
if result.get("post_failure_write_count") != 1:
    raise SystemExit("Engine HA probe did not verify the post-failure SQLite write")
started = result.get("traffic_started_at_ms")
finished = result.get("traffic_finished_at_ms")
if not (
    isinstance(started, int)
    and isinstance(finished, int)
    and started < injected_at_ms < finished
):
    raise SystemExit("Engine fault did not occur inside the measured public request window")
Path(sys.argv[2]).write_text(json.dumps(result, sort_keys=True) + "\n")
PY

kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status "deployment/$deployment" \
	--timeout=15m >/dev/null
snapshot after
capture_release after
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)

mkdir -p "$(dirname -- "$receipt")"
python3 - "$temporary/before-summary.json" "$temporary/after-summary.json" \
	"$temporary/before-release-binding.json" "$temporary/after-release-binding.json" \
	"$temporary/probe-result.json" "$receipt" "$namespace" "$cell_name" \
	"$victim_pod" "$victim_uid" "$victim_node" "$victim_zone" \
	"$started_at" "$injected_at" "$injected_at_epoch_ms" "$finished_at" <<'PY'
import hashlib
import json
import sys
from pathlib import Path

(
    before_path,
    after_path,
    before_release_path,
    after_release_path,
    probe_path,
    receipt_path,
    namespace,
    cell_name,
    victim_pod,
    victim_uid,
    victim_node,
    victim_zone,
    started_at,
    injected_at,
    injected_at_epoch_ms,
    finished_at,
) = sys.argv[1:]
before = json.load(open(before_path))
after = json.load(open(after_path))
before_release = json.load(open(before_release_path))
after_release = json.load(open(after_release_path))
probe = json.load(open(probe_path))
if victim_uid in {item["uid"] for item in after["topology"]}:
    raise SystemExit("deleted Engine Pod UID remained in the restored steady topology")
if before["image"] != after["image"]:
    raise SystemExit("Engine image changed during the HA fault drill")
release_fields = ("runtime_image", "runtime_digest", "manifest_sha256")
if any(before_release.get(field) != after_release.get(field) for field in release_fields):
    raise SystemExit("immutable runtime release changed during the HA fault drill")

receipt = {
    "schema": "actor-cell-engine-ha/v1",
    "verdict": "passed",
    "contract": "public_v1_workers_api_survives_one_engine_pod_loss_without_request_failure",
    "cell_name": cell_name,
    "cell": cell_name,
    "cell_namespace": namespace,
    "namespace": namespace,
    "started_at": started_at,
    "fault_injected_at": injected_at,
    "finished_at": finished_at,
    "release_binding": before_release,
    "release_binding_after": after_release,
    "fault": {
        "kind": "uid_fenced_zero_grace_engine_pod_delete",
        "pod": victim_pod,
        "uid": victim_uid,
        "node": victim_node,
        "zone": victim_zone,
        "injected_at_epoch_ms": int(injected_at_epoch_ms),
    },
    "before": before,
    "probe": probe,
    "after": after,
}
canonical = json.dumps(receipt, sort_keys=True, separators=(",", ":")).encode()
receipt["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
Path(receipt_path).write_text(json.dumps(receipt, indent=2, sort_keys=True) + "\n")
print(json.dumps({
    "verdict": receipt["verdict"],
    "contract": receipt["contract"],
    "victim": victim_pod,
    "objects": probe["object_count"],
    "public_api": probe["public_api"],
    "requests": probe["requests"],
    "concurrency": probe["concurrency"],
    "request_failures": probe["failures"],
    "post_failure_write_count": probe["post_failure_write_count"],
    "worker_fixture_retained": probe["worker_fixture_retained"],
    "evidence_sha256": receipt["evidence_sha256"],
}, sort_keys=True))
PY

kubectl "${kubeconfig_args[@]}" -n "$namespace" delete configmap "$job_name" \
	--ignore-not-found >/dev/null
