#!/usr/bin/env bash
# Exact runtime-only release and qualification. No manual capacity changes.
# Preflight may stage a local image inventory but performs no workload mutation.
set -euo pipefail
umask 077
[[ $# == 3 ]] || { echo 'usage: CELL PRODUCT_RECEIPT PRODUCT_RECEIPT_SHA256' >&2; exit 2; }
cell=$1
product=$2
product_sha=$3
phase=${RUNTIME_ADMISSION_PHASE:-release}
case "$phase" in preflight | release | qualify) ;; *) echo 'invalid release phase' >&2; exit 2 ;; esac
revision=2757fc785d8f572d1b6430e471100c4a880aefac
manifest=c6785b95c7d2615bbc0fdd57e2007665bd542455fa288dc6c863e389ee107300
source_root=/var/lib/actor-build/deploy/q01-src-${revision}-${manifest}
fleet=$source_root/infra/cells/deploy/tencent/fleet
base=/data/actor-bootstrap/beijing-rebuild-20260915
old_revision=c631f5542f45b974455543d5bb458e0b3b3cf395
old_product_sha=d49da48b0ec04edd39bd53252910a20e2cbaa4c44930f92fd1a89bef44685cb1
old_runtime=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/rivet-runtime@sha256:d3a6e41e3d1c4726998f8261d3b75648249df4a60d26a948820d28067a797711
api_image=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/workers-api@sha256:d2e890c531e1979f74dbc83714b365ee11a43050fd45bcd5a1131c83ca95f9d5
case "$cell" in
actor-bj-a01)
  cell_uid=9926758e-4147-43ae-ae8c-38247f985bd8
  host_uid=a25fdf91-5c54-464d-a516-d085e6870396
  engine_uid=0910ca53-a473-47e1-beae-f1ac78b932df
  machine_set_uid=f80d4089-2a42-46d4-b932-97c74fa4f1a1
  cluster=cls-kuck099x
  cold_bucket=actor-depot-cold-prod-bj-a01-nv1-1388575217
  ;;
actor-bj-b01)
  cell_uid=87a07636-737c-4a57-8693-9d02f61883f8
  host_uid=671c4557-324a-4082-89dd-ac109a542032
  engine_uid=c78ee4ad-d13d-4d99-8d3c-60c17a0299bc
  machine_set_uid=71ac45ab-fd52-42e6-812e-08d00f781ae7
  cluster=cls-1femn3mh
  cold_bucket=actor-depot-cold-prod-bj-b01-nv1-1388575217
  ;;
