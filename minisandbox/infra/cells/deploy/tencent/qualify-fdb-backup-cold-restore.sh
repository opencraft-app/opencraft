#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
compose_file="$script_dir/compose.yaml"
qualification_services="qfdb-backup-agent qfdb-0 qfdb-1 qfdb-2 qfdb-3 qfdb-4 qfdb-init"
artifact_dir=${RIVET_BACKUP_RESTORE_EVIDENCE_DIR:-"$repo_root/.omx/qualification/fdb-backup-cold-restore"}
run_id=$(date -u +%Y%m%dT%H%M%SZ)
tag="actor-cold-$run_id"
backup_base="file:///backup/$tag"
cold_evidence="$artifact_dir/$tag-cold.json"
seed_log="$artifact_dir/$tag-seed.log"
restore_log="$artifact_dir/$tag-restore.log"
branch_gc_log="$artifact_dir/$tag-branch-gc.log"
receipt="$artifact_dir/$tag.json"

wait_for_successful_exit() {
	service=$1
	container_id=$(docker compose -f "$compose_file" --profile qualification ps -aq "$service")
	if [ -z "$container_id" ]; then
		echo "$service container was not created" >&2
		return 1
	fi

	for attempt in $(seq 1 240); do
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
	echo "$service did not complete within 240 seconds" >&2
	return 1
}

remove_qualification_cluster() {
	docker compose -f "$compose_file" --profile qualification \
		rm --stop --force $qualification_services >/dev/null 2>&1 || true
}

start_fresh_cluster() {
	remove_qualification_cluster
	docker compose -f "$compose_file" --profile qualification up --detach qfdb-init
	wait_for_successful_exit qfdb-init
}

start_backup_agent() {
	docker compose -f "$compose_file" --profile qualification up --detach qfdb-backup-agent
}

cleanup() {
	exit_code=$?
	trap - EXIT INT TERM
	remove_qualification_cluster
	exit "$exit_code"
}
trap cleanup EXIT INT TERM

if ! command -v jq >/dev/null 2>&1; then
	echo "qualify-fdb-backup-cold-restore.sh requires jq" >&2
	exit 2
fi

mkdir -p "$artifact_dir"
artifact_dir=$(CDPATH= cd -- "$artifact_dir" && pwd)
cold_evidence="$artifact_dir/$tag-cold.json"
seed_log="$artifact_dir/$tag-seed.log"
restore_log="$artifact_dir/$tag-restore.log"
branch_gc_log="$artifact_dir/$tag-branch-gc.log"
receipt="$artifact_dir/$tag.json"

docker compose -f "$compose_file" up --detach minio-init
start_fresh_cluster

docker compose -f "$compose_file" --profile qualification run --rm --no-deps \
	--volume "$artifact_dir:/evidence" \
	-e RIVET_TEST_S3_ENDPOINT=http://minio:9000 \
	-e RIVET_TEST_S3_REGION=us-east-1 \
	-e RIVET_TEST_S3_BUCKET=rivet-depot-cold \
	-e RIVET_TEST_S3_ADDRESSING_STYLE=path \
	-e RIVET_TEST_S3_KEEP_OBJECT=1 \
	-e RIVET_TEST_S3_LEAVE_HOT_EVICTED=1 \
	-e "RIVET_TEST_S3_EVIDENCE_FILE=/evidence/$tag-cold.json" \
	qualify \
	cargo test -p depot --features foundationdb,test-faults \
	--test cold_workflow_publish \
	foundationdb_s3_workflow_publishes_evicts_and_refills_by_exact_key -- --exact --nocapture \
	| tee "$seed_log"

jq -e '
	.retained == true and
	.fdb_hot_evicted_before_read == true and
	.cold_read_provenance == true and
	.fdb_hot_refilled_after_read == true and
	.fdb_hot_evicted_at_exit == true
' "$cold_evidence" >/dev/null
database_id=$(jq -r .database_id "$cold_evidence")

start_backup_agent
backup_output=$(docker compose -f "$compose_file" --profile qualification exec -T \
	qfdb-backup-agent fdbbackup start -C /etc/foundationdb/fdb.cluster \
	-d "$backup_base" -t "$tag" -w)
