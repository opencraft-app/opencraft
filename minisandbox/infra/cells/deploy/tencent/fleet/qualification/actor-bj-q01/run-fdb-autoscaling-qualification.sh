#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
source_root=${ACTOR_SOURCE_DIR:-$(CDPATH= cd -- "$fleet_dir/../../../../.." && pwd)}
source_identity_dir="$source_root/.actor-source"
cell=${CELL:?CELL must name the exact qualification Cell}
namespace=${CELL_NAMESPACE:?CELL_NAMESPACE must name the exact qualification namespace}
profile=${ACTOR_FDB_PROFILE:-rivet-fdb-operator-cbs-beijing-v1}
shard_class=${ACTOR_SHARD_CLASS:-rivet-fdb-cos-kubernetes-v1}
machine_set=${ACTOR_FDB_MACHINESET:-np-fdbpool0}
cell_suffix=${cell##*-}
source_revision=${ACTOR_QUALIFICATION_SOURCE_REVISION:-}
source_manifest=${ACTOR_QUALIFICATION_SOURCE_MANIFEST_FILE:-}
if [[ -z $source_revision && -s $source_identity_dir/SOURCE_REVISION ]]; then
	source_revision=$(tr -d '[:space:]' <"$source_identity_dir/SOURCE_REVISION")
fi
if [[ -z $source_manifest && -s $source_identity_dir/RELEASE_SHA256SUMS ]]; then
	source_manifest="$source_identity_dir/RELEASE_SHA256SUMS"
fi
run_id=${ACTOR_QUALIFICATION_RUN_ID:-${cell_suffix}-$(python3 -c 'import uuid; print(uuid.uuid4().hex[:16])')}
registry=${ACTOR_QUALIFICATION_REGISTRY:-actor-fleet-beijing.tencentcloudcr.com/actor-fleet}
auth_file=${REGISTRY_AUTH_FILE:-/var/lib/actor-build/credentials/${cell}-tcr-config.json}
build_result=${ACTOR_LOADGEN_BUILD_RESULT:-/data/build-cache/${cell}-loadgen/${run_id}.log}
product_receipt=${ACTOR_PRODUCT_BUILD_RECEIPT:-/data/actor-qualification/builds/product-actor-loadgen-${source_revision}-${run_id}.json}

[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ \
	&& $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
	&& $profile =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
	&& $shard_class =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
	&& $machine_set =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
	&& $source_revision =~ ^[0-9a-f]{40}$ && -s $source_manifest \
	&& $run_id =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#run_id} -le 24 ]] || {
	echo "Cell qualification identity is invalid; apply a reviewed source bundle or provide explicit source identity overrides" >&2
	exit 2
}
source_manifest=$(CDPATH= cd -- "$(dirname -- "$source_manifest")" && pwd)/$(basename -- "$source_manifest")
(
	cd "$source_root"
	sha256sum --check "$source_manifest" >/dev/null
)
mkdir -p "$(dirname -- "$build_result")" "$(dirname -- "$product_receipt")" /data/actor-qualification/receipts

if [[ -n ${ACTOR_LOADGEN_IMAGE:-} ]]; then
	loadgen_image=$ACTOR_LOADGEN_IMAGE
else
	tag="$registry/actor-loadgen:${cell_suffix}-${source_revision:0:12}-${run_id}"
	ACTOR_SOURCE_DIR="$source_root" \
	ACTOR_LOADGEN_IMAGE_TAG="$tag" \
	ACTOR_SOURCE_REVISION="$source_revision" \
	ACTOR_SOURCE_MANIFEST_FILE="$source_manifest" \
	ACTOR_PRODUCT_BUILD_RECEIPT="$product_receipt" \
	REGISTRY_AUTH_FILE="$auth_file" \
		"$fleet_dir/loadgen/build-image.sh" | tee "$build_result"
	loadgen_image=$(grep -E '^.+@sha256:[0-9a-f]{64}$' "$build_result" | tail -n 1)
fi
[[ $loadgen_image =~ @sha256:[0-9a-f]{64}$ ]] || {
	echo "loadgen publication did not return an immutable registry digest" >&2
	exit 1
}

export ACTOR_CELL_NAME="$cell"
export ACTOR_CELL_NAMESPACE="$namespace"
export ACTOR_FDB_PROFILE="$profile"
export ACTOR_SHARD_CLASS="$shard_class"
export ACTOR_FDB_MACHINESET="$machine_set"
export ACTOR_QUALIFICATION_RUN_ID="$run_id"
export ACTOR_LOADGEN_IMAGE="$loadgen_image"
export ACTOR_QUALIFICATION_REGISTRY_HOST=${ACTOR_QUALIFICATION_REGISTRY_HOST:-${registry%%/*}}
export ACTOR_QUALIFICATION_ACTORS=${ACTOR_QUALIFICATION_ACTORS:-1000}
export ACTOR_QUALIFICATION_PROBES=${ACTOR_QUALIFICATION_PROBES:-256}
export ACTOR_QUALIFICATION_CONCURRENCY=${ACTOR_QUALIFICATION_CONCURRENCY:-32}
export ACTOR_QUALIFICATION_BATCH_SIZE=${ACTOR_QUALIFICATION_BATCH_SIZE:-32}
export ACTOR_QUALIFICATION_BATCH_SETTLE_SECONDS=${ACTOR_QUALIFICATION_BATCH_SETTLE_SECONDS:-45}
export ACTOR_QUALIFICATION_OPERATION_RATE=${ACTOR_QUALIFICATION_OPERATION_RATE:-0}
export ACTOR_QUALIFICATION_MAX_IDEMPOTENT_RETRIES=${ACTOR_QUALIFICATION_MAX_IDEMPOTENT_RETRIES:-3}
export ACTOR_QUALIFICATION_RETRY_BASE_DELAY_SECONDS=${ACTOR_QUALIFICATION_RETRY_BASE_DELAY_SECONDS:-0.1}
export ACTOR_LOADGEN_API_MODE=workers-v1
export ACTOR_LOADGEN_WORKERS_URL=${ACTOR_LOADGEN_WORKERS_URL:-http://${cell}-workers-api:8080}
export ACTOR_LOADGEN_WORKER_NAME=${ACTOR_LOADGEN_WORKER_NAME:-${cell_suffix}-fdb-autoscale-gate}
export ACTOR_LOADGEN_CLASS_NAME=Agent
export ACTOR_AUTOSCALING_RECEIPT=${ACTOR_AUTOSCALING_RECEIPT:-/data/actor-qualification/receipts/${cell}-fdb-autoscaling-${run_id}.json}
export ACTOR_QUALIFICATION_SOURCE_REVISION="$source_revision"
export ACTOR_QUALIFICATION_SOURCE_MANIFEST_SHA256
ACTOR_QUALIFICATION_SOURCE_MANIFEST_SHA256=$(sha256sum "$source_manifest" | cut -d' ' -f1)
export AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=${AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY:-1}

"$fleet_dir/autoscaling/qualify.sh"
python3 "$fleet_dir/autoscaling/verify_receipt.py" "$ACTOR_AUTOSCALING_RECEIPT"
