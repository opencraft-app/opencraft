#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
disk_full_services="dfdb-0 dfdb-1 dfdb-2 dfdb-3 dfdb-4 dfdb-init"
gate_dir=$(mktemp -d "${TMPDIR:-/tmp}/rivet-fdb-disk-full.XXXXXX")
test_container="rivet-fdb-disk-full-$$"
fault_service=dfdb-2
status_service=dfdb-0
filler_path=/var/fdb/data/.qualification-disk-full

wait_for_successful_exit() {
	container_id=$(docker compose -f "$compose_file" --profile disk-full ps -aq "$1")
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
	for attempt in $(seq 1 6000); do
		[ -f "$gate_dir/$gate" ] && return 0
		if ! docker inspect "$test_container" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
			docker logs "$test_container" >&2 || true
			return 1
		fi
		sleep 0.05
	done
	return 1
}

status_details() {
	docker compose -f "$compose_file" --profile disk-full exec -T "$status_service" \
		fdbcli --exec 'status details'
}

status_json() {
	docker compose -f "$compose_file" --profile disk-full exec -T "$status_service" \
		fdbcli --exec 'status json'
}

wait_for_disk_pressure() {
	for attempt in $(seq 1 60); do
		fault_container=$(docker compose -f "$compose_file" --profile disk-full ps -aq "$fault_service")
		if [ "$(docker inspect --format '{{.State.Running}}' "$fault_container" 2>/dev/null || true)" != true ]; then
			fault_logs=$(docker logs "$fault_container" 2>&1 || true)
			if printf '%s\n' "$fault_logs" | grep -qi 'Fatal Error: Disk i/o operation failed'; then
				printf '%s\n' 'FDB_DISK_PRESSURE_MODE=process_exit'
				printf '%s\n' "$fault_logs"
				return 0
			fi
			printf '%s\n' "$fault_logs" >&2
			return 1
		fi
		report=$(status_details 2>&1 || true)
		if printf '%s\n' "$report" | grep -q 'Storage server running out of space'; then
			printf '%s\n' 'FDB_DISK_PRESSURE_MODE=low_space_warning'
			printf '%s\n' "$report"
			return 0
		fi
		sleep 1
	done
	printf '%s\n' "$report" >&2
	return 1
}

wait_for_available_cluster() {
	for attempt in $(seq 1 60); do
		report=$(status_json 2>/dev/null || true)
		if printf '%s\n' "$report" | jq -e \
			'.cluster.database_available == true and
			 (.cluster.fault_tolerance.max_zone_failures_without_losing_availability >= 1)' \
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
		report=$(status_details 2>&1 || true)
		if printf '%s\n' "$report" | grep -q 'Replication health     - Healthy' \
			&& printf '%s\n' "$report" | grep -q 'Fault Tolerance        - 2 machines' \
			&& ! printf '%s\n' "$report" | grep -q 'Storage server running out of space'; then
			printf '%s\n' "$report"
			return 0
		fi
		sleep 1
	done
	printf '%s\n' "$report" >&2
	return 1
}

remove_filler() {
	docker compose -f "$compose_file" --profile disk-full exec -T "$fault_service" \
		rm -f "$filler_path" >/dev/null 2>&1 || true
}

recover_fault_service() {
	fault_container=$(docker compose -f "$compose_file" --profile disk-full ps -aq "$fault_service")
	if [ "$(docker inspect --format '{{.State.Running}}' "$fault_container" 2>/dev/null || true)" = true ]; then
		remove_filler
		return 0
	fi

	# A completely exhausted data filesystem can make fdbserver exit before cleanup is possible.
	# Replace only that ephemeral container; its fresh tmpfs models installing an empty local disk.
	docker compose -f "$compose_file" --profile disk-full \
		rm --stop --force "$fault_service" >/dev/null
	docker compose -f "$compose_file" --profile disk-full \
		up --detach --no-deps "$fault_service" >/dev/null
	container_id=$(docker compose -f "$compose_file" --profile disk-full ps -q "$fault_service")
	for attempt in $(seq 1 120); do
		if [ "$(docker inspect --format '{{.State.Health.Status}}' "$container_id")" = healthy ]; then
			return 0
		fi
		sleep 1
	done
	return 1
}

