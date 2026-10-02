#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
cell=${CELL:?CELL must name the exact qualification Cell}
namespace=${CELL_NAMESPACE:?CELL_NAMESPACE must name the exact qualification namespace}
cell_suffix=${cell##*-}
registry_host=${QUALIFICATION_TCR_HOST:-actor-fleet-beijing.tencentcloudcr.com}
state_dir=${QUALIFICATION_STATE_DIR:-/data/actor-qualification/${cell}/state}
resume_run_id=${ACTOR_QUALIFICATION_RUN_ID:-}
remote_source_link=${ACTOR_REVIEWED_SOURCE_LINK:-/var/lib/actor-build/deploy/actor-bj-q01-current}
image_inventory=${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY must name the reviewed product inventory}
qualification_actors=${ACTOR_QUALIFICATION_ACTORS:-1000}
qualification_probes=${ACTOR_QUALIFICATION_PROBES:-256}
qualification_concurrency=${ACTOR_QUALIFICATION_CONCURRENCY:-32}
qualification_batch_size=${ACTOR_QUALIFICATION_BATCH_SIZE:-32}
qualification_batch_settle_seconds=${ACTOR_QUALIFICATION_BATCH_SETTLE_SECONDS:-45}
qualification_operation_rate=${ACTOR_QUALIFICATION_OPERATION_RATE:-0}
qualification_max_idempotent_retries=${ACTOR_QUALIFICATION_MAX_IDEMPOTENT_RETRIES:-3}
qualification_retry_base_delay_seconds=${ACTOR_QUALIFICATION_RETRY_BASE_DELAY_SECONDS:-0.1}
loadgen_timeout_seconds=${ACTOR_LOADGEN_TIMEOUT_SECONDS:-7200}
tat_timeout_seconds=${ACTOR_QUALIFICATION_TAT_TIMEOUT_SECONDS:-14400}
[[ $remote_source_link == /var/lib/actor-build/deploy/actor-bj-q01-current ]] || {
	echo "Cell qualification accepts only the atomically promoted reviewed source link" >&2
	exit 2
}
[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ \
	&& $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "invalid Cell qualification identity" >&2
	exit 2
}
[[ -z $resume_run_id || ($resume_run_id =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ && ${#resume_run_id} -le 24) ]] || {
	echo "ACTOR_QUALIFICATION_RUN_ID is not a valid resumable qualification identity" >&2
	exit 2
}
for value in "$qualification_actors" "$qualification_probes" "$qualification_concurrency" \
	"$qualification_batch_size" "$loadgen_timeout_seconds" "$tat_timeout_seconds"; do
	[[ $value =~ ^[1-9][0-9]*$ ]] || {
		echo "qualification cardinality, concurrency and timeout values must be positive integers" >&2
		exit 2
	}
done
[[ $qualification_max_idempotent_retries =~ ^([0-9]|10)$ ]] || {
	echo "ACTOR_QUALIFICATION_MAX_IDEMPOTENT_RETRIES must be between 0 and 10" >&2
	exit 2
}
for value in "$qualification_batch_settle_seconds" "$qualification_operation_rate" \
	"$qualification_retry_base_delay_seconds"; do
	[[ $value =~ ^([0-9]+)(\.[0-9]+)?$ ]] || {
		echo "qualification timing values must be non-negative numbers" >&2
		exit 2
	}
done
if ! python3 - "$qualification_actors" "$qualification_probes" "$qualification_concurrency" \
	"$qualification_batch_size" "$qualification_batch_settle_seconds" \
	"$qualification_operation_rate" "$qualification_retry_base_delay_seconds" \
	"$loadgen_timeout_seconds" "$tat_timeout_seconds" <<'PY'
import sys

(actors, probes, concurrency, batch_size, settle, rate, retry_delay,
 loadgen_timeout, tat_timeout) = map(float, sys.argv[1:])
if not (1 <= actors <= 1_000_000 and 1 <= probes <= actors):
    raise SystemExit("qualification Actor cardinality is outside the supported envelope")
if not (1 <= concurrency <= 256 and 1 <= batch_size <= 4096):
    raise SystemExit("qualification concurrency or batch size is outside the supported envelope")
if not (0 <= settle <= 300 and 0 <= rate <= 1000 and 0 < retry_delay <= 5):
    raise SystemExit("qualification pacing is outside the supported envelope")
if not (300 <= loadgen_timeout <= 86400 and 14400 <= tat_timeout <= 86400):
    raise SystemExit("qualification timeout is outside the supported envelope")
PY
then
	exit 2
fi
[[ $image_inventory == /* && -f $image_inventory && ! -L $image_inventory ]] || {
	echo "ACTOR_IMAGE_INVENTORY must be an absolute, non-symlink regular file" >&2
	exit 2
}
loadgen_image=$(jq -er '.images[] | select(.repository == "actor-loadgen") | .ref' "$image_inventory")
recovery_kubectl_image=$(jq -er '.images[] | select(.repository == "observability-kubectl") | .ref' "$image_inventory")
recovery_busybox_image=$(jq -er '.images[] | select(.repository == "observability-busybox") | .ref' "$image_inventory")
[[ $loadgen_image =~ ^${registry_host//./\.}/actor-fleet/actor-loadgen@sha256:[0-9a-f]{64}$ ]] || {
	echo "product inventory does not bind the immutable regional actor-loadgen image" >&2
	exit 2
}
for recovery_image in "$recovery_kubectl_image" "$recovery_busybox_image"; do
	[[ $recovery_image =~ ^${registry_host//./\.}/actor-fleet/[a-z0-9-]+@sha256:[0-9a-f]{64}$ ]] || {
		echo "product inventory does not bind an immutable regional Argo recovery image" >&2
		exit 2
	}
done
for variable in TENCENTCLOUD_SECRET_ID TENCENTCLOUD_SECRET_KEY TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || { echo "$variable must be supplied through the protected environment" >&2; exit 2; }
done

[[ $registry_host =~ ^[a-z0-9.-]+\.tencentcloudcr\.com$ ]]
install -d -m 0700 "$state_dir"
temporary=$(mktemp -d "$state_dir/fdb-autoscaling.XXXXXX")
chmod 0700 "$temporary"
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT INT TERM
printf -v quoted_loadgen_image '%q' "$loadgen_image"
printf -v quoted_recovery_kubectl_image '%q' "$recovery_kubectl_image"
printf -v quoted_recovery_busybox_image '%q' "$recovery_busybox_image"
printf -v quoted_resume_run_id '%q' "$resume_run_id"
printf -v quoted_qualification_actors '%q' "$qualification_actors"
printf -v quoted_qualification_probes '%q' "$qualification_probes"
printf -v quoted_qualification_concurrency '%q' "$qualification_concurrency"
printf -v quoted_qualification_batch_size '%q' "$qualification_batch_size"
printf -v quoted_qualification_batch_settle_seconds '%q' "$qualification_batch_settle_seconds"
printf -v quoted_qualification_operation_rate '%q' "$qualification_operation_rate"
printf -v quoted_qualification_max_idempotent_retries '%q' "$qualification_max_idempotent_retries"
printf -v quoted_qualification_retry_base_delay_seconds '%q' "$qualification_retry_base_delay_seconds"
printf -v quoted_loadgen_timeout_seconds '%q' "$loadgen_timeout_seconds"

set +e
tat_output="$temporary/tat-output.log"
"$fleet_dir/tat/tat-run.sh" --name "${cell_suffix}-fdb-autoscaling-qualification" --timeout "$tat_timeout_seconds" <<REMOTE | tee "$tat_output"
set -euo pipefail
operations_env=/etc/actor/rivet-autonomy-audit.env
[[ -f \$operations_env && ! -L \$operations_env ]]
# The clean-room builder has no stable, convention-derived kubeconfig path.
# Consume the exact path already installed by the Cell bootstrap and reject a
# stale/cross-Cell operations inventory before issuing the first kubectl call.
# shellcheck disable=SC1090
source "\$operations_env"
[[ \${CELL:?} == $cell && \${CELL_NAMESPACE:?} == $namespace ]]
[[ \${KUBECONFIG_PATH:?} == /* && -f \$KUBECONFIG_PATH && ! -L \$KUBECONFIG_PATH ]]
export CELL CELL_NAMESPACE
export KUBECONFIG=\$KUBECONFIG_PATH
export ACTOR_FDB_PROFILE=${ACTOR_FDB_PROFILE:-rivet-fdb-operator-cbs-beijing-v1}
export ACTOR_SHARD_CLASS=${ACTOR_SHARD_CLASS:-rivet-fdb-cos-kubernetes-v1}
export ACTOR_LOADGEN_IMAGE=$quoted_loadgen_image
export ACTOR_QUALIFICATION_ARGO_NAMESPACE=argocd
export ACTOR_QUALIFICATION_ARGO_APPLICATION=actor-cell-control-${cell_suffix}
export ACTOR_QUALIFICATION_ARGO_RECOVERY_SERVICE_ACCOUNT=actor-fdb-autoscaling-recovery
export ACTOR_QUALIFICATION_ARGO_RECOVERY_KUBECTL_IMAGE=$quoted_recovery_kubectl_image
export ACTOR_QUALIFICATION_ARGO_RECOVERY_BUSYBOX_IMAGE=$quoted_recovery_busybox_image
export ACTOR_QUALIFICATION_REGISTRY_HOST=$registry_host
export ACTOR_QUALIFICATION_ACTORS=$quoted_qualification_actors
export ACTOR_QUALIFICATION_PROBES=$quoted_qualification_probes
export ACTOR_QUALIFICATION_CONCURRENCY=$quoted_qualification_concurrency
export ACTOR_QUALIFICATION_BATCH_SIZE=$quoted_qualification_batch_size
export ACTOR_QUALIFICATION_BATCH_SETTLE_SECONDS=$quoted_qualification_batch_settle_seconds
export ACTOR_QUALIFICATION_OPERATION_RATE=$quoted_qualification_operation_rate
export ACTOR_QUALIFICATION_MAX_IDEMPOTENT_RETRIES=$quoted_qualification_max_idempotent_retries
export ACTOR_QUALIFICATION_RETRY_BASE_DELAY_SECONDS=$quoted_qualification_retry_base_delay_seconds
export ACTOR_LOADGEN_TIMEOUT_SECONDS=$quoted_loadgen_timeout_seconds
resume_run_id=$quoted_resume_run_id
if [[ -n \$resume_run_id ]]; then
  export ACTOR_QUALIFICATION_RUN_ID=\$resume_run_id
  export ACTOR_AUTOSCALING_RECEIPT=/data/actor-qualification/receipts/${cell}-fdb-autoscaling-\${resume_run_id}-resume-\$(date -u +%s).json
fi
source_link=$remote_source_link
source_root=\$(readlink -e "\$source_link")
[[ \$source_root =~ ^/var/lib/actor-build/deploy/q01-src-([0-9a-f]{40})-([0-9a-f]{64})\$ ]]
expected_revision=\${BASH_REMATCH[1]}
expected_manifest_sha=\${BASH_REMATCH[2]}
source_revision=\$(tr -d '[:space:]' <"\$source_root/.actor-source/SOURCE_REVISION")
source_manifest="\$source_root/.actor-source/RELEASE_SHA256SUMS"
[[ -s \$source_manifest ]]
source_manifest_sha=\$(sha256sum "\$source_manifest" | cut -d' ' -f1)
[[ \$source_revision == "\$expected_revision" && \$source_manifest_sha == "\$expected_manifest_sha" ]]
"\$source_root/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/run-fdb-autoscaling-qualification.sh"
REMOTE
status=$?
set -e

remote_receipt=$(grep -E "^autoscaling_receipt=/data/actor-qualification/receipts/${cell}-fdb-autoscaling-[a-z0-9-]+\\.json$" "$tat_output" | tail -n 1 | cut -d= -f2- || true)
download_status=0
if [[ -n $remote_receipt ]]; then
	local_receipt=${ACTOR_FDB_AUTOSCALING_LOCAL_RECEIPT:-$remote_receipt}
	[[ $local_receipt =~ ^/data/[A-Za-z0-9._/-]+\.json$ && $local_receipt != *'/../'* ]]
	install -d -m 0700 "$(dirname -- "$local_receipt")"
	if [[ -e $local_receipt ]]; then
		echo "local autoscaling receipt already exists: $local_receipt" >&2
		download_status=1
	else
		"$script_dir/relay-download-from-builder.sh" "$remote_receipt" "$local_receipt" || download_status=$?
	fi
else
	echo "qualification produced no retrievable autoscaling receipt" >&2
	download_status=1
fi
if ((download_status != 0)); then
	exit "$download_status"
fi
printf 'autoscaling_local_receipt=%s\n' "$local_receipt"
exit "$status"
