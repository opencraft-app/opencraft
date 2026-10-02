#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
qualification_services="qfdb-0 qfdb-1 qfdb-2 qfdb-3 qfdb-4 qfdb-init"
gate_dir=$(mktemp -d "${TMPDIR:-/tmp}/rivet-fdb-network-degradation.XXXXXX")
test_container="rivet-fdb-network-degradation-$$"
fault_service=qfdb-2
status_service=qfdb-0
netem_image=rivet-local/fdb-netem:7.3.79
netem_applied=0
gate_deadline_seconds=${QUALIFY_NETEM_GATE_DEADLINE_SECONDS:-600}

wait_for_successful_exit() {
	container_id=$(docker compose -f "$compose_file" --profile qualification ps -aq "$1")
	for attempt in $(seq 1 180); do
		state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container_id")
		[ "$state" = "exited 0" ] && return 0
		case "$state" in exited\ *) docker logs "$container_id" >&2 || true; return 1 ;; esac
		sleep 1
	done
	return 1
}

wait_for_gate() {
	gate=$1
	deadline=$(( $(date +%s) + gate_deadline_seconds ))
	while [ "$(date +%s)" -lt "$deadline" ]; do
		[ -f "$gate_dir/$gate" ] && return 0
		if ! docker inspect "$test_container" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
			docker logs "$test_container" >&2 || true
			return 1
		fi
		sleep 0.05
	done
	echo "timed out after ${gate_deadline_seconds}s waiting for gate $gate" >&2
	return 1
}

run_tc() {
	fault_container=$(docker compose -f "$compose_file" --profile qualification ps -q "$fault_service")
	docker run --rm --platform linux/amd64 \
		--network "container:$fault_container" \
		--cap-add NET_ADMIN \
		"$netem_image" "$@"
}

clear_netem() {
	[ "$netem_applied" = 1 ] || return 0
	run_tc qdisc del dev eth0 root >/dev/null 2>&1 || true
	netem_applied=0
}

wait_for_available_cluster() {
	for attempt in $(seq 1 120); do
		report=$(docker compose -f "$compose_file" --profile qualification exec -T \
			"$status_service" fdbcli --exec 'status json' 2>/dev/null || true)
		if printf '%s\n' "$report" | jq -e '.cluster.database_available == true' \
			>/dev/null 2>&1; then
			printf '%s\n' "$report"
			return 0
		fi
		sleep 1
	done
	printf '%s\n' "$report" >&2
	return 1
}

wait_for_recovery() {
	for attempt in $(seq 1 240); do
		report=$(docker compose -f "$compose_file" --profile qualification exec -T \
			"$status_service" fdbcli --exec 'status details' 2>&1 || true)
		if printf '%s\n' "$report" | grep -q 'Replication health     - Healthy' \
			&& printf '%s\n' "$report" | grep -q 'Fault Tolerance        - 2 machines'; then
			return 0
		fi
		sleep 1
	done
	printf '%s\n' "$report" >&2
	return 1
}

cleanup() {
	exit_code=$?
	trap - EXIT INT TERM
	clear_netem
	docker rm --force "$test_container" >/dev/null 2>&1 || true
	docker compose -f "$compose_file" --profile qualification \
		rm --stop --force $qualification_services >/dev/null 2>&1 || exit_code=1
	rm -f "$gate_dir/ready" "$gate_dir/node-stop-begun" "$gate_dir/node-stopped" \
		"$gate_dir/node-down-writes-complete" "$gate_dir/cluster-recovered"
	rmdir "$gate_dir" 2>/dev/null || exit_code=1
	exit "$exit_code"
}
trap cleanup EXIT INT TERM

if ! command -v jq >/dev/null 2>&1; then
	echo "qualify-fdb-network-degradation.sh requires jq" >&2
	exit 2
fi
case "$gate_deadline_seconds" in
	''|*[!0-9]*) echo "QUALIFY_NETEM_GATE_DEADLINE_SECONDS must be a positive integer" >&2; exit 2 ;;
esac
if [ "$gate_deadline_seconds" -eq 0 ]; then
	echo "QUALIFY_NETEM_GATE_DEADLINE_SECONDS must be a positive integer" >&2
	exit 2
fi

docker build --platform linux/amd64 --tag "$netem_image" \
	--file "$script_dir/Dockerfile.fdb-netem" "$script_dir" >/dev/null
docker compose -f "$compose_file" --profile qualification \
	rm --stop --force $qualification_services >/dev/null 2>&1 || true
docker compose -f "$compose_file" --profile qualification up --detach qfdb-init
wait_for_successful_exit qfdb-init

docker compose -f "$compose_file" --profile qualification run --detach --no-deps \
	--name "$test_container" \
	--volume "$gate_dir:/gate" \
	-e RIVET_TEST_FDB_NODE_LOSS=1 \
	-e RIVET_TEST_FDB_NODE_LOSS_COUNT=1 \
	-e RIVET_TEST_FDB_FAULT_KIND=outbound_netem \
	-e RIVET_TEST_FDB_GATE_DEADLINE_SECONDS="$gate_deadline_seconds" \
	-e RIVET_TEST_FDB_NODE_LOSS_GATE=/gate \
	qualify \
	cargo test -p universaldb --features foundationdb \
	--test foundationdb_node_loss \
	acknowledged_writes_survive_fdb_fault_and_recovery -- --exact --nocapture >/dev/null

wait_for_gate ready
touch "$gate_dir/node-stop-begun"

# This changes only the selected process's outbound interface. Inbound packets to the process and
# every other process remain untouched, which makes the fault asymmetric at the network layer.
run_tc qdisc replace dev eth0 root netem delay 750ms 250ms distribution normal loss 2%
netem_applied=1
netem_report=$(run_tc -s qdisc show dev eth0)
printf '%s\n' "$netem_report" | grep -q 'netem'
printf '%s\n' 'FDB_NETWORK_DEGRADATION_OBSERVED service=qfdb-2 delay_ms=750 jitter_ms=250 loss_percent=2 direction=outbound'
touch "$gate_dir/node-stopped"
wait_for_gate node-down-writes-complete
wait_for_available_cluster >/dev/null

clear_netem
wait_for_recovery
touch "$gate_dir/cluster-recovered"

test_exit=$(docker wait "$test_container")
docker logs "$test_container"
[ "$test_exit" = 0 ]
printf '%s\n' 'FDB_NETWORK_DEGRADATION_OK acknowledged=256 missing=0 corrupt=0'
