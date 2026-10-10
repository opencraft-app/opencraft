#!/usr/bin/env bash
set -euo pipefail
umask 077
base=/data/actor-bootstrap/beijing-rebuild-20260915
revision=2757fc785d8f572d1b6430e471100c4a880aefac
manifest=c6785b95c7d2615bbc0fdd57e2007665bd542455fa288dc6c863e389ee107300
source_root=/var/lib/actor-build/deploy/q01-src-${revision}-${manifest}
fleet=$source_root/infra/cells/deploy/tencent/fleet
adapter=/data/actor-build/runtime-builder-verify-eec1f1ef/input/release-and-qualify-runtime-2757-cycle-owner-v3-diagnostic.sh
product=/data/actor-build/runtime-builder-verify-eec1f1ef/input/product-runtime-2757.receipt.json
product_sha=aea4ca3f31b280c99f710833203352547373fdd1299f8a0b6f44a3f033662b72
[[ $(sha256sum "$adapter" | cut -d' ' -f1) == 268ca63fa28f11db9e733a667c7d89f121fb491b16b46ef0f6779f6435ab315a ]]
[[ $(sha256sum "$product" | cut -d' ' -f1) == "$product_sha" ]]
[[ $(systemctl show -p MainPID --value minisandbox-strict10k-200a42ae03ef4e128505b0def22e8af8.service) == 0 ]]
[[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]
runtime=$(jq -er --arg revision "$revision" --arg manifest "sha256:$manifest" 'select(.sourceRevision==$revision and .sourceManifestDigest==$manifest and .registryPullVerified==true)|.ref' "$product")
a_root=$base/cells/actor-bj-a01/receipts/runtime-admission-${revision}-${product_sha}-cycle-owner-v2
a_qualification=$a_root/qualification
grep -q '^qualification_activation=passed ' "$a_root/activation-private.log"
mapfile -t activations < <(find "$a_qualification" -maxdepth 1 -type f -name 'actor-bj-a01-qualification-activation-*.json' -print)
[[ ${#activations[@]} == 1 ]]
activation=${activations[0]}
control=$(jq -er '.control_receipt' "$activation")
[[ $control == "$a_root"/decisions/autonomy-control-actor-bj-a01-*.json && $control != *..* ]]
audit=$(jq -er '.source_receipt' "$control")
[[ $audit == "$a_root"/audits/autonomy-audit-actor-bj-a01-*.json && $audit != *..* ]]
[[ $(sha256sum "$control" | cut -d' ' -f1) == $(jq -er '.control_receipt_sha256' "$activation") ]]
[[ $(sha256sum "$audit" | cut -d' ' -f1) == $(jq -er '.source_receipt_sha256' "$control") ]]
jq -e --arg runtime "$runtime" '.verdict=="passed" and .cell=="actor-bj-a01" and .ready_for_placement==true and .qualification.release_digest==($runtime|split("@")[1])' "$activation" >/dev/null
jq -e --arg revision "$revision" --arg manifest "$manifest" '.control=="allow" and .verdict=="passed" and .cell=="actor-bj-a01" and .failures==[] and .warnings==[] and .sourceIdentity.revision==$revision and .sourceIdentity.manifest_sha256==$manifest' "$control" >/dev/null
jq -e '.verdict=="passed" and .cell=="actor-bj-a01" and .failures==[] and .warnings==[]' "$audit" >/dev/null
python3.11 "$fleet/runtime/verify_bottomless_receipt.py" --profile production-cell --expected-cell actor-bj-a01 --expected-namespace actor-fdb-cell-system --expected-worker a01-bottomless-qualification "$a_qualification/actor-bj-a01-bottomless-production-bounded-maintenance-2757fc78-20261004.json" >/dev/null
jq -e --arg runtime "$runtime" '.release_binding.runtime_image==$runtime' "$a_qualification/actor-bj-a01-bottomless-production-bounded-maintenance-2757fc78-20261004.json" >/dev/null
jq -e --arg runtime "$runtime" '.schema=="actor-cell-engine-ha/v1" and .verdict=="passed" and .cell=="actor-bj-a01" and .release_binding.runtime_image==$runtime and .release_binding_after.runtime_image==$runtime and .probe.verdict=="passed" and .probe.failures==0 and .probe.cleanup=="passed"' "$a_qualification/actor-bj-a01-engine-ha-bounded-maintenance-2757fc78-20261004.json" >/dev/null
set -a
source "$base/input/tencent-root.env"
set +a
export ACTOR_TCCLI_TOOL_ROOT=$base/private/tccli-tool TENCENT_API_ROOT_DOMAIN=internal.tencentcloudapi.com
export TMPDIR=/data/tmp TENCENT_REGION=ap-beijing
tool_path=$(mktemp -d /data/tmp/runtime-release-cli.XXXXXX)
trap 'rm -rf -- "$tool_path"' EXIT
ln -s "$fleet/terraform/create-first/bootstrap/tccli-container-wrapper.sh" "$tool_path/tccli"
export PATH="$tool_path:$PATH"
RUNTIME_ADMISSION_PHASE=preflight bash "$adapter" actor-bj-b01 "$product" "$product_sha"
RUNTIME_ADMISSION_PHASE=release bash "$adapter" actor-bj-b01 "$product" "$product_sha"
