#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM

mkdir -p "$temporary/fleet/qualification/actor-bj-q01" "$temporary/fleet/tat"
cp "$script_dir/run-fdb-autoscaling-via-tat.sh" \
	"$temporary/fleet/qualification/actor-bj-q01/run-fdb-autoscaling-via-tat.sh"
cat >"$temporary/fleet/tat/tat-run.sh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >"$MOCK_TAT_ARGS"
cat >"$MOCK_TAT_PAYLOAD"
MOCK
chmod 0700 "$temporary/fleet/tat/tat-run.sh"

cat >"$temporary/images.json" <<'JSON'
{
  "images": [
    {"repository":"actor-loadgen","ref":"actor-fleet-beijing.tencentcloudcr.com/actor-fleet/actor-loadgen@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"},
    {"repository":"observability-kubectl","ref":"actor-fleet-beijing.tencentcloudcr.com/actor-fleet/observability-kubectl@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"},
    {"repository":"observability-busybox","ref":"actor-fleet-beijing.tencentcloudcr.com/actor-fleet/observability-busybox@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"}
  ]
}
JSON

export CELL=actor-bj-a01
export CELL_NAMESPACE=actor-fdb-cell-system
export ACTOR_IMAGE_INVENTORY="$temporary/images.json"
export QUALIFICATION_STATE_DIR="$temporary/state"
export TENCENTCLOUD_SECRET_ID=test-id
export TENCENTCLOUD_SECRET_KEY=test-key
export TAT_INSTANCE_ID=ins-test
export MOCK_TAT_ARGS="$temporary/tat.args"
export MOCK_TAT_PAYLOAD="$temporary/tat.payload"
export ACTOR_QUALIFICATION_ACTORS=1000000
export ACTOR_QUALIFICATION_PROBES=10000
export ACTOR_QUALIFICATION_CONCURRENCY=64
export ACTOR_QUALIFICATION_BATCH_SIZE=1024
export ACTOR_QUALIFICATION_BATCH_SETTLE_SECONDS=0
export ACTOR_QUALIFICATION_OPERATION_RATE=100
export ACTOR_QUALIFICATION_MAX_IDEMPOTENT_RETRIES=8
export ACTOR_QUALIFICATION_RETRY_BASE_DELAY_SECONDS=0.2
export ACTOR_LOADGEN_TIMEOUT_SECONDS=21600
export ACTOR_QUALIFICATION_TAT_TIMEOUT_SECONDS=86400

set +e
"$temporary/fleet/qualification/actor-bj-q01/run-fdb-autoscaling-via-tat.sh" \
	>"$temporary/stdout" 2>"$temporary/stderr"
status=$?
set -e
[[ $status == 1 ]]
grep -Fq -- '--timeout 86400' "$temporary/tat.args"
for expected in \
	'export ACTOR_QUALIFICATION_ACTORS=1000000' \
	'export ACTOR_QUALIFICATION_PROBES=10000' \
	'export ACTOR_QUALIFICATION_CONCURRENCY=64' \
	'export ACTOR_QUALIFICATION_BATCH_SIZE=1024' \
	'export ACTOR_QUALIFICATION_BATCH_SETTLE_SECONDS=0' \
	'export ACTOR_QUALIFICATION_OPERATION_RATE=100' \
	'export ACTOR_QUALIFICATION_MAX_IDEMPOTENT_RETRIES=8' \
	'export ACTOR_QUALIFICATION_RETRY_BASE_DELAY_SECONDS=0.2' \
	'export ACTOR_LOADGEN_TIMEOUT_SECONDS=21600'; do
	grep -Fq "$expected" "$temporary/tat.payload"
done
grep -Fq 'qualification produced no retrievable autoscaling receipt' "$temporary/stderr"

rm -f "$temporary/tat.args" "$temporary/tat.payload"
export ACTOR_QUALIFICATION_ACTORS=1000001
set +e
"$temporary/fleet/qualification/actor-bj-q01/run-fdb-autoscaling-via-tat.sh" \
	>"$temporary/invalid.stdout" 2>"$temporary/invalid.stderr"
status=$?
set -e
[[ $status == 2 ]]
[[ ! -e $temporary/tat.args && ! -e $temporary/tat.payload ]]
grep -Fq 'qualification Actor cardinality is outside the supported envelope' "$temporary/invalid.stderr"

echo "run_fdb_autoscaling_via_tat_tests=passed"
