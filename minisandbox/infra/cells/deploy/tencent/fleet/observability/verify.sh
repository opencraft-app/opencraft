#!/usr/bin/env bash
set -euo pipefail

namespace=observability
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

for command in kubectl curl python3; do
	command -v "$command" >/dev/null || {
		echo "required command is missing: $command" >&2
		exit 2
	}
done

[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get prometheus actor-observability-prometheus \
	-o jsonpath='{.status.availableReplicas}') == 1 ]]
[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset actor-observability-grafana \
	-o jsonpath='{.status.readyReplicas}') == 1 ]]
pvc_phases=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pvc \
	-o jsonpath='{range .items[*]}{.metadata.name}{"="}{.status.phase}{"\n"}{end}')
[[ $(printf '%s\n' "$pvc_phases" | sed '/^$/d' | wc -l | tr -d ' ') -ge 2 ]]
if printf '%s\n' "$pvc_phases" | grep -v '=Bound$' | grep -q .; then
	echo "observability PVC is not Bound:" >&2
	printf '%s\n' "$pvc_phases" >&2
	exit 1
fi

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
	service/actor-observability-prometheus 19090:9090 >"$temporary/forward.log" 2>&1 &
forward_pid=$!
prometheus_ready=false
for _ in $(seq 1 30); do
	if curl --fail --silent http://127.0.0.1:19090/-/ready >/dev/null; then
		prometheus_ready=true
		break
	fi
	sleep 1
done
[[ $prometheus_ready == true ]] || {
	echo "Prometheus port-forward never became ready" >&2
	cat "$temporary/forward.log" >&2
	exit 1
}
query_scalar() {
	local expression=$1
	local response
	response=$(curl --fail --silent --get http://127.0.0.1:19090/api/v1/query \
		--data-urlencode "query=$expression")
	printf '%s' "$response" | python3 -c \
		'import json,sys; r=json.load(sys.stdin)["data"]["result"]; print(float(r[0]["value"][1]) if r else 0)'
}

engine_expected='label_replace(kube_deployment_spec_replicas{namespace="actor-fdb-cell-system",deployment=~".+-engine"}, "cell", "$1", "deployment", "(.+)-engine")'
engine_healthy='count by (namespace, cell) (up{namespace="actor-fdb-cell-system",service="actor-fleet-engine-metrics"} == 1) >= on (namespace, cell) label_replace(kube_deployment_spec_replicas{namespace="actor-fdb-cell-system",deployment=~".+-engine"}, "cell", "$1", "deployment", "(.+)-engine")'
engine_expected_cells=0
engine_deficient_cells=1
for _ in $(seq 1 60); do
	engine_expected_cells=$(query_scalar "count($engine_expected)")
	engine_deficient_cells=$(query_scalar "count($engine_expected unless on (namespace, cell) ($engine_healthy))")
	python3 - "$engine_expected_cells" "$engine_deficient_cells" <<'PY' && break
import sys
raise SystemExit(0 if float(sys.argv[1]) >= 1 and float(sys.argv[2]) == 0 else 1)
PY
	sleep 5
done
python3 - "$engine_expected_cells" "$engine_deficient_cells" <<'PY'
import sys
if float(sys.argv[1]) < 1 or float(sys.argv[2]) != 0:
    raise SystemExit(f"Engine metrics incomplete: expected_cells={sys.argv[1]} deficient_cells={sys.argv[2]}")
PY

required_series=(
	'actor_foundationdb_cluster_available{namespace="actor-fdb-cell-system"}'
	'actor_foundationdb_cluster_full_replication{namespace="actor-fdb-cell-system"}'
	'actor_fdb_backup_collection_success{namespace="actor-fdb-cell-system"}'
	'actor_fdb_backup_container_restorable{namespace="actor-fdb-cell-system"}'
	'actor_fdb_backup_lag_seconds'
	'actor_fdb_storage_total_kv_size_bytes'
	'actor_fdb_storage_least_operating_space_bytes'
	'actor_fdb_data_movement_in_flight_bytes'
	'actor_fdb_data_movement_in_queue_bytes'
	'actor_fdb_released_transactions_per_second'
	'actor_fdb_transactions_per_second_limit'
	'rivet_sqlite_write_debt_backpressure_total'
	'rivet_sqlite_cold_tier_requests_queued'
	'rivet_sqlite_compaction_backlog_objects'
	'rivet_sqlite_compaction_backlog_bytes'
	'rivet_sqlite_compaction_jobs_total'
	'rivet_sqlite_compaction_objects_total'
	'rivet_sqlite_compaction_bytes_total'
	'rivet_sqlite_compaction_duration_seconds_count'
	'rivet_sqlite_compaction_phase_duration_seconds_count'
)
for series in "${required_series[@]}"; do
	value=$(query_scalar "count($series)")
	python3 - "$value" "$series" <<'PY'
