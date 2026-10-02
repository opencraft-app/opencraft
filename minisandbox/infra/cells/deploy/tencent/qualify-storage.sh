#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
compose_file="$script_dir/compose.yaml"
qualification_services="qfdb-0 qfdb-1 qfdb-2 qfdb-3 qfdb-4 qfdb-init"

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

cleanup() {
	exit_code=$?
	trap - EXIT INT TERM
	docker compose -f "$compose_file" --profile qualification \
		rm --stop --force $qualification_services >/dev/null 2>&1 || exit_code=1
	exit "$exit_code"
}
trap cleanup EXIT INT TERM

docker compose -f "$compose_file" --profile qualification \
	rm --stop --force $qualification_services >/dev/null 2>&1 || true
docker compose -f "$compose_file" --profile qualification \
	up --detach qfdb-init minio
wait_for_successful_exit qfdb-init

if [ -n "${QUALIFY_FDB_STOP:-}" ]; then
	for service in $QUALIFY_FDB_STOP; do
		case "$service" in
			qfdb-0|qfdb-1|qfdb-2|qfdb-3|qfdb-4) ;;
			*)
				echo "QUALIFY_FDB_STOP entries must be qfdb-0 through qfdb-4" >&2
				exit 2
				;;
		esac
	done
	docker compose -f "$compose_file" stop $QUALIFY_FDB_STOP >/dev/null
fi

docker compose -f "$compose_file" \
	--profile qualification run --rm --no-deps qualify \
	cargo test -p universaldb --features foundationdb \
	--test integration test_foundationdb_driver -- --exact

docker compose -f "$compose_file" \
	--profile qualification run --rm --no-deps qualify \
	cargo test -p rivet-pools --features foundationdb \
	--test foundationdb creates_pool_and_enforces_physical_cluster_cell_policy -- --exact

docker compose -f "$compose_file" \
	--profile qualification run --rm --no-deps \
	-e RIVET_TEST_DATABASE=foundationdb \
	-e RIVET_TEST_FDB_CLUSTER_FILE=/etc/foundationdb/fdb.cluster \
	qualify \
	cargo test -p gasoline --features rivet-test-deps/foundationdb \
	--lib db::kv::lease_tests::expired_worker_failover_uses_worker_index_and_fences_stale_leases \
	-- --exact

docker compose -f "$compose_file" \
	--profile qualification run --rm --no-deps qualify
