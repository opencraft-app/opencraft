#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $# == 3 ]] || { echo 'usage: RUN_ID PRODUCT_RECEIPT PRODUCT_RECEIPT_SHA256' >&2; exit 2; }
run_id=$1
product=$2
product_sha=$3
[[ $run_id =~ ^[0-9a-f]{32}$ && $product_sha =~ ^[0-9a-f]{64}$ ]]
runtime_revision=c631f5542f45b974455543d5bb458e0b3b3cf395
runtime_manifest=a54e7daa59d1b1a48403d6766a866486630b2cb7d1187a1e0d2a4427eb82bd0c
tools_revision=12080fbe94ac5b39324a98c7a3ec60d82b87f6c1
tools_manifest=952b0513c372f79a8d2b431e3e01ae8015dc273c9b0c7294194be4e41a4d9536
source_root=/var/lib/actor-build/deploy/q01-src-${tools_revision}-${tools_manifest}
fleet=$source_root/infra/cells/deploy/tencent/fleet
base=/data/actor-bootstrap/beijing-rebuild-20260915
[[ $product == /data/actor-qualification/builds/product-rivet-runtime-${runtime_revision}-*.json && $product != *..* ]]
[[ -f $product && ! -L $product && $(sha256sum "$product" | cut -d' ' -f1) == "$product_sha" ]]
runtime=$(jq -er --arg revision "$runtime_revision" --arg manifest "sha256:$runtime_manifest" '
  select(.repository=="rivet-runtime" and .sourceRevision==$revision and
    .sourceManifestDigest==$manifest and .registryPullVerified==true)|.ref' "$product")
[[ $runtime =~ ^actor-fleet-beijing\.tencentcloudcr\.com/actor-fleet/rivet-runtime@sha256:[a-f0-9]{64}$ ]]
export TMPDIR=/data/tmp TENCENT_REGION=ap-beijing
[[ $(tr -d '[:space:]' <"$source_root/.actor-source/SOURCE_REVISION") == "$tools_revision" ]]
[[ $(sha256sum "$source_root/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$tools_manifest" ]]
if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
  exec "$fleet/operations/with-autonomy-operation-lock.sh" -- bash "$0" "$@"
fi
(cd "$source_root" && sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null)
for cell in actor-bj-a01 actor-bj-b01; do
  root=$base/cells/$cell/receipts/runtime-admission-${runtime_revision}-${product_sha}
  gate_root=$root/qualification
  bottomless=$gate_root/$cell-bottomless-production-point-read-c631f554-20261003.json
  engine_ha=$gate_root/$cell-engine-ha-point-read-c631f554-20261003.json
  grep -q '^qualification_activation=passed ' "$root/activation-private.log"
  mapfile -t activations < <(find "$gate_root" -maxdepth 1 -type f -name "$cell-qualification-activation-*.json")
  [[ ${#activations[@]} == 1 ]]
  activation=${activations[0]}
  control=$(jq -er '.control_receipt' "$activation")
  [[ $control == "$root"/decisions/autonomy-control-"$cell"-*.json && $control != *..* ]]
  audit=$(jq -er '.source_receipt' "$control")
  [[ $audit == "$root"/audits/autonomy-audit-"$cell"-*.json && $audit != *..* ]]
  [[ $(sha256sum "$control" | cut -d' ' -f1) == $(jq -er '.control_receipt_sha256' "$activation") ]]
  [[ $(sha256sum "$audit" | cut -d' ' -f1) == $(jq -er '.source_receipt_sha256' "$control") ]]
  jq -e --arg cell "$cell" --arg runtime "$runtime" '.verdict=="passed" and .cell==$cell and .ready_for_placement==true and .qualification.release_digest==($runtime|split("@")[1])' "$activation" >/dev/null
  jq -e --arg cell "$cell" --arg revision "$runtime_revision" --arg manifest "$runtime_manifest" '.control=="allow" and .verdict=="passed" and .cell==$cell and .failures==[] and .warnings==[] and .sourceIdentity.revision==$revision and .sourceIdentity.manifest_sha256==$manifest' "$control" >/dev/null
  jq -e --arg cell "$cell" '.verdict=="passed" and .cell==$cell and .failures==[] and .warnings==[]' "$audit" >/dev/null
  python3.11 "$fleet/runtime/verify_bottomless_receipt.py" --profile production-cell \
    --expected-cell "$cell" --expected-namespace actor-fdb-cell-system \
    --expected-worker "${cell##*-}-bottomless-qualification" "$bottomless" >/dev/null
  jq -e --arg runtime "$runtime" '.release_binding.runtime_image==$runtime' "$bottomless" >/dev/null
  jq -e --arg runtime "$runtime" --arg cell "$cell" '
    .schema=="actor-cell-engine-ha/v1" and .verdict=="passed" and .cell==$cell and
    .release_binding.runtime_image==$runtime and .release_binding_after.runtime_image==$runtime and
    .probe.verdict=="passed" and .probe.failures==0 and .probe.cleanup=="passed"' "$engine_ha" >/dev/null
done
preflight=$base/load-tests/ten-thousand-active-${run_id}-preflight
test ! -e "$preflight"
test ! -e "$base/load-tests/ten-thousand-active-$run_id"
install -d -m 0700 "$preflight"
api_image=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/workers-api@sha256:d2e890c531e1979f74dbc83714b365ee11a43050fd45bcd5a1131c83ca95f9d5
jq -e --arg image "$api_image" '.verdict=="passed" and .image==$image' "$base/receipts/workers-api-read-release-723eebaa/release.json" >/dev/null
KUBECONFIG=$base/input/management.kubeconfig kubectl -n workers-api-system get deployment workers-api -o json |
  jq -e --arg image "$api_image" --arg uid 1720e900-8cf0-4151-b341-b4f8fa646463 '
    .metadata.uid==$uid and .metadata.generation>=1 and
    (.spec.replicas|type=="number" and floor==.) and .spec.replicas>=3 and .spec.replicas<=30 and
    .status.observedGeneration==.metadata.generation and
    .status.readyReplicas==.spec.replicas and .status.updatedReplicas==.spec.replicas and
    .spec.template.spec.containers[0].image==$image' >/dev/null
jq -n --arg runtime "$runtime" --arg runtimeRevision "$runtime_revision" --arg runtimeManifest "$runtime_manifest" \
  --arg productSha "$product_sha" --arg toolsRevision "$tools_revision" --arg toolsManifest "$tools_manifest" --arg apiImage "$api_image" \
  '{schemaVersion:"minisandbox-load-release-binding/v1",runtime:{image:$runtime,revision:$runtimeRevision,
    manifestSha256:$runtimeManifest,buildReceiptSha256:$productSha},
    tools:{revision:$toolsRevision,manifestSha256:$toolsManifest},workersApi:{image:$apiImage}}' >"$preflight/source-bindings.json"
for cell in actor-bj-a01 actor-bj-b01; do
  case "$cell" in
  actor-bj-a01) cell_uid=9926758e-4147-43ae-ae8c-38247f985bd8; fdb_uid=eef9ba91-78d3-46dd-b814-b1d2d01b61c6 ;;
  actor-bj-b01) cell_uid=87a07636-737c-4a57-8693-9d02f61883f8; fdb_uid=c6e52dcb-1a7b-499b-bf36-39e8fe2194dd ;;
  esac
  export KUBECONFIG=$base/cells/$cell/cell.kubeconfig
  namespace=actor-fdb-cell-system
  kubectl -n "$namespace" get rivetcell "$cell" -o json >"$preflight/$cell-cell.json"
  jq -e --arg uid "$cell_uid" '.metadata.uid==$uid and .spec.desiredState=="Ready" and .status.observedGeneration==.metadata.generation and .status.readyForPlacement==true' "$preflight/$cell-cell.json" >/dev/null
  kubectl -n "$namespace" get deployment "$cell-engine" -o json >"$preflight/$cell-engine.json"
  jq -e --arg runtime "$runtime" '.spec.replicas==6 and .status.readyReplicas==6 and .status.updatedReplicas==6 and all(.spec.template.spec.containers[]; .image==$runtime and .resources.requests.cpu=="4" and .resources.limits.cpu=="6")' "$preflight/$cell-engine.json" >/dev/null
  kubectl -n "$namespace" get configmap "$cell-release-ledger" -o json |
    jq -er '.data["ledger.json"]' >"$preflight/$cell-ledger.json"
  jq -e --arg cell "$cell" --arg runtime "$runtime" --arg revision "$runtime_revision" --arg manifest "$runtime_manifest" '.schemaVersion=="actor-fleet-static-release-ledger/v1" and .cell==$cell and .source.runtime.revision==$revision and .source.runtime.manifestSha256==$manifest and any(.workloads[]; .kind=="Deployment" and .name==($cell+"-engine") and .containers.engine==$runtime)' "$preflight/$cell-ledger.json" >/dev/null
  kubectl -n "$namespace" get statefulset "$cell-runtime-hosts" -o json >"$preflight/$cell-hosts.json"
  jq -e --arg runtime "$runtime" '.spec.replicas==4 and .status.readyReplicas==4 and .status.currentRevision==.status.updateRevision and all(.spec.template.spec.containers[]|select(.name=="workerd" or .name=="workerd-host"); .image==$runtime)' "$preflight/$cell-hosts.json" >/dev/null
  kubectl get nodes -l fleet.actor.dev/control-pool=true -o json >"$preflight/$cell-control-nodes.json"
  jq -e '.items|length==3 and all(.[]; (.status.capacity.cpu|tonumber)>=16 and any(.status.conditions[]; .type=="Ready" and .status=="True"))' "$preflight/$cell-control-nodes.json" >/dev/null
  kubectl -n "$namespace" get foundationdbclusters -o json >"$preflight/$cell-fdb.json"
  jq -e --arg uid "$fdb_uid" 'any(.items[]; .metadata.uid==$uid and .status.configured==true and .status.generations.reconciled==.metadata.generation and .status.health.available==true and .status.health.fullReplication==true and .status.health.healthy==true)' "$preflight/$cell-fdb.json" >/dev/null
done
sha256sum "$preflight"/*.json
unset KUBECONFIG
export ACTOR_REVIEWED_SOURCE=$source_root ACTOR_BOOTSTRAP_ROOT=$base
printf 'strict10k_admission=starting run_id=%s runtime=%s tools_revision=%s\n' "$run_id" "$runtime" "$tools_revision"
bash "$fleet/load/ten-thousand-active/run-on-builder.sh" "$run_id"