import sys
if float(sys.argv[1]) < 1:
    raise SystemExit(f"required Prometheus series is absent: {sys.argv[2]}")
PY
done

workerd_expected='label_replace(kube_statefulset_replicas{namespace="actor-fdb-cell-system",statefulset=~".+-runtime-hosts"}, "cell", "$1", "statefulset", "(.+)-runtime-hosts")'
workerd_healthy='count by (namespace, cell) (up{namespace="actor-fdb-cell-system",service=~".+-runtime-hosts"} == 1) >= on (namespace, cell) label_replace(kube_statefulset_replicas{namespace="actor-fdb-cell-system",statefulset=~".+-runtime-hosts"}, "cell", "$1", "statefulset", "(.+)-runtime-hosts")'
workerd_expected_cells=0
workerd_deficient_cells=1
# ServiceMonitor discovery and its first scrape are asynchronous. Use the
# same bounded convergence window as Engine targets, without relaxing the
# final per-Cell replica check or treating missing series as healthy.
for _ in $(seq 1 60); do
 workerd_expected_cells=$(query_scalar "count($workerd_expected)")
 workerd_deficient_cells=$(query_scalar "count($workerd_expected unless on (namespace, cell) ($workerd_healthy))")
 python3 - "$workerd_expected_cells" "$workerd_deficient_cells" <<'PY' && break
import sys
raise SystemExit(0 if float(sys.argv[1]) >= 1 and float(sys.argv[2]) == 0 else 1)
PY
 sleep 5
done
python3 - "$workerd_expected_cells" "$workerd_deficient_cells" <<'PY'
import sys
if float(sys.argv[1]) < 1 or float(sys.argv[2]) != 0:
    raise SystemExit(f"workerd metrics incomplete: expected_cells={sys.argv[1]} deficient_cells={sys.argv[2]}")
PY

stateless_expected='label_replace(kube_deployment_spec_replicas{namespace="actor-stateless-system",deployment=~".+-stateless-executor"}, "cell", "$1", "deployment", "(.+)-stateless-executor")'
stateless_healthy='count by (namespace, cell) (up{namespace="actor-stateless-system",service=~".+-stateless-executor"} == 1) == on (namespace, cell) label_replace(kube_deployment_spec_replicas{namespace="actor-stateless-system",deployment=~".+-stateless-executor"}, "cell", "$1", "deployment", "(.+)-stateless-executor")'
stateless_expected_cells=0
stateless_deficient_cells=1
for _ in $(seq 1 60); do
	stateless_expected_cells=$(query_scalar "count($stateless_expected)")
	stateless_deficient_cells=$(query_scalar "count($stateless_expected unless on (namespace, cell) ($stateless_healthy))")
	python3 - "$stateless_expected_cells" "$stateless_deficient_cells" <<'PY' && break
import sys
raise SystemExit(0 if float(sys.argv[1]) >= 1 and float(sys.argv[2]) == 0 else 1)
PY
	sleep 5
done
python3 - "$stateless_expected_cells" "$stateless_deficient_cells" <<'PY'
import sys
if float(sys.argv[1]) < 1 or float(sys.argv[2]) != 0:
    raise SystemExit(f"stateless metrics incomplete: expected_cells={sys.argv[1]} deficient_cells={sys.argv[2]}")
PY
for series in rivet_stateless_in_flight rivet_stateless_queued; do
	value=$(query_scalar "count($series{namespace=\"actor-stateless-system\",cell!=\"\",pod!=\"\"})")
	python3 - "$value" "$series" <<'PY'
