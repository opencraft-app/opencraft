#!/bin/sh
set -eu

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "$script_dir/../.." && pwd)
compose_file="$script_dir/compose.yaml"
qualification_services="qfdb-0 qfdb-1 qfdb-2 qfdb-3 qfdb-4 qfdb-init"

bucket=${RIVET_TEST_S3_BUCKET:-}
endpoint=${RIVET_TEST_S3_ENDPOINT:-https://cos.ap-beijing.myqcloud.com}
region=${RIVET_TEST_S3_REGION:-ap-beijing}
evidence_dir=${RIVET_COS_EVIDENCE_DIR:-"$repo_root/.omx/qualification/cos"}
run_id=$(date -u +%Y%m%dT%H%M%SZ)
evidence_name="cos-cold-tier-$run_id.json"

require_env() {
	name=$1
	value=$(printenv "$name" 2>/dev/null || true)
	if [ -z "$value" ]; then
		echo "$name must be injected into the shell environment; do not store it in the repository" >&2
		exit 2
	fi
}

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

require_env AWS_ACCESS_KEY_ID
require_env AWS_SECRET_ACCESS_KEY
if [ -z "$bucket" ]; then
	echo "RIVET_TEST_S3_BUCKET must name the dedicated Beijing qualification/production-cell bucket" >&2
	exit 2
fi
case "$bucket" in
	actor-depot-cold-*-bj-*) ;;
	*)
		echo "refusing non-production bucket layout: expected actor-depot-cold-<env>-bj-<cell>-<APPID>" >&2
		exit 2
		;;
esac
if [ "$region" != ap-beijing ]; then
	echo "refusing non-Beijing COS region $region" >&2
	exit 2
fi
if ! command -v jq >/dev/null 2>&1; then
	echo "qualify-cos-cold-tier.sh requires jq" >&2
	exit 2
fi

mkdir -p "$evidence_dir"
evidence_dir=$(CDPATH= cd -- "$evidence_dir" && pwd)
evidence_file="$evidence_dir/$evidence_name"

docker compose -f "$compose_file" --profile qualification \
	rm --stop --force $qualification_services >/dev/null 2>&1 || true
docker compose -f "$compose_file" --profile qualification up --detach qfdb-init
wait_for_successful_exit qfdb-init

docker compose -f "$compose_file" --profile qualification run --rm --no-deps \
	--volume "$evidence_dir:/evidence" \
	-e AWS_ACCESS_KEY_ID \
	-e AWS_SECRET_ACCESS_KEY \
	-e AWS_SESSION_TOKEN \
	-e AWS_EC2_METADATA_DISABLED=true \
	-e "RIVET_TEST_S3_ENDPOINT=$endpoint" \
	-e "RIVET_TEST_S3_REGION=$region" \
	-e "RIVET_TEST_S3_BUCKET=$bucket" \
	-e RIVET_TEST_S3_ADDRESSING_STYLE=virtual \
	-e RIVET_TEST_S3_KEEP_OBJECT=1 \
	-e "RIVET_TEST_S3_EVIDENCE_FILE=/evidence/$evidence_name" \
	qualify \
	cargo test -p depot --features foundationdb,test-faults \
	--test cold_workflow_publish \
	foundationdb_s3_workflow_publishes_evicts_and_refills_by_exact_key -- --exact --nocapture

jq -e --arg bucket "$bucket" '
	.schema == "rivet-fdb-cos-cold-tier-evidence/v1" and
	.bucket == $bucket and
	.retained == true and
	.fdb_hot_evicted_before_read == true and
	.cold_read_provenance == true and
	.fdb_hot_refilled_after_read == true and
	(.object_key | test("^[0-9a-f]{4}/cold/v2/")) and
	(.object_sha256 | test("^[0-9a-f]{64}$"))
' "$evidence_file" >/dev/null

printf '%s\n' "COS_COLD_TIER_OK evidence=$evidence_file"
jq '{bucket, object_key, object_size_bytes, object_sha256, cos_storage_class, fdb_hot_evicted_before_read, cold_read_provenance, fdb_hot_refilled_after_read, retained}' "$evidence_file"
