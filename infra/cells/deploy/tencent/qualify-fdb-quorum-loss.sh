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
	up --detach qfdb-init
wait_for_successful_exit qfdb-init

# Five coordinators require a majority. Leaving two processes proves the client fails closed and
# returns within its configured transaction deadline instead of occupying a task indefinitely.
docker compose -f "$compose_file" stop qfdb-2 qfdb-3 qfdb-4 >/dev/null
docker compose -f "$compose_file" --profile qualification run --rm --no-deps \
	-e RIVET_TEST_FDB_UNAVAILABLE=1 \
	qualify \
	cargo test -p universaldb --features foundationdb \
	--test foundationdb_unavailable \
	foundationdb_quorum_loss_has_bounded_transaction_latency -- --exact