import sys
if float(sys.argv[1]) < 1:
    raise SystemExit(f"required stateless Prometheus series is absent: {sys.argv[2]}")
PY
done

rules_response="$temporary/rules.json"
for _ in $(seq 1 18); do
	curl --fail --silent http://127.0.0.1:19090/api/v1/rules >"$rules_response"
	if python3 - "$rules_response" <<'PY'
import json, sys
groups = [g for g in json.load(open(sys.argv[1]))["data"]["groups"] if g["name"].startswith("actor-fleet-")]
rules = [r for g in groups for r in g.get("rules", [])]
names = {r["name"] for r in rules}
sentinels = {"actor:fdb_storage_headroom_samples:6h", "actor:container_rss_samples:6h"}
raise SystemExit(0 if sentinels <= names and all(r.get("health") == "ok" for r in rules) else 1)
PY
	then
		break
	fi
	sleep 5
done
python3 - "$rules_response" <<'PY'
import json, sys
expected = {
    "ActorFDBUnavailable", "ActorFDBNotFullyReplicated", "ActorFDBBackupNotRestorable",
    "ActorFDBBackupLagHigh", "ActorFDBBackupLagCritical", "ActorCompactionBacklogStalled",
    "ActorPublishReclaimFailureRateHigh", "ActorPublishReclaimP95Slow",
    "ActorFDBWriteDebtBackpressure", "ActorWorkerdRequestRejected",
    "ActorWorkerdRequestTimedOut", "ActorEngineReplicaShortfall",
    "ActorRuntimeReplicaShortfall", "ActorEngineZoneSkew", "ActorRuntimeZoneSkew",
    "ActorContainerMemoryHigh", "ActorContainerOOM", "ActorContainerRestarted",
    "ActorCompactionBacklogDrainExceeds72Hours", "ActorFDBStorageCapacityWithin72Hours",
    "ActorFDBStorageCapacityWithin24Hours", "ActorFDBStorageOperatingReserveLow",
    "ActorContainerMemoryCapacityWithin72Hours", "ActorRuntimeQueueCapacityHigh",
}
expected_records = {
    "actor:compaction_backlog_drain_eta_seconds",
    "actor:compaction_bytes_per_second:15m",
    "actor:fdb_write_debt_proxy_growth_bytes_per_second:6h",
    "actor:fdb_total_kv_size_bytes:max", "actor:fdb_least_operating_space_bytes:min",
    "actor:fdb_storage_headroom_bytes", "actor:fdb_storage_headroom_eta_seconds",
    "actor:fdb_data_movement_bytes", "actor:fdb_write_utilization:ratio",
    "actor:runtime_queue_utilization:ratio",
    "actor:container_rss_growth_bytes_per_second:6h", "actor:container_memory_utilization:ratio",
    "actor:fdb_storage_headroom_samples:6h", "actor:container_rss_samples:6h",
    "actor:container_memory_headroom_eta_seconds",
}
document = json.load(open(sys.argv[1]))
groups = [g for g in document["data"]["groups"] if g["name"].startswith("actor-fleet-")]
unhealthy = [g["name"] for g in groups if g.get("health") not in (None, "ok")]
unhealthy_rules = [
    f'{g["name"]}/{r["name"]}: {r.get("lastError", "unknown error")}'
    for g in groups for r in g.get("rules", []) if r.get("health") not in (None, "ok")
]
loaded = {r["name"] for g in groups for r in g.get("rules", [])}
missing = sorted(expected - loaded)
missing_records = sorted(expected_records - loaded)
if unhealthy or unhealthy_rules or missing or missing_records:
    raise SystemExit(f"rules failed validation: unhealthy_groups={unhealthy} unhealthy_rules={unhealthy_rules} missing_alerts={missing} missing_records={missing_records}")
print(f"actor rules verified: loaded={len(loaded)}")
PY
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get daemonset -o name | grep -q node-exporter; then
	echo "node-exporter must remain disabled" >&2
	exit 1
fi
echo "actor observability verified: engine_cells=$engine_expected_cells workerd_cells=$workerd_expected_cells stateless_cells=$stateless_expected_cells deficient_cells=0"
