#!/usr/bin/env bash
#
# Controlled primary-Cell AZ fault qualification. This uses a temporary
# NoExecute taint on every dedicated FDB node in one Kubernetes zone. It is a
# synthetic node-unavailability test: the FDB processes are evicted by the
# node taint manager rather than deleted directly, so the FDB PDB is not
# bypassed. The fault is removed by trap on every exit path.
set -euo pipefail

namespace=${ACTOR_NAMESPACE:-actor-fdb-cell-system}
: "${ACTOR_CELL_NAME:?ACTOR_CELL_NAME must name the exact Cell}"
cluster=$ACTOR_CELL_NAME
fault_zone=${AZ_LOSS_ZONE:?AZ_LOSS_ZONE is required (a Kubernetes topology.kubernetes.io/zone value)}
execute=${AZ_LOSS_EXECUTE:-false}
primary_authorized=${AZ_LOSS_ALLOW_PRIMARY:-false}
hold_seconds=${AZ_LOSS_HOLD_SECONDS:-90}
fault_timeout_seconds=${AZ_LOSS_FAULT_TIMEOUT_SECONDS:-300}
recovery_timeout_seconds=${AZ_LOSS_RECOVERY_TIMEOUT_SECONDS:-1800}
client_timeout_seconds=${AZ_LOSS_CLIENT_TIMEOUT_SECONDS:-8}
max_write_failures=${AZ_LOSS_MAX_WRITE_FAILURES:-0}
receipt=${AZ_LOSS_RECEIPT:?AZ_LOSS_RECEIPT is required}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../operations" && pwd)

[[ $execute == true && $primary_authorized == true ]] || {
	echo "refusing primary AZ fault: set AZ_LOSS_EXECUTE=true and AZ_LOSS_ALLOW_PRIMARY=true" >&2
	exit 2
}
[[ $cluster =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "ACTOR_CELL_NAME must be a DNS-safe Cell identity" >&2
	exit 2
}
[[ $hold_seconds =~ ^[1-9][0-9]*$ && $fault_timeout_seconds =~ ^[1-9][0-9]*$ && $recovery_timeout_seconds =~ ^[1-9][0-9]*$ && $client_timeout_seconds =~ ^[1-9][0-9]*$ && $max_write_failures =~ ^[0-9]+$ ]] || {
	echo "AZ loss timeouts and AZ_LOSS_MAX_WRITE_FAILURES must be positive integers (failures may be zero)" >&2
	exit 2
}

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="dr.primary-az-loss" \
	AUTONOMY_CONTROL_CELL="$cluster" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
	"$operations_dir/assert-autonomy-control.sh"
fi

health() {
	local available full generation reconciled
	available=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.status.health.available}')
	full=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.status.health.fullReplication}')
	generation=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.metadata.generation}')
	reconciled=$(kubectl -n "$namespace" get foundationdbcluster "$cluster" -o jsonpath='{.status.generations.reconciled}')
	printf '%s\t%s\t%s\t%s\n' "$available" "$full" "$generation" "$reconciled"
}

storage_rows() {
	local pod node zone ready statuses status
	while IFS= read -r pod; do
		node=$(kubectl -n "$namespace" get pod "$pod" -o jsonpath='{.spec.nodeName}')
		if [[ -n $node ]]; then
			zone=$(kubectl get node "$node" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}')
		else
			zone=unassigned
		fi
		ready=true
		statuses=$(kubectl -n "$namespace" get pod "$pod" -o jsonpath='{range .status.containerStatuses[*]}{.ready}{" "}{end}')
		[[ -n $statuses ]] || ready=false
		for status in $statuses; do
			[[ $status == true ]] || ready=false
		done
		printf '%s\t%s\t%s\t%s\n' "$pod" "$node" "$zone" "$ready"
	done < <(kubectl -n "$namespace" get pods -l "foundationdb.org/fdb-cluster-name=$cluster,foundationdb.org/fdb-process-class=storage" -o jsonpath='{range .items[*]}{.metadata.name}{"\n"}{end}')
}

