#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=mesh-observability
targets=${ACTOR_FEDERATION_TARGETS:?ACTOR_FEDERATION_TARGETS is required}
python=${PYTHON:-python3}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

for command in kubectl curl; do
	command -v "$command" >/dev/null || { echo "required command is missing: $command" >&2; exit 2; }
done
command -v "$python" >/dev/null || { echo "PYTHON interpreter is unavailable: $python" >&2; exit 2; }
"$python" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' || {
	echo "PYTHON must select Python 3.10 or newer" >&2
	exit 2
}

temporary=$(mktemp -d)
cleanup() {
	if [[ -n ${forward_pid:-} ]]; then
		kill "$forward_pid" 2>/dev/null || true
		wait "$forward_pid" 2>/dev/null || true
	fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT

kubectl "${kubeconfig_args[@]}" -n "$namespace" port-forward \
	service/actor-mesh-observability-prometheus 29090:9090 >"$temporary/forward.log" 2>&1 &
forward_pid=$!
for _ in $(seq 1 30); do
	curl --fail --silent http://127.0.0.1:29090/-/ready >/dev/null && break
	sleep 1
done
curl --fail --silent http://127.0.0.1:29090/-/ready >/dev/null || {
	cat "$temporary/forward.log" >&2
	exit 1
}

capture_snapshot() {
	curl --fail --silent --get http://127.0.0.1:29090/api/v1/query \
		--data-urlencode 'query=up{federation="actor-cell"}' >"$temporary/up.json" || return
	curl --fail --silent --get http://127.0.0.1:29090/api/v1/query \
		--data-urlencode 'query=actor_fleet:cell_heartbeat_seconds' >"$temporary/heartbeat.json" || return
	curl --fail --silent --get http://127.0.0.1:29090/api/v1/query \
		--data-urlencode 'query=count by (cell) (actor_fleet:cell_inventory)' >"$temporary/inventory.json" || return
	curl --fail --silent --get http://127.0.0.1:29090/api/v1/query \
		--data-urlencode 'query=count({__name__=~"rivet_sqlite_.*|actor_foundationdb_.*"})' >"$temporary/raw.json" || return
	curl --fail --silent --get http://127.0.0.1:29090/api/v1/query \
		--data-urlencode 'query=count by (cluster) (actor_fleet:compute_node_inventory)' >"$temporary/compute.json" || return
	curl --fail --silent --get http://127.0.0.1:29090/api/v1/query \
		--data-urlencode 'query=sum by (cluster) (actor_fleet:cell_v8_actor_capacity)' >"$temporary/v8-capacity.json" || return
}

validate_snapshot() {
	"$python" - "$targets" "$temporary/up.json" "$temporary/heartbeat.json" "$temporary/inventory.json" "$temporary/raw.json" "$temporary/compute.json" "$temporary/v8-capacity.json" <<'PY'
import json, sys, time, yaml
targets = yaml.safe_load(open(sys.argv[1]))["targets"]
expected = {target["cluster"] for target in targets}
up = json.load(open(sys.argv[2]))["data"]["result"]
observed = {sample["metric"].get("cluster") for sample in up}
if observed != expected:
    raise SystemExit(f"federation target mismatch: expected={sorted(expected)} observed={sorted(observed)}")
down = [sample["metric"]["cluster"] for sample in up if float(sample["value"][1]) != 1]
if down:
    raise SystemExit(f"federation targets down: {down}")
heartbeats = json.load(open(sys.argv[3]))["data"]["result"]
if not heartbeats:
    raise SystemExit("no federated Cell heartbeat exists")
stale = [sample["metric"] for sample in heartbeats if time.time() - float(sample["value"][1]) > 180]
if stale:
    raise SystemExit(f"stale federated Cell heartbeat: {stale}")
inventory = json.load(open(sys.argv[4]))["data"]["result"]
duplicates = [sample["metric"].get("cell") for sample in inventory if float(sample["value"][1]) != 1]
if duplicates:
    raise SystemExit(f"Cell identity appears in multiple clusters: {duplicates}")
raw = json.load(open(sys.argv[5]))["data"]["result"]
if raw and float(raw[0]["value"][1]) != 0:
    raise SystemExit("Hub contains raw spoke metrics outside the federation boundary")
compute = json.load(open(sys.argv[6]))["data"]["result"]
compute_clusters = {sample["metric"].get("cluster") for sample in compute if float(sample["value"][1]) > 0}
if compute_clusters != expected:
    raise SystemExit(
        f"compute-node inventory mismatch: expected={sorted(expected)} observed={sorted(compute_clusters)}"
    )
capacity = json.load(open(sys.argv[7]))["data"]["result"]
capacity_clusters = {
    sample["metric"].get("cluster") for sample in capacity if float(sample["value"][1]) > 0
}
if capacity_clusters != expected:
    raise SystemExit(
        f"V8 Actor capacity mismatch: expected={sorted(expected)} observed={sorted(capacity_clusters)}"
    )
PY
}

