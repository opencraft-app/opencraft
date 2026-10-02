#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
usage() {
	echo "Usage: run-user-transparent-upgrade-via-tat.sh RUNTIME_IMAGE RUNTIME_SOURCE_REVISION RUNTIME_SOURCE_MANIFEST_SHA256 REPORTER_IMAGE REPORTER_SOURCE_REVISION REPORTER_SOURCE_MANIFEST_SHA256 [FAILED_RELEASE_RECEIPT]" >&2
}
[[ $# -eq 6 || $# -eq 7 ]] || { usage; exit 2; }
runtime_image=$1
runtime_revision=$2
runtime_manifest=$3
reporter_image=$4
reporter_revision=$5
reporter_manifest=$6
failed_release_receipt=${7:-}
[[ $runtime_image =~ ^([A-Za-z0-9][A-Za-z0-9._:-]*(/[A-Za-z0-9._-]+)+)/rivet-runtime@sha256:[0-9a-f]{64}$ ]]
registry=${BASH_REMATCH[1]}
reporter_digest=${reporter_image#"$registry/actor-fleet-controller@sha256:"}
[[ $reporter_image == "$registry/actor-fleet-controller@sha256:$reporter_digest" &&
   $reporter_digest =~ ^[0-9a-f]{64}$ ]]
[[ $runtime_revision =~ ^[0-9a-f]{40}$ && $runtime_manifest =~ ^[0-9a-f]{64}$ ]]
[[ $reporter_revision =~ ^[0-9a-f]{40}$ && $reporter_manifest =~ ^[0-9a-f]{64}$ ]]
if [[ -n $failed_release_receipt ]]; then
	[[ $failed_release_receipt =~ ^/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-[0-9a-f]{32}\.json$ ]] || {
		echo "FAILED_RELEASE_RECEIPT is not a bounded q01 upgrade receipt" >&2
		exit 2
	}
fi
provenance_args=()
if [[ -n ${RIVET_RELEASE_ORCHESTRATOR:-} ]]; then
	provenance_args=(
		--orchestrator "$RIVET_RELEASE_ORCHESTRATOR"
		--application "${RIVET_RELEASE_APPLICATION:-}"
		--application-namespace "${RIVET_RELEASE_APPLICATION_NAMESPACE:-}"
		--hook-job "${RIVET_RELEASE_HOOK_JOB:-}"
		--hook-phase "${RIVET_RELEASE_HOOK_PHASE:-}"
		--release-attempt "${RIVET_RELEASE_ATTEMPT:-}"
		--pod-namespace "${RIVET_RELEASE_POD_NAMESPACE:-}"
		--pod-name "${RIVET_RELEASE_POD_NAME:-}"
		--pod-uid "${RIVET_RELEASE_POD_UID:-}"
	)
fi
for variable in TAT_INSTANCE_ID; do
	[[ -n ${!variable:-} ]] || { echo "$variable must be supplied through the protected environment" >&2; exit 2; }
done
image_inventory=
cold_bucket=
nats_image=
metrics_image=
inventory_sha=
inventory_bytes=
inventory_base64=
if [[ -z ${TAT_COMMAND_ID:-} ]]; then
	image_inventory=${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY must name the complete reviewed image inventory}
	[[ $image_inventory == /* && -f $image_inventory && ! -L $image_inventory ]] || {
		echo "ACTOR_IMAGE_INVENTORY must be an absolute, non-symlink regular file" >&2
		exit 2
	}
	cold_bucket=${RIVET_COLD_BUCKET:?RIVET_COLD_BUCKET must name the exact q01 cold bucket}
	[[ $cold_bucket =~ ^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$ ]] || {
		echo "RIVET_COLD_BUCKET is invalid" >&2
		exit 2
	}
	image_lock=$fleet_dir/gitops/image-seed/image-lock.py
	python3 "$image_lock" validate-inventory --lock "$image_inventory" >/dev/null
	resolve_image() {
		python3 "$image_lock" resolve --lock "$image_inventory" --repository "$1"
	}
	[[ $(resolve_image rivet-runtime) == "$runtime_image" ]] || {
		echo "runtime image is not bound by ACTOR_IMAGE_INVENTORY" >&2
		exit 2
	}
	[[ $(resolve_image actor-fleet-controller) == "$reporter_image" ]] || {
		echo "reporter image is not bound by ACTOR_IMAGE_INVENTORY" >&2
		exit 2
	}
	nats_image=$(resolve_image nats)
	metrics_image=$(resolve_image observability-busybox)
	inventory_sha=$(sha256sum "$image_inventory" | cut -d' ' -f1)
	inventory_bytes=$(wc -c <"$image_inventory" | tr -d ' ')
	inventory_base64=$(base64 -w0 <"$image_inventory")
fi

run_id=${RIVET_UPGRADE_RUN_ID:-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')}
[[ $run_id =~ ^[0-9a-f]{32}$ ]] || {
	echo "RIVET_UPGRADE_RUN_ID must be a lowercase 32-character hex identity" >&2
	exit 2
}
local_receipt=${RIVET_UPGRADE_LOCAL_RECEIPT:-}
if [[ -n $local_receipt ]]; then
	[[ $local_receipt =~ ^/data/[A-Za-z0-9._/-]+\.json$ && -d $(dirname -- "$local_receipt") ]] || {
		echo "RIVET_UPGRADE_LOCAL_RECEIPT must be a safe absolute /data JSON path with an existing parent" >&2
		exit 2
	}
fi
if [[ -n ${TAT_COMMAND_ID:-} ]]; then
	[[ $TAT_COMMAND_ID =~ ^cmd-[a-z0-9]{8}$ ]] || {
		echo "TAT_COMMAND_ID is invalid" >&2
		exit 2
	}
	approved_receipt=${RIVET_APPROVED_COMMANDS_RECEIPT:?RIVET_APPROVED_COMMANDS_RECEIPT is required for approved TAT commands}
	if [[ ${ACTOR_RELEASE_TEST_MODE:-0} != 1 ]]; then
		[[ ${RIVET_RELEASE_ORCHESTRATOR:-} == argocd && $approved_receipt == /etc/actor-release/approved-release-commands.json ]] || {
			echo "approved TAT commands require the Argo-mounted approval receipt" >&2
			exit 2
		}
	fi
	[[ -f $approved_receipt ]] || { echo "approved-command receipt is missing" >&2; exit 2; }
	phase=upgrade
	[[ -z $failed_release_receipt ]] || phase=rollback
	python3 "$fleet_dir/gitops/verify_approved_release_commands.py" \
		--receipt "$approved_receipt" --phase "$phase" \
		--command-id "$TAT_COMMAND_ID" --run-id "$run_id" \
		--runtime-image "$runtime_image" --runtime-revision "$runtime_revision" \
		--runtime-manifest "$runtime_manifest" \
		--reporter-image "$reporter_image" --reporter-revision "$reporter_revision" \
		--reporter-manifest "$reporter_manifest" >/dev/null
fi
printf -v quoted_runtime_image '%q' "$runtime_image"
printf -v quoted_runtime_revision '%q' "$runtime_revision"
printf -v quoted_runtime_manifest '%q' "$runtime_manifest"
printf -v quoted_reporter_image '%q' "$reporter_image"
printf -v quoted_reporter_revision '%q' "$reporter_revision"
printf -v quoted_reporter_manifest '%q' "$reporter_manifest"
printf -v quoted_run_id '%q' "$run_id"
printf -v quoted_failed_release_receipt '%q' "$failed_release_receipt"
printf -v quoted_nats_image '%q' "$nats_image"
printf -v quoted_metrics_image '%q' "$metrics_image"
printf -v quoted_cold_bucket '%q' "$cold_bucket"
set +e
if [[ -n ${TAT_COMMAND_ID:-} ]]; then
	command_output=$(mktemp "${TMPDIR:-/data/home}/approved-command-output.XXXXXX")
	"$fleet_dir/tat/tat-invoke.sh" "$TAT_COMMAND_ID" | tee "$command_output"
	tat_status=${PIPESTATUS[0]}
else
	"$fleet_dir/tat/tat-run.sh" --name "q01-user-transparent-upgrade-${run_id:0:12}" --timeout 7200 <<REMOTE
set -euo pipefail
export KUBECONFIG=/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig
source_link=/var/lib/actor-build/deploy/actor-bj-q01-current
source=\$(readlink -e "\$source_link")
[[ \$source =~ ^/var/lib/actor-build/deploy/q01-src-([0-9a-f]{40})-([0-9a-f]{64})\$ ]]
expected_revision=\${BASH_REMATCH[1]}
expected_manifest=\${BASH_REMATCH[2]}
source_revision=\$(tr -d '[:space:]' <"\$source/.actor-source/SOURCE_REVISION")
source_manifest=\$(sha256sum "\$source/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)
[[ \$source_revision == "\$expected_revision" && \$source_manifest == "\$expected_manifest" ]]

inventory_dir=/var/lib/actor-build/inventories
inventory=\$inventory_dir/all-images-$inventory_sha.lock.json
install -d -m 0700 "\$inventory_dir"
if [[ ! -e \$inventory ]]; then
  partial=\$inventory.partial-$run_id
  trap 'rm -f -- "\$partial"' EXIT
  printf '%s' '$inventory_base64' | base64 --decode >"\$partial"
  test "\$(wc -c <"\$partial" | tr -d ' ')" = '$inventory_bytes'
  test "\$(sha256sum "\$partial" | cut -d' ' -f1)" = '$inventory_sha'
  chmod 0600 "\$partial"
  mv "\$partial" "\$inventory"
  trap - EXIT
fi
test "\$(wc -c <"\$inventory" | tr -d ' ')" = '$inventory_bytes'
test "\$(sha256sum "\$inventory" | cut -d' ' -f1)" = '$inventory_sha'
python3 "\$source/infra/cells/deploy/tencent/fleet/gitops/image-seed/image-lock.py" \
  validate-inventory --lock "\$inventory" >/dev/null

namespace=actor-fdb-cell-system
cell=actor-bj-q01
capacity=\$cell-runtime-capacity
nats_image=$quoted_nats_image
metrics_image=$quoted_metrics_image
registry_url=\$(kubectl -n "\$namespace" get statefulset "\$cell-runtime-hosts" -o jsonpath='{.spec.template.spec.containers[?(@.name=="workerd-host")].env[?(@.name=="RIVET_WORKER_REGISTRY_URL")].value}')
exact_scale_down=\$(kubectl -n "\$namespace" get deployment "\$capacity" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RUNTIME_EXACT_SCALE_DOWN_ENABLED")].value}')
tke_cluster=\$(kubectl -n "\$namespace" get deployment "\$capacity" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="RUNTIME_TKE_CLUSTER_ID")].value}')
tke_role=\$(kubectl -n "\$namespace" get deployment "\$capacity" -o jsonpath='{.spec.template.spec.containers[0].env[?(@.name=="TKE_ROLE_ARN")].value}')
[[ \$nats_image =~ @sha256:[0-9a-f]{64}\$ && \$metrics_image =~ @sha256:[0-9a-f]{64}\$ ]]
[[ \$registry_url == http://actor-bj-q01-worker-registry:8080 ]]
[[ \$exact_scale_down == true && \$tke_cluster == cls-ike1rebd ]]
[[ \$tke_role == qcs::cam::uin/100045199955:roleName/actor-bj-q01-runtime-scale-down ]]

allow_degrade=0
failed_release_receipt=$quoted_failed_release_receipt
if [[ -n \$failed_release_receipt ]]; then
  live_engine=\$(kubectl -n "\$namespace" get deployment "\$cell-engine" -o jsonpath='{.spec.template.spec.containers[0].image}')
  live_runtime=\$(kubectl -n "\$namespace" get statefulset "\$cell-runtime-hosts" -o jsonpath='{.spec.template.spec.containers[0].image}')
  python3 "\$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/verify-failed-release-rollback.py" \
    "\$failed_release_receipt" $quoted_runtime_image "\$live_engine" "\$live_runtime"
  allow_degrade=1
  export AUTONOMY_CONTROL_QUALIFICATION_ROLLBACK_RECEIPT="\$failed_release_receipt"
  echo "failed-release rollback authorized: receipt=\$failed_release_receipt target=$quoted_runtime_image"
fi

export RIVET_CELL_NAMESPACE="\$namespace"
export RIVET_CELL_NAME="\$cell"
export RIVET_RUNTIME_PROFILE=production
export RIVET_GASOLINE_STORAGE_PROFILE_ENFORCE=1
export ACTOR_IMAGE_INVENTORY="\$inventory"
export RIVET_COLD_BUCKET=$quoted_cold_bucket
export RIVET_SOURCE_REVISION=$quoted_runtime_revision
export RIVET_SOURCE_MANIFEST_SHA256=$quoted_runtime_manifest
export RIVET_REPORTER_SOURCE_REVISION=$quoted_reporter_revision
export RIVET_REPORTER_SOURCE_MANIFEST_SHA256=$quoted_reporter_manifest
export RIVET_RUNTIME_IMAGE=$quoted_runtime_image
export RIVET_REPORTER_IMAGE=$quoted_reporter_image
export RIVET_NATS_IMAGE="\$nats_image"
export RIVET_WORKERD_METRICS_IMAGE="\$metrics_image"
export RIVET_WORKER_REGISTRY_URL="\$registry_url"
export RUNTIME_EXACT_SCALE_DOWN_ENABLED="\$exact_scale_down"
export RUNTIME_TKE_CLUSTER_ID="\$tke_cluster"
export RUNTIME_TKE_OIDC_ROLE_ARN="\$tke_role"
# q01's bounded autoscaling qualification owns the HPA and Host-drain fields
# under this exact SSA manager.  The TAT entrypoint must preserve the same
# ownership lineage as the direct builder entrypoint; otherwise the generic
# runtime installer becomes a second writer during a release and the release
# fails after the expensive Engine/NATS/Host rollout has already completed.
export RUNTIME_AUTOSCALING_FIELD_MANAGER=actor-q01-autoscaling
export RUNTIME_CAPACITY_MIN_REPLICAS=3
export RUNTIME_CAPACITY_MAX_REPLICAS=30
export RUNTIME_CAPACITY_TARGET_ACTIVE_ACTORS=16
export AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1
live_reporter=\$(kubectl -n "\$namespace" get deployment "\$cell-cell-reporter" -o jsonpath='{.spec.template.spec.containers[0].image}')
live_release_ledger=\$(kubectl -n "\$namespace" get configmap "\$cell-release-ledger" --ignore-not-found -o name)
if [[ $quoted_reporter_image != "\$live_reporter" || -z \$live_release_ledger ]]; then
  export AUTONOMY_CONTROL_ALLOW_STATIC_RELEASE_RECOVERY=1
fi
export AUTONOMY_CONTROL_ALLOW_DEGRADE="\$allow_degrade"
export RIVET_RELEASE_RECEIPT_DIR=/data/actor-qualification/receipts

if [[ -n \$failed_release_receipt ]]; then
  receipt=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-rollback-$quoted_run_id.json
  release_log=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-rollback-$quoted_run_id.release.log
  AUTONOMY_OPERATION_LOCK_WAIT_SECONDS=120 \
  "\$source/infra/cells/deploy/tencent/fleet/operations/with-autonomy-operation-lock.sh" -- \
  "\$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/user-transparent-rollback.py" \
    --kubeconfig "\$KUBECONFIG" \
    --release-script "\$source/infra/cells/deploy/tencent/fleet/runtime/release-runtime.sh" \
    --failed-receipt "\$failed_release_receipt" \
    --receipt "\$receipt" --release-log "\$release_log"
  python3 "\$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/verify-user-transparent-rollback.py" \
    "\$receipt" "\$failed_release_receipt" --expected-runtime-image $quoted_runtime_image
else
  receipt=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-$quoted_run_id.json
  release_log=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-$quoted_run_id.release.log
  AUTONOMY_OPERATION_LOCK_WAIT_SECONDS=120 \
  "\$source/infra/cells/deploy/tencent/fleet/operations/with-autonomy-operation-lock.sh" -- \
  "\$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/user-transparent-upgrade.py" \
    --kubeconfig "\$KUBECONFIG" \
    --release-script "\$source/infra/cells/deploy/tencent/fleet/runtime/release-runtime.sh" \
    --receipt "\$receipt" --release-log "\$release_log"
  python3 "\$source/infra/cells/deploy/tencent/fleet/qualification/actor-bj-q01/verify-user-transparent-upgrade.py" \
    "\$receipt" --expected-runtime-image $quoted_runtime_image
fi
REMOTE
	tat_status=$?
fi
set -e

if [[ -n $failed_release_receipt ]]; then
	remote_receipt=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-rollback-${run_id}.json
	receipt_kind=rollback
else
	remote_receipt=/data/actor-qualification/receipts/actor-bj-q01-user-transparent-upgrade-${run_id}.json
	receipt_kind=upgrade
fi
download_status=0
if [[ -n $local_receipt ]]; then
	if [[ -n ${TAT_COMMAND_ID:-} ]]; then
		python3 "$script_dir/approved-command-result.py" extract \
			--phase "$receipt_kind" --run-id "$run_id" --receipt "$remote_receipt" \
			--tat-status "$tat_status" --input "$command_output" --output "$local_receipt" \
			"${provenance_args[@]}" || download_status=$?
	else
		TAT_DOWNLOAD_OVERWRITE=1 "$fleet_dir/tat/tat-download.sh" "$remote_receipt" "$local_receipt" || download_status=$?
	fi
fi
[[ -z ${command_output:-} ]] || rm -f -- "$command_output"
printf 'user_transparent_%s_run_id=%s remote_receipt=%s' "$receipt_kind" "$run_id" "$remote_receipt"
[[ -z $local_receipt ]] || printf ' local_receipt=%s' "$local_receipt"
printf '\n'
if ((tat_status != 0)); then
	exit "$tat_status"
fi
if ((download_status != 0)); then
	echo "successful remote release has no retrievable local receipt" >&2
	exit "$download_status"
fi
