#!/usr/bin/env bash
set -euo pipefail

usage() {
	echo "Usage: run-user-transparent-upgrade-on-builder.sh RUNTIME_IMAGE RUNTIME_SOURCE_REVISION RUNTIME_SOURCE_MANIFEST_SHA256 REPORTER_IMAGE REPORTER_SOURCE_REVISION REPORTER_SOURCE_MANIFEST_SHA256 RUN_ID [FAILED_RELEASE_RECEIPT]" >&2
}
[[ $# -eq 7 || $# -eq 8 ]] || { usage; exit 2; }
runtime_image=$1
runtime_revision=$2
runtime_manifest=$3
reporter_image=$4
reporter_revision=$5
reporter_manifest=$6
run_id=$7
failed_release_receipt=${8:-}
qualification_candidate_receipt=${ACTOR_QUALIFICATION_CANDIDATE_RECEIPT:-}
[[ $runtime_image =~ ^([A-Za-z0-9][A-Za-z0-9._:-]*(/[A-Za-z0-9._-]+)+)/rivet-runtime@sha256:[0-9a-f]{64}$ ]]
registry=${BASH_REMATCH[1]}
reporter_digest=${reporter_image#"$registry/actor-fleet-controller@sha256:"}
[[ $reporter_image == "$registry/actor-fleet-controller@sha256:$reporter_digest" &&
   $reporter_digest =~ ^[0-9a-f]{64}$ ]]
[[ $runtime_revision =~ ^[0-9a-f]{40}$ && $runtime_manifest =~ ^[0-9a-f]{64}$ ]]
[[ $reporter_revision =~ ^[0-9a-f]{40}$ && $reporter_manifest =~ ^[0-9a-f]{64}$ ]]
[[ $run_id =~ ^[0-9a-f]{32}$ ]]
if [[ -n $failed_release_receipt ]]; then
	[[ $failed_release_receipt == "/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-${run_id}.json" ]]
fi
if [[ -n $qualification_candidate_receipt ]]; then
	[[ -z $failed_release_receipt && $qualification_candidate_receipt == /data/actor-qualification/receipts/actor-bj-q01-semantic-failure-candidate-*.json ]]
	jq -e --arg image "$runtime_image" --arg revision "$runtime_revision" --arg manifest "$runtime_manifest" '
      .schema == "actor-bj-q01-semantic-failure-candidate/v1" and
      .verdict == "passed" and .intentionallyNotProduction == true and
      .candidateRuntimeImage == $image and .sourceRevision == $revision and
      .candidateSourceManifestSHA256 == $manifest
    ' "$qualification_candidate_receipt" >/dev/null
fi

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
operations_dir=$(CDPATH= cd -- "$script_dir/../../operations" && pwd)
if [[ -n $failed_release_receipt ]]; then
	receipt=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-rollback-${run_id}.json
	receipt_kind=rollback
else
	receipt=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-${run_id}.json
	receipt_kind=upgrade
fi
receipt_file_identity=$(stat -Lc '%d:%i' "$receipt" 2>/dev/null || true)
emit_command_result() {
	local command_status=$? emit_status=0
	trap - EXIT
	set +e
	# A compact Hook result is not the evidence itself. Preserve each newly
	# produced terminal report outside the replaceable operator before success
	# can be reported. This also preserves failed candidates needed by SyncFail.
	if [[ -f $receipt && $(stat -Lc '%d:%i' "$receipt") != "$receipt_file_identity" ]]; then
		CELL=actor-bj-q01 CELL_NAMESPACE=actor-fdb-cell-system \
		KUBECONFIG_PATH=/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig \
			"$script_dir/../../operations/cache-qualification-receipt.sh" "$receipt"
		if (($? != 0)); then
			echo "complete release receipt was not persisted outside the operator" >&2
			((command_status != 0)) || command_status=70
		fi
	fi
	python3 "$script_dir/approved-command-result.py" emit \
		--phase "$receipt_kind" --run-id "$run_id" --receipt "$receipt" \
		--exit-code "$command_status" \
		--previous-file-identity "$receipt_file_identity" || emit_status=$?
	if ((emit_status != 0)); then
		echo "approved command compact result emission failed" >&2
		((command_status != 0)) || command_status=70
	fi
	exit "$command_status"
}
trap emit_command_result EXIT

export KUBECONFIG=/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig
source_link=/var/lib/actor-build/deploy/actor-bj-q01-current
source=$(readlink -e "${ACTOR_CONTROL_SOURCE:-$source_link}")
[[ $source =~ ^/var/lib/actor-build/deploy/q01-src-([0-9a-f]{40})-([0-9a-f]{64})$ ]]
expected_revision=${BASH_REMATCH[1]}
expected_manifest=${BASH_REMATCH[2]}
source_revision=$(tr -d '[:space:]' <"$source/.actor-source/SOURCE_REVISION")
source_manifest=$(sha256sum "$source/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)
[[ $source_revision == "$expected_revision" && $source_manifest == "$expected_manifest" ]]

image_inventory=${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY must name the complete reviewed image inventory}
[[ $image_inventory == /var/lib/actor-build/inventories/*.lock.json && -f $image_inventory && ! -L $image_inventory ]] || {
	echo "ACTOR_IMAGE_INVENTORY must be an immutable builder inventory path" >&2
	exit 2
}
cold_bucket=${RIVET_COLD_BUCKET:?RIVET_COLD_BUCKET must name the exact q01 cold bucket}
[[ $cold_bucket =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]]
image_lock=$source/infra/cells/deploy/tencent/fleet/gitops/image-seed/image-lock.py
python3 "$image_lock" validate-inventory --lock "$image_inventory" >/dev/null
resolve_image() {
	python3 "$image_lock" resolve --lock "$image_inventory" --repository "$1"
}
[[ $(resolve_image actor-fleet-controller) == "$reporter_image" ]]

# The inventory remains pinned to the last qualified Runtime throughout an
# intentional semantic-failure exercise so the paired rollback command has a
# stable authority. The shared binding helper admits the candidate only when
# its receipt binds that qualified base and both source manifests.
export ACTOR_IMAGE_INVENTORY="$image_inventory"
export ACTOR_IMAGE_LOCK_TOOL="$image_lock"
export RIVET_RUNTIME_IMAGE="$runtime_image"
export RIVET_SOURCE_REVISION="$runtime_revision"
export RIVET_SOURCE_MANIFEST_SHA256="$runtime_manifest"
if [[ -n $qualification_candidate_receipt ]]; then
	export AUTONOMY_CONTROL_QUALIFICATION_CANDIDATE_RECEIPT="$qualification_candidate_receipt"
fi
# shellcheck source=../../gitops/image-seed/bind-inventory.sh
source "$source/infra/cells/deploy/tencent/fleet/gitops/image-seed/bind-inventory.sh"
actor_image_inventory_require
actor_image_inventory_bind_runtime_release \
	RIVET_RUNTIME_IMAGE RIVET_SOURCE_REVISION RIVET_SOURCE_MANIFEST_SHA256 rivet-runtime

# The immutable runtime source binds the requested image provenance. The
# reviewed control source owns the current renderer and transaction protocol.
# It renders the exact candidate configuration and validate-runtime-image.sh
# executes the requested (including rollback) image against that configuration
# before changing Kubernetes, so an older binary with an incompatible schema
# fails before rollout. This lets fixes to release safety/provenance apply to a
# rollback without mutating or executing an obsolete release orchestrator.
runtime_source=/var/lib/actor-build/deploy/q01-src-${runtime_revision}-${runtime_manifest}
[[ -d $runtime_source ]]
[[ $(tr -d '[:space:]' <"$runtime_source/.actor-source/SOURCE_REVISION") == "$runtime_revision" ]]
[[ $(sha256sum "$runtime_source/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$runtime_manifest" ]]
runtime_release_script=$source/infra/cells/deploy/tencent/fleet/runtime/release-runtime.sh
[[ -x $runtime_release_script ]]

namespace=actor-fdb-cell-system
cell=actor-bj-q01
capacity=$cell-runtime-capacity
nats_image=$(resolve_image nats)
metrics_image=$(resolve_image observability-busybox)
registry_url=$(kubectl -n "$namespace" get statefulset "$cell-runtime-hosts" -o jsonpath='{.spec.template.spec.containers[?(@.name=="workerd-host")].env[?(@.name=="RIVET_WORKER_REGISTRY_URL")].value}')
exact_scale_down=$(kubectl -n "$namespace" get deployment "$capacity" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RUNTIME_EXACT_SCALE_DOWN_ENABLED")].value}')
tke_cluster=$(kubectl -n "$namespace" get deployment "$capacity" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RUNTIME_TKE_CLUSTER_ID")].value}')
tke_role=$(kubectl -n "$namespace" get deployment "$capacity" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="TKE_ROLE_ARN")].value}')
[[ $nats_image =~ @sha256:[0-9a-f]{64}$ && $metrics_image =~ @sha256:[0-9a-f]{64}$ ]]
[[ $registry_url == http://actor-bj-q01-worker-registry:8080 ]]
[[ $exact_scale_down == true && $tke_cluster == cls-ike1rebd ]]
[[ $tke_role == qcs::cam::uin/100045199955:roleName/actor-bj-q01-runtime-scale-down ]]

allow_degrade=0
if [[ -n $qualification_candidate_receipt ]]; then
	allow_degrade=1
	echo "intentional semantic-failure qualification authorized: receipt=$qualification_candidate_receipt"
fi
if [[ -n $failed_release_receipt ]]; then
	live_engine=$(kubectl -n "$namespace" get deployment "$cell-engine" -o jsonpath='{.spec.template.spec.containers[0].image}')
	live_runtime=$(kubectl -n "$namespace" get statefulset "$cell-runtime-hosts" -o jsonpath='{.spec.template.spec.containers[0].image}')
	python3 "$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/verify-failed-release-rollback.py" \
		"$failed_release_receipt" "$runtime_image" "$live_engine" "$live_runtime"
	allow_degrade=1
	export AUTONOMY_CONTROL_QUALIFICATION_ROLLBACK_RECEIPT="$failed_release_receipt"
	echo "failed-release rollback authorized: receipt=$failed_release_receipt target=$runtime_image"
fi

export RIVET_CELL_NAMESPACE="$namespace"
export RIVET_CELL_NAME="$cell"
export RIVET_RUNTIME_PROFILE=production
export RIVET_GASOLINE_STORAGE_PROFILE_ENFORCE=1
export ACTOR_IMAGE_INVENTORY="$image_inventory"
export RIVET_COLD_BUCKET="$cold_bucket"
export RIVET_SOURCE_REVISION="$runtime_revision"
export RIVET_SOURCE_MANIFEST_SHA256="$runtime_manifest"
export RIVET_REPORTER_SOURCE_REVISION="$reporter_revision"
export RIVET_REPORTER_SOURCE_MANIFEST_SHA256="$reporter_manifest"
export RIVET_RUNTIME_IMAGE="$runtime_image"
export RIVET_REPORTER_IMAGE="$reporter_image"
export RIVET_NATS_IMAGE="$nats_image"
export RIVET_WORKERD_METRICS_IMAGE="$metrics_image"
export RIVET_WORKER_REGISTRY_URL="$registry_url"
export RUNTIME_EXACT_SCALE_DOWN_ENABLED="$exact_scale_down"
export RUNTIME_TKE_CLUSTER_ID="$tke_cluster"
export RUNTIME_TKE_OIDC_ROLE_ARN="$tke_role"
# q01's bounded autoscaling qualification owns these fields under this exact
# manager. Continue that single ownership lineage during release instead of
# silently stealing it with the generic production manager. The qualification
# Cell has a reviewed 30-Host ceiling matching its provider envelope; the
# generic 301-Host default is intentionally not applicable here.
export RUNTIME_AUTOSCALING_FIELD_MANAGER=actor-q01-autoscaling
export RUNTIME_CAPACITY_MIN_REPLICAS=3
export RUNTIME_CAPACITY_MAX_REPLICAS=30
export RUNTIME_CAPACITY_TARGET_ACTIVE_ACTORS=16
export AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1
live_reporter=$(kubectl -n "$namespace" get deployment "$cell-cell-reporter" -o jsonpath='{.spec.template.spec.containers[0].image}')
live_release_ledger=$(kubectl -n "$namespace" get configmap "$cell-release-ledger" --ignore-not-found -o name)
# A pre-ledger Cell needs the same narrow static-release authorization even
# when its observer was bootstrapped to the target image first.  The policy
# still proves that the ledger is absent, that missing-ledger is the sole
# static drift, and that every live topology/health invariant is green.
if [[ $reporter_image != "$live_reporter" || -z $live_release_ledger ]]; then
	export AUTONOMY_CONTROL_ALLOW_STATIC_RELEASE_RECOVERY=1
fi
export AUTONOMY_CONTROL_ALLOW_DEGRADE="$allow_degrade"
if [[ -n $qualification_candidate_receipt ]]; then
	export AUTONOMY_CONTROL_QUALIFICATION_CANDIDATE_RECEIPT="$qualification_candidate_receipt"
fi
export RIVET_RELEASE_RECEIPT_DIR=/data/actor-qualification/receipts

if [[ -n $failed_release_receipt ]]; then
	release_log=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-rollback-${run_id}.release.log
	AUTONOMY_OPERATION_LOCK_WAIT_SECONDS=120 \
	"$operations_dir/with-autonomy-operation-lock.sh" -- \
	"$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/user-transparent-rollback.py" \
		--kubeconfig "$KUBECONFIG" \
		--release-script "$runtime_release_script" \
		--failed-receipt "$failed_release_receipt" \
		--receipt "$receipt" --release-log "$release_log"
	python3 "$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/verify-user-transparent-rollback.py" \
		"$receipt" "$failed_release_receipt" --expected-runtime-image "$runtime_image"
else
	release_log=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-${run_id}.release.log
	AUTONOMY_OPERATION_LOCK_WAIT_SECONDS=120 \
	"$operations_dir/with-autonomy-operation-lock.sh" -- \
	"$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/user-transparent-upgrade.py" \
		--kubeconfig "$KUBECONFIG" \
		--release-script "$runtime_release_script" \
		--receipt "$receipt" --release-log "$release_log"
	python3 "$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/verify-user-transparent-upgrade.py" \
		"$receipt" --expected-runtime-image "$runtime_image"
fi