# A newly installed Prometheus needs at least one complete 30-second scrape
# and rule-evaluation interval. Poll the same fixed target set instead of
# making the unattended install fail on an expected empty first query.
federation_ready=false
for _ in $(seq 1 18); do
	if capture_snapshot 2>"$temporary/federation-error" && \
		validate_snapshot 2>"$temporary/federation-error"; then
		federation_ready=true
		break
	fi
	sleep 10
done
if [[ $federation_ready != true ]]; then
	cat "$temporary/federation-error" >&2
	echo "federation did not converge within 180 seconds" >&2
	exit 1
fi

kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap \
	actor-mesh-overview-dashboard >/dev/null
kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap \
	actor-mesh-compute-dashboard -o json | "$python" -c '
import json, sys
config = json.load(sys.stdin)["data"]["actor-mesh-compute.json"]
dashboard = json.loads(config)
titles = {panel["title"] for panel in dashboard["panels"]}
required = {"V8 Actor 容量水位", "V8 剩余 Actor 槽位", "逐节点 V8 Actor 装箱水位", "workerd Pod 与计算节点扩缩容"}
missing = sorted(required - titles)
if missing:
    raise SystemExit(f"compute dashboard capacity panels missing: {missing}")
'
kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap \
	actor-mesh-storage-dashboard >/dev/null
kubectl "${kubeconfig_args[@]}" -n "$namespace" get servicemonitor \
	actor-mesh-workers-api -o json | "$python" -c '
import json, sys
monitor = json.load(sys.stdin)["spec"]
if monitor.get("namespaceSelector", {}).get("matchNames") != ["workers-api-system"]:
    raise SystemExit("Workers API monitor escaped its exact namespace")
if monitor.get("selector", {}).get("matchLabels") != {"fleet.actor.dev/metrics-source": "workers-api"}:
    raise SystemExit("Workers API monitor escaped its exact Service")
endpoint = monitor["endpoints"][0]
if endpoint.get("path") != "/metrics" or endpoint.get("interval") != "15s" or monitor.get("targetLimit") != 30:
    raise SystemExit("Workers API scrape endpoint drifted")
'
kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
	deployment/actor-mesh-prometheus-adapter --timeout=5m >/dev/null
kubectl "${kubeconfig_args[@]}" get apiservice v1beta1.custom.metrics.k8s.io -o json | "$python" -c '
import json, sys
value = json.load(sys.stdin)
if not any(item.get("type") == "Available" and item.get("status") == "True" for item in value.get("status", {}).get("conditions", [])):
    raise SystemExit("Hub custom metrics APIService is unavailable")
'
kubectl "${kubeconfig_args[@]}" get --raw /apis/custom.metrics.k8s.io/v1beta1 | "$python" -c '
import json, sys
names = {item.get("name") for item in json.load(sys.stdin).get("resources", [])}
expected = {"pods/workers_api_routing_requests_per_second", "pods/workers_api_routing_requests_in_flight"}
if not expected.issubset(names):
    raise SystemExit(f"Hub Router custom metrics are absent: {sorted(expected - names)}")
'
workers_metrics_ready=false
for _ in $(seq 1 24); do
	ready_replicas=$(kubectl "${kubeconfig_args[@]}" -n workers-api-system get deployment workers-api \
		-o jsonpath='{.status.readyReplicas}' 2>/dev/null || true)
	qps=$(kubectl "${kubeconfig_args[@]}" get --raw \
		'/apis/custom.metrics.k8s.io/v1beta1/namespaces/workers-api-system/pods/*/workers_api_routing_requests_per_second' \
		2>/dev/null || true)
	inflight=$(kubectl "${kubeconfig_args[@]}" get --raw \
		'/apis/custom.metrics.k8s.io/v1beta1/namespaces/workers-api-system/pods/*/workers_api_routing_requests_in_flight' \
		2>/dev/null || true)
	if READY_REPLICAS="$ready_replicas" QPS="$qps" INFLIGHT="$inflight" "$python" -c '
import json, os
ready = int(os.environ.get("READY_REPLICAS") or 0)
values = [json.loads(os.environ[name]) for name in ("QPS", "INFLIGHT")]
raise SystemExit(0 if ready >= 3 and all(len(value.get("items", [])) == ready for value in values) else 1)
'; then
		workers_metrics_ready=true
		break
	fi
	sleep 5
done
[[ $workers_metrics_ready == true ]] || {
	echo "Workers API custom metrics did not expose one live value per Ready Pod" >&2
	exit 1
}
kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap \
	actor-mesh-workers-dashboard -o json | "$python" -c '
import json, sys
config = json.load(sys.stdin)["data"]["actor-mesh-workers.json"]
dashboard = json.loads(config)
titles = {panel["title"] for panel in dashboard["panels"]}
required = {"无状态 dispatch 结果", "Durable Object 路由结果", "Object placement 缓存命中率", "Registry 操作 p95", "中央 Router 负载与延迟", "中央 Router HPA 水位"}
missing = sorted(required - titles)
if missing:
    raise SystemExit(f"Workers dashboard panels missing: {missing}")
'
echo "mesh federation verified"