storage_gate() {
	local rows count zones ready_count
	rows=$(storage_rows)
	count=$(awk 'NF { count++ } END { print count + 0 }' <<<"$rows")
	zones=$(awk -F '\t' 'NF { seen[$3] = 1 } END { print length(seen) }' <<<"$rows")
	ready_count=$(awk -F '\t' '$4 == "true" { count++ } END { print count + 0 }' <<<"$rows")
	[[ $count == 9 && $zones == 3 && $ready_count == 9 ]]
}

selected_zone_pods=()
selected_zone_ready_count() {
	local pod statuses status ready count
	count=0
	for pod in "${selected_zone_pods[@]}"; do
		if ! statuses=$(kubectl -n "$namespace" get pod "$pod" -o jsonpath='{range .status.containerStatuses[*]}{.ready}{" "}{end}' 2>/dev/null); then
			continue
		fi
		ready=true
		[[ -n $statuses ]] || ready=false
		for status in $statuses; do
			[[ $status == true ]] || ready=false
		done
		[[ $ready == true ]] && count=$((count + 1))
	done
	printf '%s\n' "$count"
}

backup_url=$(kubectl -n "$namespace" get foundationdbbackup "${cluster}-continuous" -o jsonpath='{.status.backupDetails.url}')
backup_pod=$(kubectl -n "$namespace" get pods \
	-l "foundationdb.org/deployment-name=${cluster}-continuous-backup-agents" \
	-o jsonpath='{.items[0].metadata.name}')
