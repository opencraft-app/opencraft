#!/usr/bin/env bash
set -Eeuo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
compose_file="$script_dir/compose.yaml"
qualification_services=(qfdb-0 qfdb-1 qfdb-2 qfdb-3 qfdb-4 qfdb-init)

duration_seconds=${SOAK_DURATION_SECONDS:-3600}
ops=${SOAK_OPS:-256}
reload_every=${SOAK_RELOAD_EVERY:-11}
keep_cluster=${SOAK_KEEP_CLUSTER:-0}
log_dir=${SOAK_LOG_DIR:-"$repo_root/.omx/soak"}
run_id=$(date -u +%Y%m%dT%H%M%SZ)
log_file="$log_dir/fdb-minio-soak-$run_id.log"

for numeric in "$duration_seconds" "$ops" "$reload_every"; do
	if [[ ! "$numeric" =~ ^[0-9]+$ ]]; then
		echo "soak duration, ops, and reload interval must be unsigned integers" >&2
		exit 2
	fi
done
if (( duration_seconds < 1 || ops < 16 || ops > 10000 )); then
	echo "SOAK_DURATION_SECONDS must be positive and SOAK_OPS must be in [16, 10000]" >&2
	exit 2
fi
if (( reload_every < 2 || reload_every > ops )); then
	echo "SOAK_RELOAD_EVERY must be in [2, SOAK_OPS]" >&2
	exit 2
fi

mkdir -p "$log_dir"
exec > >(tee -a "$log_file") 2>&1

round=0
current_seed=not-started
started_at=$(date +%s)
soak_started_at=$started_at
deadline=$((soak_started_at + duration_seconds))

cleanup() {
	local exit_code=$?
	trap - EXIT INT TERM
	local finished_at elapsed
	finished_at=$(date +%s)
	if (( round > 0 )); then
		elapsed=$((finished_at - soak_started_at))
	else
		elapsed=$((finished_at - started_at))
	fi
	if (( exit_code == 0 )); then
		echo "FDB+MinIO soak passed rounds=$round elapsed_seconds=$elapsed log=$log_file"
	else
		echo "FDB+MinIO soak failed round=$round seed=$current_seed elapsed_seconds=$elapsed log=$log_file" >&2
	fi
	if [[ "$keep_cluster" != 1 ]]; then
		docker compose -f "$compose_file" --profile qualification \
			rm --stop --force "${qualification_services[@]}" >/dev/null 2>&1 || exit_code=1
	else
		echo "qualification FDB retained because SOAK_KEEP_CLUSTER=1"
	fi
	exit "$exit_code"
}
trap cleanup EXIT INT TERM

wait_for_successful_exit() {
	local service=$1 container_id state status exit_code
	container_id=$(docker compose -f "$compose_file" --profile qualification ps -q "$service")
	if [[ -z "$container_id" ]]; then
		echo "$service container was not created" >&2
		return 1
	fi

	for _ in $(seq 1 180); do
		state=$(docker inspect --format '{{.State.Status}} {{.State.ExitCode}}' "$container_id")
		status=${state% *}
		exit_code=${state##* }
		if [[ "$status" == exited ]]; then
			if [[ "$exit_code" == 0 ]]; then
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

new_seed() {
	local hex
	hex=$(LC_ALL=C od -An -N8 -tx1 /dev/urandom | tr -d ' \n')
	printf '0x%s\n' "$hex"
}

assert_storage_healthy() {
	local fdb_report
	fdb_report=$(docker compose -f "$compose_file" --profile qualification exec -T qfdb-0 \
		fdbcli --exec 'status details')
	grep -q 'Replication health     - Healthy' <<<"$fdb_report"
	grep -q 'Fault Tolerance        - 2 machines' <<<"$fdb_report"
	curl --fail --silent --show-error http://127.0.0.1:19010/minio/health/ready >/dev/null
}

echo "starting real FDB+MinIO soak duration_seconds=$duration_seconds ops=$ops reload_every=$reload_every"
echo "log=$log_file"
docker compose -f "$compose_file" --profile qualification \
	rm --stop --force "${qualification_services[@]}" >/dev/null 2>&1 || true
docker compose -f "$compose_file" --profile qualification up --detach qfdb-init minio
wait_for_successful_exit qfdb-init
assert_storage_healthy

# Prove the newly created cluster implements the UniversalDB contract before counting soak time.
docker compose -f "$compose_file" --profile qualification run --rm --no-deps qualify \
	cargo test -p universaldb --features foundationdb \
	--test integration test_foundationdb_driver -- --exact

# Cluster creation, compilation, and conformance are preflight. The requested duration measures
# complete FDB+MinIO workload rounds only.
soak_started_at=$(date +%s)
deadline=$((soak_started_at + duration_seconds))
echo "preflight passed; timed soak window started_at=$soak_started_at deadline=$deadline"

while :; do
	round=$((round + 1))
	current_seed=$(new_seed)
	round_started=$(date +%s)
	echo "round=$round seed=$current_seed phase=fdb-chaos started_at=$round_started"

	# This is the generated SQLite/VFS state machine itself running on the real FDB cluster.
	docker compose -f "$compose_file" --profile qualification run --rm --no-deps \
		-e RIVET_TEST_DATABASE=foundationdb \
		-e RIVET_TEST_FDB_CLUSTER_FILE=/etc/foundationdb/fdb.cluster \
		-e "RIVET_CHAOS_SEED=$current_seed" \
		-e "RIVET_CHAOS_OPS=$ops" \
		-e "RIVET_CHAOS_RELOAD_EVERY=$reload_every" \
		qualify \
		cargo test -p rivet-depot-client --features rivet-test-deps/foundationdb \
		vfs::tests::fault::chaos::chaos_replay_from_env -- \
		--ignored --exact --test-threads=1

	echo "round=$round seed=$current_seed phase=fdb-minio-cold"
	# A fresh UUID-scoped database and bucket exercise FDB commit, hot compaction, MinIO publish,
	# proof-gated FDB hot eviction, exact-key cold read, integrity validation, and FDB cache refill.
	docker compose -f "$compose_file" --profile qualification run --rm --no-deps qualify \
		cargo test -p depot --features foundationdb,test-faults \
		--test cold_workflow_publish \
		foundationdb_s3_workflow_publishes_evicts_and_refills_by_exact_key -- --exact

	assert_storage_healthy
	now=$(date +%s)
	echo "round=$round seed=$current_seed result=passed round_seconds=$((now - round_started)) elapsed_seconds=$((now - soak_started_at))"
	if (( now >= deadline )); then
		break
	fi
done
