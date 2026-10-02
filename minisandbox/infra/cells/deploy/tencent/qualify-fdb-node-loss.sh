#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
qualification_services="qfdb-0 qfdb-1 qfdb-2 qfdb-3 qfdb-4 qfdb-init"
gate_dir=$(mktemp -d "${TMPDIR:-/tmp}/rivet-fdb-node-loss.XXXXXX")
test_container="rivet-fdb-node-loss-$$"
fail_count=${QUALIFY_FDB_FAIL_COUNT:-1}

wait_for_successful_exit() {
	service=$1
	container_id=$(docker compose -f "$compose_file" --profile qualification ps -q "$service")
	if [ -z "$container_id" ]; then
		echo "$service container was not created" >&2
		return 1
	fi

	for attempt in $(seq 1 180); do
		state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container_id")
		status=${state% *}
		exit_code=${state##* }
		if [ "$status" = exited ]; then
			if [ "$exit_code" = 0 ]; then
				return 0
			fi
			docker logs "$container_id" >&2 || true
			echo "$service exited with code $exit_code" >&2
			return 1
		fi
		sleep 1
	done

	docker logs "$container_id" >&2 || true
	echo "$service did not complete within 180 seconds" >&2
	return 1
}

wait_for_gate() {
	gate=$1
	for attempt in $(seq 1 3600); do
		if [ -f "$gate_dir/$gate" ]; then
			return 0
		fi
		if ! docker inspect "$test_container" --format '{{.State.Running}}' 2>/dev/null | grep -q true; then
			docker logs "$test_container" >&2 || true
			echo "qualification workload exited before gate $gate" >&2
			return 1
		fi
		sleep 0.05
	done

	docker logs "$test_container" >&2 || true
	echo "timed out waiting for qualification gate $gate" >&2
	return 1
}

status_json() {
	docker compose -f "$compose_file" --profile qualification exec -T "$status_service" \
		fdbcli --exec 'status json'
}

status_details() {
	docker compose -f "$compose_file" --profile qualification exec -T "$status_service" \
		fdbcli --exec 'status details'
}

service_for_address() {
	case "$1" in
		192.168.240.20:4500) echo qfdb-0 ;;
		192.168.240.21:4500) echo qfdb-1 ;;
		192.168.240.22:4500) echo qfdb-2 ;;
		192.168.240.23:4500) echo qfdb-3 ;;
		192.168.240.24:4500) echo qfdb-4 ;;
		*)
			echo "unknown qualification FDB address $1" >&2
			return 1
			;;
	esac
}

address_for_service() {
	case "$1" in
		qfdb-0) echo 192.168.240.20:4500 ;;
		qfdb-1) echo 192.168.240.21:4500 ;;
		qfdb-2) echo 192.168.240.22:4500 ;;
		qfdb-3) echo 192.168.240.23:4500 ;;
		qfdb-4) echo 192.168.240.24:4500 ;;
	esac
}

wait_for_recovery() {
	for attempt in $(seq 1 240); do
		report=$(status_details 2>&1 || true)
		if printf '%s\n' "$report" | grep -q 'Replication health     - Healthy' \
			&& printf '%s\n' "$report" | grep -q 'Fault Tolerance        - 2 machines'; then
			printf '%s\n' "$report"
			return 0
		fi
		sleep 1
	done

	printf '%s\n' "$report" >&2
	echo "FoundationDB did not restore full replication within 240 seconds" >&2
	return 1
}

cleanup() {
	exit_code=$?
	trap - EXIT INT TERM
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
	echo "qualify-fdb-node-loss.sh requires jq to inspect FoundationDB status json" >&2
	exit 2
fi
case "$fail_count" in
	1|2) ;;
	*)
		echo "QUALIFY_FDB_FAIL_COUNT must be 1 or 2" >&2
		exit 2
		;;
esac

docker compose -f "$compose_file" --profile qualification \
	rm --stop --force $qualification_services >/dev/null 2>&1 || true
docker compose -f "$compose_file" --profile qualification up --detach qfdb-init
wait_for_successful_exit qfdb-init

status_service=qfdb-0
initial_status=$(status_json)