printf '%s\n' "$backup_output"
backup_status=$(docker compose -f "$compose_file" --profile qualification exec -T \
	qfdb-backup-agent fdbbackup status -C /etc/foundationdb/fdb.cluster -t "$tag")
printf '%s\n' "$backup_status"
backup_url=$(printf '%s\n' "$backup_status" | sed -n 's/^BackupURL: //p' | tail -1)
backup_uid=$(printf '%s\n' "$backup_status" | sed -n 's/^BackupUID: //p' | tail -1)
if [ -z "$backup_url" ] || [ -z "$backup_uid" ]; then
	echo "completed FoundationDB backup did not report URL and UID" >&2
	exit 1
fi

# The backup above is the last supported pre-tombstone restore. Branch GC may sweep its FDB
# subspace immediately, but must retain every exact cold object until both the recovery window and
# a backup-catalog restore floor newer than the tombstone have been certified.
docker compose -f "$compose_file" --profile qualification run --rm --no-deps \
	-e RIVET_TEST_S3_ENDPOINT=http://minio:9000 \
	-e RIVET_TEST_S3_REGION=us-east-1 \
	-e RIVET_TEST_S3_BUCKET=rivet-depot-cold \
	-e RIVET_TEST_S3_ADDRESSING_STYLE=path \
	-e "RIVET_TEST_BRANCH_GC_DATABASE_ID=$database_id" \
	qualify \
	cargo test -p depot --features foundationdb,test-faults \
	--test cold_workflow_publish \
	foundationdb_branch_gc_retains_s3_object_for_pre_tombstone_backup -- --exact --nocapture \
	| tee "$branch_gc_log"
grep -q 'RIVET_FDB_BRANCH_GC_BACKUP_FENCE_OK' "$branch_gc_log"

# All five FDB processes use tmpfs. Removing them here destroys every source data file and forces
# the restore to target a genuinely empty cluster; the backup volume and MinIO object are separate.
start_fresh_cluster
start_backup_agent
docker compose -f "$compose_file" --profile qualification exec -T qfdb-backup-agent \
	fdbrestore start -w -r "$backup_url" \
	--dest-cluster-file /etc/foundationdb/fdb.cluster -t "$tag-restore"

docker compose -f "$compose_file" --profile qualification run --rm --no-deps \
	-e RIVET_TEST_S3_ENDPOINT=http://minio:9000 \
	-e RIVET_TEST_S3_REGION=us-east-1 \
	-e RIVET_TEST_S3_BUCKET=rivet-depot-cold \
	-e RIVET_TEST_S3_ADDRESSING_STYLE=path \
	-e "RIVET_TEST_RESTORE_DATABASE_ID=$database_id" \
	qualify \
	cargo test -p depot --features foundationdb,test-faults \
	--test cold_workflow_publish \
	restored_foundationdb_backup_reads_retained_s3_object -- --exact --nocapture \
	| tee "$restore_log"
grep -q 'RIVET_FDB_BACKUP_COLD_RESTORE_OK' "$restore_log"

jq \
	--arg backup_url "$backup_url" \
	--arg backup_uid "$backup_uid" \
	--arg completed_at "$run_id" \
	'. + {
		schema: "rivet-fdb-cos-backup-restore-evidence/v1",
		foundationdb_backup_url: $backup_url,
		foundationdb_backup_uid: $backup_uid,
		foundationdb_source_disks_destroyed: true,
		branch_gc_logical_tombstone_verified: true,
		restored_cold_read_provenance: true,
		completed_at_utc: $completed_at
	}' "$cold_evidence" >"$receipt.tmp"
mv "$receipt.tmp" "$receipt"

printf '%s\n' "FDB_BACKUP_COLD_RESTORE_OK evidence=$receipt"
jq '{database_id, object_key, foundationdb_backup_uid, foundationdb_source_disks_destroyed, branch_gc_logical_tombstone_verified, restored_cold_read_provenance, retained}' "$receipt"
