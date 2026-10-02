#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
qualification_services="qfdb-0 qfdb-1 qfdb-2 qfdb-3 qfdb-4 qfdb-init"
gate_dir=$(mktemp -d "${TMPDIR:-/tmp}/rivet-fdb-network-partition.XXXXXX")
test_container="rivet-fdb-network-partition-$$"
fault_service=qfdb-2
fault_address=192.168.240.22
status_service=qfdb-0
network_name=
partitioned=0

wait_for_successful_exit() {
	service=$1
	container_id=$(docker compose -f "$compose_file" --profile qualification ps -aq "$service")
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
	for attempt in $(seq 1 3600); do
		[ -f "$gate_dir/$gate" ] && return 0
		if ! docker inspect "$test_container" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
			docker logs "$test_container" >&2 || true
			return 1
		fi
		sleep 0.05
	done
	return 1
}

status_json() {
	docker compose -f "$compose_file" --profile qualification exec -T "$status_service" \
		fdbcli --exec 'status json'
}

wait_for_recovery() {
	for attempt in $(seq 1 240); do
		report=$(docker compose -f "$compose_file" --profile qualification exec -T \
			"$status_service" fdbcli --exec 'status details' 2>&1 || true)
		if printf '%s\n' "$report" | grep -q 'Replication health     - Healthy' \
			&& printf '%s\n' "$report" | grep -q 'Fault Tolerance        - 2 machines'; then
			printf '%s\n' "$report"
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
	if [ "$partitioned" = 1 ]; then
		fault_container=$(docker compose -f "$compose_file" --profile qualification ps -aq "$fault_service")
		docker network connect --ip "$fault_address" "$network_name" "$fault_container" \
			>/dev/null 2>&1 || true
	fi
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
	echo "qualify-fdb-network-partition.sh requires jq" >&2
	exit 2
fi

docker compose -f "$compose_file" --profile qualification \
	rm --stop --force $qualification_services >/dev/null 2>&1 || true
docker compose -f "$compose_file" --profile qualification up --detach qfdb-init
wait_for_successful_exit qfdb-init

fault_container=$(docker compose -f "$compose_file" --profile qualification ps -q "$fault_service")
network_name=$(docker inspect "$fault_container" | jq -r '.[0].NetworkSettings.Networks | keys[0]')

docker compose -f "$compose_file" --profile qualification run --detach --no-deps \
	--name "$test_container" \
	--volume "$gate_dir:/gate" \
	-e RIVET_TEST_FDB_NODE_LOSS=1 \
	-e RIVET_TEST_FDB_NODE_LOSS_COUNT=1 \
	-e RIVET_TEST_FDB_FAULT_KIND=network_partition \
	-e RIVET_TEST_FDB_NODE_LOSS_GATE=/gate \
	qualify \
	cargo test -p universaldb --features foundationdb \
	--test foundationdb_node_loss \
	acknowledged_writes_survive_fdb_fault_and_recovery -- --exact --nocapture >/dev/null

wait_for_gate ready
touch "$gate_dir/node-stop-begun"
docker network disconnect "$network_name" "$fault_container"
partitioned=1
touch "$gate_dir/node-stopped"
wait_for_gate node-down-writes-complete

degraded_json=$(status_json)
printf '%s\n' "$degraded_json" | jq -e '.cluster.database_available == true' >/dev/null
printf '%s\n' "$degraded_json" | jq -e \
	'.cluster.fault_tolerance.max_zone_failures_without_losing_availability == 1' >/dev/null

docker network connect --ip "$fault_address" "$network_name" "$fault_container"
partitioned=0
wait_for_recovery >/dev/null
touch "$gate_dir/cluster-recovered"

test_exit=$(docker wait "$test_container")
docker logs "$test_container"
[ "$test_exit" = 0 ]
printf '%s\n' 'FDB_NETWORK_PARTITION_OK acknowledged=256 missing=0 corrupt=0'