*) echo 'only reviewed Beijing A/B identities are supported' >&2; exit 2 ;;
esac
[[ $product == /data/actor-build/runtime-builder-verify-eec1f1ef/input/product-runtime-2757.receipt.json ]]
[[ $product_sha =~ ^[0-9a-f]{64}$ ]]
[[ -f $product && $(sha256sum "$product" | cut -d' ' -f1) == "$product_sha" ]]
[[ $(sha256sum "$source_root/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$manifest" ]]
[[ $(tr -d '[:space:]' <"$source_root/.actor-source/SOURCE_REVISION") == "$revision" ]]
export TMPDIR=/data/tmp TENCENT_REGION=ap-beijing
# Release delegates the complete pre-audit/action/post-audit lock lifetime to
# run-autonomy-ops-cycle.sh. Nesting a second flock would reject our own cycle.
# Preflight and qualification use the supervisor lock for their whole phase.
if [[ $phase != release && ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
  exec "$fleet/operations/with-autonomy-operation-lock.sh" -- bash "$0" "$@"
fi
shim=$(mktemp -d /data/tmp/runtime-admission-python.XXXXXX)
trap 'rm -rf -- "$shim"' EXIT
ln -s "$(command -v python3.11)" "$shim/python3"
export PATH="$shim:$PATH" PYTHON=python3.11 ACTOR_BUILD_PYTHON=python3.11
python3 -c 'import sys; assert sys.version_info[:2] == (3, 11)'
(cd "$source_root" && sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null)
python3 "$fleet/gitops/image-seed/product-lock.py" validate --receipt "$product" >/dev/null
jq -e --arg revision "$revision" --arg manifest "sha256:$manifest" \
  '.repository=="rivet-runtime" and .sourceRevision==$revision and .sourceManifestDigest==$manifest and .registryPullVerified==true' "$product" >/dev/null
api_product=/data/actor-build/workers-api-read-723eebaa/product-workers-api-723eebaac627fcfead30c24307be2788e887e2af-2e5708cd2d688d060acb0372c08ea838da8ed29d1af17b6fc1d7309736dbec85.json
[[ $(sha256sum "$api_product" | cut -d' ' -f1) == 397b45b5720d9e00c974ce9837ed24c263c6ae81218e3919eb81a7350549738e ]]
jq -e --arg ref "$api_image" '.ref==$ref and .sourceRevision=="723eebaac627fcfead30c24307be2788e887e2af"' "$api_product" >/dev/null
KUBECONFIG=$base/input/management.kubeconfig kubectl -n workers-api-system get deployment workers-api -o json |
  jq -e --arg uid 1720e900-8cf0-4151-b341-b4f8fa646463 --arg image "$api_image" \
    '.metadata.uid==$uid and .spec.replicas>=3 and .spec.replicas<=30 and .status.readyReplicas==.spec.replicas and .spec.template.spec.containers[0].image==$image' >/dev/null
api_release=$base/receipts/workers-api-read-release-723eebaa
jq -e --arg image "$api_image" '.verdict=="passed" and .image==$image' "$api_release/release.json" >/dev/null
old_inventory=$api_release/all-images.lock.json
python3 "$fleet/gitops/image-seed/image-lock.py" validate-inventory --lock "$old_inventory" >/dev/null
export ACTOR_IMAGE_INVENTORY=/data/actor-build/runtime-admission-${revision}/all-images-${product_sha}.lock.json
[[ ! -e $ACTOR_IMAGE_INVENTORY ]] || python3 "$fleet/gitops/image-seed/image-lock.py" validate-inventory --lock "$ACTOR_IMAGE_INVENTORY" >/dev/null
if [[ ! -e $ACTOR_IMAGE_INVENTORY ]]; then
  python3 "$fleet/gitops/image-seed/product-lock.py" promote --inventory "$old_inventory" \
    --receipt "$product" --receipt "$api_product" --output "$ACTOR_IMAGE_INVENTORY" >/dev/null
fi
python3 "$fleet/gitops/image-seed/image-lock.py" validate-inventory --lock "$ACTOR_IMAGE_INVENTORY" >/dev/null
jq -e --arg ref "$(jq -er .ref "$product")" --arg sha "sha256:$product_sha" --arg api "$api_image" \
  'any(.images[]; .repository=="rivet-runtime" and .ref==$ref and .provenance.buildReceiptDigest==$sha) and any(.images[]; .repository=="workers-api" and .ref==$api)' "$ACTOR_IMAGE_INVENTORY" >/dev/null
export CELL=$cell CELL_NAMESPACE=actor-fdb-cell-system
export RIVET_CELL_NAME=$cell RIVET_CELL_NAMESPACE=$CELL_NAMESPACE
export KUBECONFIG=$base/cells/$cell/cell.kubeconfig KUBECONFIG_PATH=$base/cells/$cell/cell.kubeconfig
expected_runtime=$old_runtime
if [[ $phase == qualify ]]; then expected_runtime=$(jq -er .ref "$product"); fi
kubectl -n "$CELL_NAMESPACE" get rivetcell "$cell" -o json |
  jq -e --arg uid "$cell_uid" --arg phase "$phase" '.metadata.uid==$uid and .spec.desiredState=="Ready" and ($phase=="qualify" or .status.readyForPlacement==true)' >/dev/null
kubectl -n "$CELL_NAMESPACE" get statefulset "$cell-runtime-hosts" -o json |
  jq -e --arg uid "$host_uid" --arg image "$expected_runtime" '.metadata.uid==$uid and .spec.replicas==4 and .status.readyReplicas==4 and .status.currentRevision==.status.updateRevision and any(.spec.template.spec.containers[]; .image==$image)' >/dev/null
kubectl -n "$CELL_NAMESPACE" get deployment "$cell-engine" -o json |
  jq -e --arg uid "$engine_uid" --arg image "$expected_runtime" '.metadata.uid==$uid and .spec.replicas==6 and .status.readyReplicas==6 and any(.spec.template.spec.containers[]; .image==$image)' >/dev/null
kubectl get machineset np-runtime0 -o json | jq -e --arg uid "$machine_set_uid" '.metadata.uid==$uid and .spec.replicas==4 and .status.readyReplicas==4' >/dev/null
kubectl -n "$CELL_NAMESPACE" get hpa "$cell-runtime-hosts-actor-capacity" -o json | jq -e '.spec.minReplicas==4 and .spec.maxReplicas==301' >/dev/null
kubectl -n "$CELL_NAMESPACE" get deployment "$cell-runtime-capacity" -o json | jq -e '
  .spec.template.spec.containers[]|select(.name=="controller")|
  (.env|map(select(has("value")))|map({key:.name,value:.value})|from_entries) as $env|
  $env.RUNTIME_CAPACITY_MIN_REPLICAS=="3" and $env.RUNTIME_CAPACITY_MAX_REPLICAS=="301" and
  $env.RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED=="false" and $env.RUNTIME_EXACT_SCALE_DOWN_ENABLED=="true"' >/dev/null
export RIVET_RUNTIME_PROFILE=production RIVET_GASOLINE_STORAGE_PROFILE_ENFORCE=1
export RIVET_WORKER_REGISTRY_URL=http://10.160.0.15:8080
export RIVET_COLD_BUCKET=$cold_bucket RIVET_COLD_REGION=ap-beijing RIVET_COLD_ENDPOINT=https://cos.ap-beijing.myqcloud.com
export RUNTIME_EXACT_SCALE_DOWN_ENABLED=true RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED=false
export RUNTIME_CAPACITY_MIN_REPLICAS=4 RUNTIME_CAPACITY_MAX_REPLICAS=301 RUNTIME_CAPACITY_MAX_REPAIR_SURGE=1
export RUNTIME_TKE_CLUSTER_ID=$cluster RUNTIME_TKE_OIDC_ROLE_ARN=qcs::cam::uin/100045199955:roleName/$cell-runtime-scale-down
export RUNTIME_CAPACITY_CONTROLLER_RECOVERY=0
export RIVET_DEPOT_MANAGER_REFRESH_MAX_CONCURRENCY=8 RIVET_DEPOT_COMPACTION_MAX_CONCURRENCY=2
export AUTONOMY_QUALIFICATION_MODE=initial-cell AUTONOMY_SOURCE_REVISION=$revision AUTONOMY_SOURCE_MANIFEST_SHA256=$manifest AUTONOMY_SOURCE_TARGET=$source_root
root=$base/cells/$cell/receipts/runtime-admission-${revision}-${product_sha}-cycle-owner-v2
export AUTONOMY_CONTROL_DECISIONS_DIR=$root/decisions AUTONOMY_AUDIT_RECEIPT_DIR=$root/audits
export PROM_NAMESPACE=observability PROM_SERVICE=actor-observability-prometheus
export ENGINE_METRICS_SERVICE=actor-fleet-engine-metrics RUNTIME_METRICS_SERVICE=$cell-runtime-hosts
old_root=$base/cells/$cell/receipts/runtime-admission-${old_revision}-${old_product_sha}
export RIVET_RELEASE_RECEIPT_DIR=$root/release
if [[ $phase == preflight ]]; then
  printf 'runtime_admission_preflight=passed cell=%s source=%s product_sha=%s\n' "$cell" "$revision" "$product_sha"
  exit 0
fi
if [[ $phase == release ]]; then
  [[ ! -e $root ]]
  mkdir -p "$root/audits" "$root/decisions" "$root/qualification" "$root/release"
  export RUNTIME_RECEIPTS_DIR=$old_root/qualification RELEASE_RECEIPTS_DIR=$old_root/release
  printf 'runtime_admission_phase=release_started cell=%s\n' "$cell"
  set +e
  "$fleet/operations/run-autonomy-ops-cycle.sh" --state-dir "$root/release-cycle" \
    --action "$fleet/runtime/release-runtime.sh" >"$root/release-cycle-private.log" 2>&1
  cycle_status=$?
  set -e
  (( cycle_status == 0 || cycle_status == 2 ))
fi
[[ -d $root && ! -L $root ]]
mapfile -t cycles < <(find "$root/release-cycle/cycles" -mindepth 2 -maxdepth 2 -type f -name autonomy-ops-cycle.json -print)
(( ${#cycles[@]} == 1 ))
# A fresh release invalidates the previous qualifications on purpose. Preserve
# the cycle's actual block/exit 2; only an action exit 0 proves rollout success.
jq -e --arg action "$fleet/runtime/release-runtime.sh" \
  --arg action_sha "$(sha256sum "$fleet/runtime/release-runtime.sh" | cut -d' ' -f1)" '
  .schemaVersion=="actor-fdb-autonomy-ops-cycle-v1" and .preControl.control=="allow" and
  .preControl.exitCode==0 and .action.requested==true and .action.path==$action and
  .action.sha256==$action_sha and .action.exitCode=="0" and
  (.postControl.control=="allow" or .postControl.control=="block")' "${cycles[0]}" >/dev/null
if [[ $phase == release ]]; then
  printf 'runtime_admission_phase=rollout_passed qualification_pending=true cell=%s\n' "$cell"
  # Recheck the exact new digest/UID under the qualification lock. Another
  # release cannot use the intentionally blocked intermediate Cell. No old
  # control receipt is carried across this phase boundary.
  "$fleet/operations/with-autonomy-operation-lock.sh" -- \
    env RUNTIME_ADMISSION_PHASE=qualify bash "$0" "$@"
  exit $?
fi
export RELEASE_RECEIPTS_DIR=$root/release RUNTIME_RECEIPTS_DIR=$root/qualification QUALIFICATION_RECEIPT_DIR=$root/qualification
set +e
"$fleet/operations/run-autonomy-governance.sh" --receipt-dir "$root/decisions" >"$root/postrelease-private.log" 2>&1
status=$?
set -e
(( status == 0 || status == 2 ))
bottomless=$root/qualification/$cell-bottomless-production-bounded-maintenance-2757fc78-20261004.json
engine_ha=$root/qualification/$cell-engine-ha-bounded-maintenance-2757fc78-20261004.json
QUALIFICATION_PROFILE=production-cell QUALIFICATION_RECEIPT=$bottomless AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 \
  "$fleet/runtime/qualify-runtime.sh" >"$root/bottomless-private.log" 2>&1
printf 'runtime_admission_phase=bottomless_passed cell=%s\n' "$cell"
ENGINE_HA_RECEIPT=$engine_ha ENGINE_HA_DYNAMIC_RUNTIME_CAPACITY=true AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 \
  "$fleet/runtime/qualify-engine-ha.sh" >"$root/engine-ha-private.log" 2>&1
printf 'runtime_admission_phase=engine_ha_passed cell=%s\n' "$cell"
"$fleet/operations/run-autonomy-governance.sh" --receipt-dir "$root/decisions" >"$root/final-governance-private.log" 2>&1
control=$(find "$root/decisions" -maxdepth 1 -type f -name "autonomy-control-$cell-*.json" -print | sort | tail -n 1)
"$fleet/operations/publish-qualified-release.sh" "$control" >"$root/activation-private.log" 2>&1
grep '^qualification_activation=passed ' "$root/activation-private.log"
sha256sum "$bottomless" "$engine_ha" "$control" "$ACTOR_IMAGE_INVENTORY"
printf 'runtime_admission_release_qualification=passed cell=%s\n' "$cell"
