#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell_name=$RIVET_CELL_NAME
qualifier=${QUALIFIER:-$script_dir/../../qualify_workerd_density.py}
receipt=${QUALIFICATION_RECEIPT:-$script_dir/runtime-actor-smoke.json}
qualification_profile=${QUALIFICATION_PROFILE:-production}
public_worker=${QUALIFICATION_PUBLIC_WORKER:-${cell_name##*-}-bottomless-qualification}
[[ $public_worker =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "QUALIFICATION_PUBLIC_WORKER must be a DNS label" >&2
	exit 2
}
operations_dir=$(CDPATH= cd -- "$script_dir/../operations" && pwd)
case "$qualification_profile" in
production)
	default_actors=96
	default_concurrency=96
	default_increments=130
	default_increment_round_delay_ms=650
	default_request_timeout=40
	default_cold_state_timeout=3600
	default_cold_state_poll=2
	default_bottomless_bytes=12582912
	default_quiescence_timeout=120
	default_min_recovery_queued_hosts=3
	;;
production-cell)
	# Keep the three-host base cell at its configured 16 Actors/host target.
	# Autoscaling qualification is a separate receipt; this profile proves the
	# persistent data path while binding the exact base release and Pod set.
	default_actors=48
	# Two simultaneous idempotent reads per sleeping Actor deterministically
	# exercise the per-Host recovery queue without increasing persistent Actor
	# density beyond the configured 16 Actors/Host target.
	default_concurrency=96
	default_wake_requests_per_actor=2
	default_increments=130
	default_increment_round_delay_ms=650
	default_request_timeout=40
	default_cold_state_timeout=3600
	default_cold_state_poll=2
	default_bottomless_bytes=12582912
	default_quiescence_timeout=120
	default_min_recovery_queued_hosts=0
	;;
e2e-fast)
	default_actors=18
	default_concurrency=18
	default_increments=16
	default_increment_round_delay_ms=0
	default_request_timeout=20
	default_cold_state_timeout=300
	default_cold_state_poll=0.5
	default_bottomless_bytes=3145728
	default_quiescence_timeout=60
	default_min_recovery_queued_hosts=0
	;;
*)
	echo "QUALIFICATION_PROFILE must be production, production-cell, or e2e-fast" >&2
	exit 2
	;;
esac
default_wake_requests_per_actor=${default_wake_requests_per_actor:-1}
kubeconfig_args=()
if [[ -n ${KUBECONFIG:-} ]]; then
	kubeconfig_args=(--kubeconfig "$KUBECONFIG")
fi

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="runtime.qualify" \
	AUTONOMY_CONTROL_CELL="$cell_name" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
	"$operations_dir/assert-autonomy-control.sh"
fi

if [[ $qualification_profile == production || $qualification_profile == production-cell ]]; then
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-host-drain" -o json \
		| python3 "$script_dir/host-drain-profile.py" check production
fi

if [[ ${RUNTIME_SCALE_IN_HOLD_HELD:-0} != 1 ]]; then
	exec "$script_dir/with-runtime-scale-in-hold.sh" "$0" "$@"
fi

for artifact in "$qualifier" "$script_dir/capture_release_binding.py" "$script_dir/verify_bottomless_receipt.py"; do
	[[ -f "$artifact" ]] || {
		echo "runtime qualification artifact is missing: $artifact" >&2
		exit 2
	}
done
python3 -m py_compile "$qualifier" "$script_dir/capture_release_binding.py" "$script_dir/verify_bottomless_receipt.py"

mkdir -p /data/tmp
temporary=$(mktemp -d /data/tmp/q01-runtime-qualification.XXXXXX)
forward_pids=()
port_forward_supervisor() {
	local log=$1
	shift
	local child= status attempt=0 stopping=false
	stop_port_forward() {
		stopping=true
		if [[ -n ${child:-} ]]; then
			kill "$child" 2>/dev/null || true
			wait "$child" 2>/dev/null || true
			child=
		fi
	}
	trap stop_port_forward TERM INT
	while [[ $stopping == false ]]; do
		attempt=$((attempt + 1))
		printf 'port-forward supervisor attempt=%s started_at=%s command=' \
			"$attempt" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$log"
		printf '%q ' kubectl "${kubeconfig_args[@]}" -n "$namespace" port-forward "$@" >>"$log"
		printf '\n' >>"$log"
		kubectl "${kubeconfig_args[@]}" -n "$namespace" port-forward "$@" >>"$log" 2>&1 &
		child=$!
		if wait "$child"; then status=0; else status=$?; fi
		child=
		[[ $stopping == true ]] && break
		printf 'port-forward supervisor restart=%s exit=%s at=%s\n' \
			"$attempt" "$status" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" >>"$log"
		sleep 1
	done
}
start_port_forward() {
	local log=$1
	shift
	port_forward_supervisor "$log" "$@" &
	forward_pids+=("$!")
}
runtime_replicas=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get \
	statefulset "${cell_name}-runtime-hosts" -o jsonpath='{.spec.replicas}')