backup_restorable=false
if [[ $backup_url == blobstore://* && -n $backup_pod ]]; then
	backup_description=$(kubectl -n "$namespace" exec "$backup_pod" -c foundationdb -- \
		timeout 45 fdbbackup describe -d "$backup_url")
	if grep -q '^Restorable: true$' <<<"$backup_description"; then
		backup_restorable=true
	fi
fi
mapfile -t baseline_health < <(health | tr '\t' '\n')
[[ $backup_restorable == true && ${baseline_health[0]} == true && ${baseline_health[1]} == true && ${baseline_health[2]} == "${baseline_health[3]}" ]] || {
	echo "primary preflight failed: available=${baseline_health[0]} full=${baseline_health[1]} generation=${baseline_health[2]}/${baseline_health[3]} backup_restorable=$backup_restorable" >&2
	exit 1
}
storage_gate || {
	echo "primary preflight requires exactly nine Ready storage Pods in three zones" >&2
	storage_rows >&2
	exit 1
}
mapfile -t selected_zone_pods < <(storage_rows | awk -F '\t' -v zone="$fault_zone" '$3 == zone { print $1 }')
[[ ${#selected_zone_pods[@]} == 3 ]] || {
	echo "selected zone does not hold exactly three primary storage Pods: zone=$fault_zone" >&2
	storage_rows >&2
	exit 1
}

mapfile -t fault_nodes < <(kubectl get nodes -l 'fleet.actor.dev/fdb-dedicated=true' \
	-o jsonpath='{range .items[*]}{.metadata.name}{"\t"}{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}{end}' | \
	awk -F '\t' -v zone="$fault_zone" '$2 == zone { print $1 }')
((${#fault_nodes[@]} > 0)) || {
	echo "no dedicated FDB nodes found in selected zone: $fault_zone" >&2
	exit 1
}
for node in "${fault_nodes[@]}"; do
	taints=$(kubectl get node "$node" -o jsonpath='{range .spec.taints[*]}{.key}{"="}{.value}{":"}{.effect}{"\n"}{end}')
	if grep -q '^actor-fleet.io/az-loss=' <<<"$taints"; then
		echo "refusing stale AZ fault taint on $node" >&2
		exit 1
	fi
done

survivor_zone=$(storage_rows | awk -F '\t' -v zone="$fault_zone" '
	$3 != zone && $4 == "true" && !found { found = $3 }
	END { print found }
')
[[ -n $survivor_zone ]] || {
	echo "no healthy FDB client zone outside selected zone" >&2
	exit 1
}

temporary=$(mktemp -d)
probe_log="$temporary/probe.tsv"
health_log="$temporary/health.tsv"
run_id="azloss-$(date -u +%Y%m%d%H%M%S)-$RANDOM"
key_prefix="actor-fleet-az-drill/${run_id}/"
fault_active=false
client_job="${cluster}-az-client-${run_id}"
client_pod=

remove_fault() {
	[[ $fault_active == true ]] || return 0
	local node
	for node in "${fault_nodes[@]}"; do
		kubectl taint node "$node" actor-fleet.io/az-loss:NoExecute- >&2 || true
	done
	fault_active=false
}

capture_probe_logs() {
	[[ -n $client_pod ]] || return 0
	kubectl -n "$namespace" logs "$client_pod" >"$probe_log" 2>/dev/null || true
}

stop_client() {
	capture_probe_logs
	[[ -n $client_job ]] || return 0
	kubectl -n "$namespace" delete job "$client_job" --ignore-not-found --wait=true >&2 || true
	client_job=
}

cleanup() {
	remove_fault
	stop_client
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

create_client() {
	kubectl -n "$namespace" apply -f - <<YAML
apiVersion: batch/v1
kind: Job
metadata:
  name: ${client_job}
  labels:
    fleet.actor.dev/purpose: fdb-az-loss-qualification
spec:
  backoffLimit: 0
  template:
    metadata:
      labels:
        fleet.actor.dev/purpose: fdb-az-loss-qualification
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      securityContext:
        runAsNonRoot: true
        runAsUser: 4059
        runAsGroup: 4059
        fsGroup: 4059
        seccompProfile:
          type: RuntimeDefault
      affinity:
        nodeAffinity:
          requiredDuringSchedulingIgnoredDuringExecution:
            nodeSelectorTerms:
              - matchExpressions:
                  - key: topology.kubernetes.io/zone
                    operator: In
                    values: ["${survivor_zone}"]
      containers:
        - name: fdb-client
          image: foundationdb/fdb-kubernetes-monitor:7.3.79@sha256:45f5b7632984a4835326f45a7bcfd662886db64d82333796ee14cbb3a7537c8c
          command: ["bash", "-euo", "pipefail", "-c"]
          args:
            - |
              sequence=0
              while true; do
                sequence=\$((sequence + 1))
                started=\$(date -u +%s%3N)
                value="${run_id}-\${sequence}"
                set +e
                output=\$(timeout ${client_timeout_seconds} fdbcli -C /var/dynamic-conf/fdb.cluster --exec "writemode on; set ${key_prefix}\${sequence} \${value}; get ${key_prefix}\${sequence}" 2>&1)
                rc=\$?
                set -e
                finished=\$(date -u +%s%3N)
                latency=\$((finished - started))
                status=success
                if [[ \$rc != 0 || \$output != *"\$value"* ]]; then
                  status=failure
                fi
                reason=\$(printf '%s' "\$output" | tr '\n\t' ' ' | cut -c1-240)
                printf '%s\t%s\t%s\t%s\t%s\n' "\$started" "\$finished" "\$latency" "\$status" "\$reason"
                sleep 1
              done
          env:
            - name: FDB_TLS_CERTIFICATE_FILE
              value: /var/fdb-tls/cert.pem
            - name: FDB_TLS_CA_FILE
              value: /var/fdb-tls/ca.pem
            - name: FDB_TLS_KEY_FILE
              value: /var/fdb-tls/key.pem
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          volumeMounts:
            - name: config-map
              mountPath: /var/dynamic-conf
              readOnly: true
            - name: fdb-tls
              mountPath: /var/fdb-tls
              readOnly: true
            - name: tmp
              mountPath: /tmp
      volumes:
        - name: config-map
          configMap:
            name: ${cluster}-config
            items:
              - key: cluster-file
                path: fdb.cluster
        - name: fdb-tls
          secret:
            secretName: ${cluster}-fdb-tls
            defaultMode: 0440
        - name: tmp
          emptyDir: {}
YAML
	local deadline phase
	deadline=$((SECONDS + 120))
	while ((SECONDS < deadline)); do
		# A just-created Job commonly has no Pod during its first list call.
		# Kubernetes returns a non-zero jsonpath status for items[0] on an
		# empty list, which must be treated as "keep waiting", not as a drill
		# failure before the fault is even injected.
		client_pod=$(kubectl -n "$namespace" get pods -l "job-name=$client_job" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
		if [[ -n $client_pod ]]; then
			phase=$(kubectl -n "$namespace" get pod "$client_pod" -o jsonpath='{.status.phase}')
			[[ $phase == Running ]] && return 0
			if [[ $phase == Failed || $phase == Succeeded ]]; then
				kubectl -n "$namespace" logs "$client_pod" >&2 || true
				return 1
			fi
		fi
		sleep 2
	done
	echo "long-lived FDB client Job did not reach Running" >&2
	return 1
}

probe_successes() {
	capture_probe_logs
	[[ -f $probe_log ]] || return 1
	awk -F '\t' '$4 == "success" { success++ } END { exit !(success >= 3) }' "$probe_log"
}

sample_health() {
	local now selected available full generation reconciled
	now=$(date -u +%s%3N)
	selected=$(selected_zone_ready_count)
	IFS=$'\t' read -r available full generation reconciled <<<"$(health)"
	printf '%s\t%s\t%s\t%s\t%s\n' "$now" "$selected" "$available" "$full" "$generation/$reconciled" >>"$health_log"
}

create_client
baseline_deadline=$((SECONDS + 60))
while ((SECONDS < baseline_deadline)); do
	if probe_successes; then
		break
	fi
	sleep 1
done
probe_successes || {
	echo "continuous FDB write probe did not establish three baseline successes" >&2
	cat "$probe_log" >&2 || true
	exit 1
}

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
started_unix_ms=$(date -u +%s%3N)
for node in "${fault_nodes[@]}"; do
	kubectl taint node "$node" actor-fleet.io/az-loss="$run_id":NoExecute >&2
done
fault_active=true

fault_observed=false
fault_deadline=$((SECONDS + fault_timeout_seconds))
while ((SECONDS < fault_deadline)); do
	sample_health
	if [[ $(selected_zone_ready_count) == 0 ]]; then
		fault_observed=true
		fault_observed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
		break
	fi
	sleep 2
done
[[ $fault_observed == true ]] || {
	echo "all three selected-zone primary storage Pods did not become unready within ${fault_timeout_seconds}s" >&2
	storage_rows >&2
	exit 1
}

hold_deadline=$((SECONDS + hold_seconds))
while ((SECONDS < hold_deadline)); do
	sample_health
	sleep 2
done

recovery_started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
recovery_started_unix_ms=$(date -u +%s%3N)
remove_fault

recovered=false
recovery_deadline=$((SECONDS + recovery_timeout_seconds))
while ((SECONDS < recovery_deadline)); do
	sample_health
	mapfile -t current_health < <(health | tr '\t' '\n')
	if [[ ${current_health[0]} == true && ${current_health[1]} == true && ${current_health[2]} == "${current_health[3]}" ]] && storage_gate; then
		recovered=true
		break
	fi
	sleep 10
done
[[ $recovered == true ]] || {
	echo "primary FDB did not return to 3/3/3 full replication within ${recovery_timeout_seconds}s" >&2
	health >&2
	storage_rows >&2
	exit 1
}

completed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
completed_unix_ms=$(date -u +%s%3N)
recovery_rto_ms=$((completed_unix_ms - recovery_started_unix_ms))

# The fault keys are deliberately isolated under one generated user-keyspace
# prefix and are removed only after the post-fault health gate is met.
timeout "$client_timeout_seconds" kubectl -n "$namespace" exec "$client_pod" -c fdb-client -- \
	fdbcli -C /var/dynamic-conf/fdb.cluster --exec "writemode on; clearrange ${key_prefix} ${key_prefix}0" >/dev/null
stop_client

DRILL_PROBE_LOG=$probe_log \
DRILL_HEALTH_LOG=$health_log \
DRILL_CLUSTER=$cluster \
DRILL_NAMESPACE=$namespace \
DRILL_ZONE=$fault_zone \
DRILL_STARTED_AT=$started_at \
DRILL_FAULT_OBSERVED_AT=$fault_observed_at \
DRILL_RECOVERY_STARTED_AT=$recovery_started_at \
DRILL_COMPLETED_AT=$completed_at \
DRILL_RECOVERY_RTO_MS=$recovery_rto_ms \
DRILL_RUN_ID=$run_id \
DRILL_MAX_WRITE_FAILURES=$max_write_failures \
DRILL_FAULT_NODES="$(printf '%s\n' "${fault_nodes[@]}")" \
python3 - "$receipt" <<'PY'
import json
import os
import sys

probe = []
for line in open(os.environ["DRILL_PROBE_LOG"]):
    started, finished, latency, status, reason = line.rstrip("\n").split("\t", 4)
    probe.append({"started_unix_ms": int(started), "finished_unix_ms": int(finished), "latency_ms": int(latency), "status": status, "reason": reason})
success = [entry for entry in probe if entry["status"] == "success"]
failures = len(probe) - len(success)
gaps = [right["finished_unix_ms"] - left["finished_unix_ms"] for left, right in zip(success, success[1:])]
health = []
for line in open(os.environ["DRILL_HEALTH_LOG"]):
    timestamp, selected_ready, available, full, generation = line.rstrip("\n").split("\t")
    health.append({"unix_ms": int(timestamp), "selected_zone_ready_storage": int(selected_ready), "available": available == "true", "full_replication": full == "true", "generation": generation})
limit = int(os.environ["DRILL_MAX_WRITE_FAILURES"])
verdict = "passed" if failures <= limit else "failed"
receipt = {
    "schema": "actor-fdb-primary-az-loss-v1",
    "verdict": verdict,
    "cluster": os.environ["DRILL_CLUSTER"],
    "namespace": os.environ["DRILL_NAMESPACE"],
    "selected_kubernetes_zone": os.environ["DRILL_ZONE"],
    "fault_model": "temporary NoExecute taint on every dedicated FDB node in the selected zone",
    "limitation": "Synthetic node unavailability; it is not a cloud AZ power or network outage.",
    "fault_nodes": os.environ["DRILL_FAULT_NODES"].splitlines(),
    "run_id": os.environ["DRILL_RUN_ID"],
    "started_at": os.environ["DRILL_STARTED_AT"],
    "fault_observed_at": os.environ["DRILL_FAULT_OBSERVED_AT"],
    "recovery_started_at": os.environ["DRILL_RECOVERY_STARTED_AT"],
    "completed_at": os.environ["DRILL_COMPLETED_AT"],
    "recovery_rto_ms": int(os.environ["DRILL_RECOVERY_RTO_MS"]),
    "probe": {
        "attempts": len(probe),
        "successes": len(success),
        "failures": failures,
        "max_allowed_failures": limit,
        "max_latency_ms": max((entry["latency_ms"] for entry in probe), default=0),
        "max_success_gap_ms": max(gaps, default=0),
    },
    "health_samples": health,
}
with open(sys.argv[1], "w") as output:
    json.dump(receipt, output, indent=2, sort_keys=True)
    output.write("\n")
if verdict != "passed":
    raise SystemExit("write failure threshold exceeded: {}/{}".format(failures, limit))
PY
sha256sum "$receipt"
echo "primary_az_loss=passed cluster=$cluster zone=$fault_zone recovery_rto_ms=$recovery_rto_ms"