if [ -n "${QUALIFY_FDB_FAIL_SERVICES:-}" ]; then
	fault_services=$QUALIFY_FDB_FAIL_SERVICES
else
	# Prefer processes carrying the durability-critical log role. Every qualification process also
	# carries storage and coordinator roles, so these are realistic worst-case loss targets.
	fault_addresses=$(printf '%s\n' "$initial_status" | jq -r --argjson count "$fail_count" \
		'[.cluster.processes[] | select([.roles[]?.role] | index("log")) | .address] | sort | .[:$count][]')
	fault_services=
	for fault_address in $fault_addresses; do
		fault_services="$fault_services $(service_for_address "$fault_address")"
	done
	fault_services=${fault_services# }
	if [ -z "$fault_services" ]; then
		echo "could not find FoundationDB log processes in status json" >&2
		exit 1
	fi
fi

set -- $fault_services
if [ "$#" -ne "$fail_count" ]; then
	echo "QUALIFY_FDB_FAIL_SERVICES must contain exactly $fail_count services" >&2
	exit 2
fi
for fault_service in $fault_services; do
	case "$fault_service" in
		qfdb-0|qfdb-1|qfdb-2|qfdb-3|qfdb-4) ;;
		*)
			echo "QUALIFY_FDB_FAIL_SERVICES entries must be qfdb-0 through qfdb-4" >&2
			exit 2
			;;
	esac
done

status_service=
for candidate in qfdb-0 qfdb-1 qfdb-2 qfdb-3 qfdb-4; do
	case " $fault_services " in
		*" $candidate "*) ;;
		*) status_service=$candidate; break ;;
	esac
done
for fault_service in $fault_services; do
	fault_address=$(address_for_service "$fault_service")
	fault_roles=$(status_json | jq -r --arg address "$fault_address" \
		'[.cluster.processes[] | select(.address == $address) | .roles[]?.role] | sort | join(",")')
	printf '%s\n' "FDB_NODE_LOSS_TARGET service=$fault_service address=$fault_address roles=$fault_roles"
done

docker compose -f "$compose_file" --profile qualification run --detach --no-deps \
	--name "$test_container" \
	--volume "$gate_dir:/gate" \
	-e RIVET_TEST_FDB_NODE_LOSS=1 \
	-e "RIVET_TEST_FDB_NODE_LOSS_COUNT=$fail_count" \
	-e RIVET_TEST_FDB_FAULT_KIND=node_and_disk_loss \
	-e RIVET_TEST_FDB_NODE_LOSS_GATE=/gate \
	qualify \
	cargo test -p universaldb --features foundationdb \
	--test foundationdb_node_loss \
	acknowledged_writes_survive_fdb_fault_and_recovery -- --exact --nocapture >/dev/null

wait_for_gate ready
touch "$gate_dir/node-stop-begun"
docker compose -f "$compose_file" --profile qualification stop $fault_services >/dev/null
touch "$gate_dir/node-stopped"
wait_for_gate node-down-writes-complete

degraded_status=$(status_details)
printf '%s\n' "$degraded_status"
degraded_json=$(status_json)
printf '%s\n' "$degraded_json" | jq -e '.cluster.database_available == true' >/dev/null
expected_remaining_tolerance=$((2 - fail_count))
printf '%s\n' "$degraded_json" | jq -e --argjson expected "$expected_remaining_tolerance" \
	'.cluster.fault_tolerance.max_zone_failures_without_losing_availability == $expected' >/dev/null

# qfdb storage is tmpfs-backed. Starting the process again gives it an empty local disk, forcing
# FoundationDB to rebuild the lost replica instead of merely reopening intact process data.
docker compose -f "$compose_file" --profile qualification start $fault_services >/dev/null
recovered_status=$(wait_for_recovery)
printf '%s\n' "$recovered_status"
touch "$gate_dir/cluster-recovered"

test_exit=$(docker wait "$test_container")
docker logs "$test_container"
if [ "$test_exit" != 0 ]; then
	echo "FoundationDB node-loss qualification failed with exit code $test_exit" >&2
	exit "$test_exit"
fi