cleanup() {
	exit_code=$?
	trap - EXIT INT TERM
	remove_filler
	docker rm --force "$test_container" >/dev/null 2>&1 || true
	docker compose -f "$compose_file" --profile disk-full \
		rm --stop --force $disk_full_services >/dev/null 2>&1 || exit_code=1
	rm -f "$gate_dir/ready" "$gate_dir/node-stop-begun" "$gate_dir/node-stopped" \
		"$gate_dir/node-down-writes-complete" "$gate_dir/cluster-recovered"
	rmdir "$gate_dir" 2>/dev/null || exit_code=1
	exit "$exit_code"
}
trap cleanup EXIT INT TERM

if ! command -v jq >/dev/null 2>&1; then
	echo "qualify-fdb-disk-full.sh requires jq" >&2
	exit 2
fi

# Always begin with empty, bounded tmpfs data directories. This also removes any filler retained
# by an interrupted previous qualification without touching the long-running Actor cluster.
docker compose -f "$compose_file" --profile disk-full \
	rm --stop --force $disk_full_services >/dev/null 2>&1 || true
docker compose -f "$compose_file" --profile disk-full up --detach dfdb-init
wait_for_successful_exit dfdb-init

docker compose -f "$compose_file" --profile qualification --profile disk-full \
	run --detach --no-deps \
	--name "$test_container" \
	--volume "$gate_dir:/gate" \
	--volume "$script_dir/disk-full-fdb.cluster:/etc/foundationdb/fdb.cluster:ro" \
	-e RIVET_TEST_FDB_NODE_LOSS=1 \
	-e RIVET_TEST_FDB_NODE_LOSS_COUNT=1 \
	-e RIVET_TEST_FDB_FAULT_KIND=disk_full \
	-e RIVET_TEST_FDB_GATE_DEADLINE_SECONDS=300 \
	-e RIVET_TEST_FDB_NODE_LOSS_GATE=/gate \
	qualify \
	cargo test -p universaldb --features foundationdb \
	--test foundationdb_node_loss \
	acknowledged_writes_survive_fdb_fault_and_recovery -- --exact --nocapture >/dev/null

wait_for_gate ready
touch "$gate_dir/node-stop-begun"

# Leave roughly 1-2 MiB available. This crosses the qualification cluster's 16 MiB FDB safety
# floor while keeping enough headroom for diagnostics and exact cleanup inside the container.
available_kb=$(docker compose -f "$compose_file" --profile disk-full exec -T "$fault_service" \
	df -Pk /var/fdb/data | awk 'NR == 2 { print $4 }')
fill_mb=$(( (available_kb - 1024) / 1024 ))
if [ "$fill_mb" -le 0 ]; then
	echo "unexpectedly low initial free space on $fault_service: ${available_kb} KiB" >&2
	exit 1
fi
docker compose -f "$compose_file" --profile disk-full exec -T "$fault_service" \
	dd if=/dev/zero of="$filler_path" bs=1048576 count="$fill_mb" conv=fsync status=none

if remaining_kb=$(docker compose -f "$compose_file" --profile disk-full exec -T "$fault_service" \
	df -Pk /var/fdb/data 2>/dev/null | awk 'NR == 2 { print $4 }'); then
	:
else
	remaining_kb=0
fi
if [ "$remaining_kb" -gt 4096 ]; then
	echo "disk pressure did not cross the qualification threshold: ${remaining_kb} KiB remain" >&2
	exit 1
fi

pressure_report=$(wait_for_disk_pressure)
degraded_json=$(wait_for_available_cluster)
printf '%s\n' "$degraded_json" | jq -e '.cluster.database_available == true' >/dev/null
if ! printf '%s\n' "$pressure_report" | grep -Eq \
	'Storage server running out of space|Fatal Error: Disk i/o operation failed'; then
	echo 'FDB did not report a qualifying disk-pressure mode' >&2
	exit 1
fi
printf '%s\n' "FDB_DISK_PRESSURE_OBSERVED service=$fault_service remaining_kb=$remaining_kb"
touch "$gate_dir/node-stopped"
wait_for_gate node-down-writes-complete

recover_fault_service
wait_for_recovery >/dev/null
touch "$gate_dir/cluster-recovered"

test_exit=$(docker wait "$test_container")
docker logs "$test_container"
[ "$test_exit" = 0 ]
printf '%s\n' 'FDB_DISK_FULL_OK acknowledged=256 missing=0 corrupt=0'