[[ $runtime_replicas =~ ^[0-9]+$ ]] && ((runtime_replicas >= 3 && runtime_replicas <= 64)) || {
	echo "runtime Host replica count is outside the qualification bound: $runtime_replicas" >&2
	exit 1
}
read -r -a allocated_ports < <(
	python3 - "$((runtime_replicas + 3))" <<'PY'
import socket, sys
sockets = [socket.socket() for _ in range(int(sys.argv[1]))]
for item in sockets:
    item.bind(("127.0.0.1", 0))
print(*[item.getsockname()[1] for item in sockets])
PY
)
[[ ${#allocated_ports[@]} -eq $((runtime_replicas + 3)) ]]
engine_api_port=${allocated_ports[0]}
engine_admin_port=${allocated_ports[1]}
workers_api_port=${allocated_ports[2]}
host_ports=("${allocated_ports[@]:3}")
cleanup() {
	if ((${#forward_pids[@]})); then
		kill "${forward_pids[@]}" 2>/dev/null || true
		wait "${forward_pids[@]}" 2>/dev/null || true
	fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

deployed_profile=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get \
	configmap "${cell_name}-runtime-config" \
	-o jsonpath='{.metadata.annotations.fleet\.actor\.dev/runtime-profile}' 2>/dev/null || true)
deployed_profile=${deployed_profile:-production}
expected_deployed_profile=$qualification_profile
if [[ $qualification_profile == production-cell ]]; then
	expected_deployed_profile=production
fi
if [[ $deployed_profile != "$expected_deployed_profile" ]]; then
	echo "qualification profile $qualification_profile does not match deployed runtime profile $deployed_profile" >&2
	exit 2
fi

capture_release_binding() {
	local prefix=$1
	local dynamic_args=()
	if [[ $qualification_profile == production-cell ]]; then
		dynamic_args+=(--dynamic-runtime-capacity)
	fi
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get \
		deployment/"${cell_name}-engine" -o json >"${prefix}-deployment.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get \
		statefulset/"${cell_name}-runtime-hosts" -o json >"${prefix}-statefulset.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
		-l "fleet.actor.dev/cell-name=${cell_name}" -o json >"${prefix}-pods.json"
	python3 "$script_dir/capture_release_binding.py" \
		--deployment "${prefix}-deployment.json" \
		--statefulset "${prefix}-statefulset.json" \
		--pods "${prefix}-pods.json" "${dynamic_args[@]}" >"${prefix}-binding.json"
}

capture_release_binding "$temporary/release-before"

kubectl "${kubeconfig_args[@]}" -n "$namespace" get secret "${cell_name}-runtime-auth" \
	-o jsonpath='{.data.token}' | base64 --decode >"$temporary/token"
[[ $(wc -c <"$temporary/token") -eq 64 ]] && grep -Eq '^[0-9a-f]{64}$' "$temporary/token"
ACTOR_RUNTIME_TOKEN=$(<"$temporary/token")

start_port_forward "$temporary/engine-forward.log" \
	service/"${cell_name}-engine" "${engine_api_port}:6420" "${engine_admin_port}:6421"
start_port_forward "$temporary/workers-api-forward.log" \
	service/"${cell_name}-workers-api" "${workers_api_port}:8080"
for ((ordinal = 0; ordinal < runtime_replicas; ordinal++)); do
	port=${host_ports[$ordinal]}
	start_port_forward "$temporary/host-${ordinal}-forward.log" \
		pod/"${cell_name}-runtime-hosts-${ordinal}" "${port}:18081"
done

ready=false
all_host_forwards_ready() {
	local port
	for port in "${host_ports[@]}"; do
		curl --fail --silent --header "x-rivet-workerd-token: $ACTOR_RUNTIME_TOKEN" \
			"http://127.0.0.1:${port}/v1/sqlite/stats" >/dev/null || return 1
	done
}
for _ in $(seq 1 60); do
	if curl --fail --silent "http://127.0.0.1:${engine_admin_port}/health" >/dev/null && \
		curl --fail --silent "http://127.0.0.1:${workers_api_port}/readyz" >/dev/null && \
		all_host_forwards_ready; then
		ready=true
		break
	fi
	sleep 1
done
if [[ $ready != true ]]; then
	echo "runtime port-forwards did not become ready" >&2
	for log in "$temporary"/*-forward.log; do
		echo "--- $(basename "$log")" >&2
		sed -n '1,120p' "$log" >&2
	done
	exit 1
fi

export ACTOR_RUNTIME_TOKEN
host_stats_args=()
for ((ordinal = 0; ordinal < runtime_replicas; ordinal++)); do
	host_stats_args+=(
		--host-stats "host-${ordinal}=http://127.0.0.1:${host_ports[$ordinal]}/v1/sqlite/stats,ACTOR_RUNTIME_TOKEN"
	)
done
set +e
python3 "$qualifier" \
	--engine-url "http://127.0.0.1:${engine_api_port}" \
	--workers-api-url "http://127.0.0.1:${workers_api_port}" \
	--public-worker "$public_worker" \
	--public-class-name Agent \
	--depot-inspect-url "http://127.0.0.1:${engine_admin_port}" \
	--runner-name workerd \
	--actors "${QUALIFICATION_ACTORS:-$default_actors}" \
	--concurrency "${QUALIFICATION_CONCURRENCY:-$default_concurrency}" \
	--increments-per-actor "${QUALIFICATION_INCREMENTS:-$default_increments}" \
	--increment-round-delay-ms "${QUALIFICATION_INCREMENT_ROUND_DELAY_MS:-$default_increment_round_delay_ms}" \
	--request-timeout-seconds "${QUALIFICATION_REQUEST_TIMEOUT_SECONDS:-$default_request_timeout}" \
	--require-cold-before-wake \
	--require-bounded-recovery \
	--min-recovery-queued-hosts "${QUALIFICATION_MIN_RECOVERY_QUEUED_HOSTS:-$default_min_recovery_queued_hosts}" \
	--wake-requests-per-actor "${QUALIFICATION_WAKE_REQUESTS_PER_ACTOR:-$default_wake_requests_per_actor}" \
	--cold-state-timeout-seconds "${QUALIFICATION_COLD_STATE_TIMEOUT_SECONDS:-$default_cold_state_timeout}" \
	--cold-state-poll-seconds "${QUALIFICATION_COLD_STATE_POLL_SECONDS:-$default_cold_state_poll}" \
	--bottomless-actor-count "${QUALIFICATION_BOTTOMLESS_ACTORS:-1}" \
	--bottomless-bytes-per-actor "${QUALIFICATION_BOTTOMLESS_BYTES_PER_ACTOR:-$default_bottomless_bytes}" \
	--max-cold-wake-p95-ms "${QUALIFICATION_MAX_COLD_WAKE_P95_MS:-10000}" \
	--max-cold-wake-p99-ms "${QUALIFICATION_MAX_COLD_WAKE_P99_MS:-20000}" \
	--max-cold-wake-ms "${QUALIFICATION_MAX_COLD_WAKE_MS:-30000}" \
	"${host_stats_args[@]}" \
	--min-active-hosts 3 \
	--prove-sleep \
	--wake-after-sleep \
	--quiescence-timeout-seconds "${QUALIFICATION_QUIESCENCE_TIMEOUT_SECONDS:-$default_quiescence_timeout}" \
	--output "$receipt" >"$temporary/qualifier-output.json"
qualifier_status=$?
set -e

capture_release_binding "$temporary/release-after"
cmp "$temporary/release-before-binding.json" "$temporary/release-after-binding.json" || {
	echo "runtime release or Pod set changed during qualification" >&2
	exit 1
}

python3 - "$temporary" "$temporary/port-forward-transport.json" <<'PY'
import json
import sys
from pathlib import Path

root = Path(sys.argv[1])
result = {}
for path in sorted(root.glob("*-forward.log")):
    label = path.name[:-len("-forward.log")]
    restarts = sum(
        line.startswith("port-forward supervisor restart=")
        for line in path.read_text(errors="replace").splitlines()
    )
    result[label] = restarts
Path(sys.argv[2]).write_text(json.dumps(result, sort_keys=True) + "\n")
PY

python3 - "$receipt" "$qualification_profile" "$temporary/release-after-binding.json" \
	"$cell_name" "$namespace" "$temporary/port-forward-transport.json" <<'PY'
import json
import os
import sys
from pathlib import Path

receipt = Path(sys.argv[1])
profile = sys.argv[2]
release_binding = json.loads(Path(sys.argv[3]).read_text())
result = json.loads(receipt.read_text())
result["cell"] = sys.argv[4]
result["cell_namespace"] = sys.argv[5]
result["qualification_profile"] = profile
result["receipt_scope"] = {
    "production": "production-qualification",
    "production-cell": "production-cell-qualification",
    "e2e-fast": "development-e2e",
}[profile]
result["release_binding"] = release_binding
result.setdefault("transport", {})["port_forward_restarts"] = json.loads(
    Path(sys.argv[6]).read_text()
)
temporary_receipt = receipt.with_name(receipt.name + ".tmp")
temporary_receipt.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n")
os.replace(temporary_receipt, receipt)
if result.get("verdict") != "passed":
    print(json.dumps({
        "verdict": result.get("verdict"),
        "error": result.get("error"),
        "qualification_profile": result["qualification_profile"],
        "receipt_scope": result["receipt_scope"],
        "release_binding": result["release_binding"],
    }, sort_keys=True))
    raise SystemExit(0)
checkpoint = result["online_checkpoint"]
bottomless = result["bottomless"]
summary = {
    "verdict": result["verdict"],
    "qualification_profile": result["qualification_profile"],
    "receipt_scope": result["receipt_scope"],
    "release_binding": result["release_binding"],
    "actors": result["actors"],
    "writes": result["writes"],
    "sleep_proved": result["sleep_proved"],
    "wake_after_sleep": result["wake_after_sleep"],
    "online_checkpoint": {
        "contract": checkpoint["contract"],
        "passed": checkpoint["passed"],
        "service_interrupted": checkpoint["service_interrupted"],
        "writes_accepted_after_initial_checkpoint": checkpoint[
            "writes_accepted_after_initial_checkpoint"
        ],
        "continuity_reads": checkpoint["continuity_reads"],
        "initial_count": len(checkpoint["initial"]),
        "final_count": len(checkpoint["final"]),
    },
    "bottomless": {
        "contract": bottomless["contract"],
        "qualification_actor_count": bottomless["qualification_actor_count"],
        "bytes_per_qualification_actor": bottomless[
            "bytes_per_qualification_actor"
        ],
        "cold_state_wait_ms": bottomless["cold_state_wait_ms"],
        "state_count": len(bottomless["states"]),
    },
    "logical_quota": result["logical_quota"],
    "cold_read_slo": result["cold_read_slo"],
    "recovery_admission": result["recovery_admission"],
    "active_hosts": result["host_stats"].get("active_hosts"),
    "wake_hosts": result["host_stats"].get("wake_hosts"),
    "post_cleanup": result["host_stats"].get("post_cleanup"),
    "cleanup_errors": result["cleanup_errors"],
    "actor_manifest_sha256": result["actor_manifest_sha256"],
}
print(json.dumps(summary, sort_keys=True))
PY

if ((qualifier_status != 0)); then
	diagnostics_dir=${QUALIFICATION_FAILURE_DIAGNOSTICS_DIR:-${receipt}.diagnostics}
	[[ ! -e $diagnostics_dir ]] || {
		echo "qualification failure diagnostics path already exists: $diagnostics_dir" >&2
		exit 1
	}
	mkdir -p "$diagnostics_dir"
	cp "$temporary"/*-forward.log "$temporary/port-forward-transport.json" "$diagnostics_dir/"
	(
		cd "$diagnostics_dir"
		sha256sum -- * >SHA256SUMS
	)
	echo "qualification failure diagnostics: $diagnostics_dir" >&2
	exit "$qualifier_status"
fi

python3 "$script_dir/verify_bottomless_receipt.py" \
	--profile "$qualification_profile" \
	--expected-cell "$cell_name" \
	--expected-namespace "$namespace" \
	--expected-worker "$public_worker" \
	"$receipt" >/dev/null
