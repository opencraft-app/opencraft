#!/usr/bin/env bash
set -euo pipefail
umask 077

run_id=${1:?usage: run-on-builder.sh RUN_ID EXPECTED_API_IMAGE}
image=${2:?usage: run-on-builder.sh RUN_ID EXPECTED_API_IMAGE}
[[ $# == 2 && $run_id =~ ^[a-f0-9]{32}$ && $image =~ ^[^[:space:]@]+@sha256:[a-f0-9]{64}$ ]] || {
	echo "run ID and exact API image are required" >&2
	exit 2
}
source_root=${ACTOR_REVIEWED_SOURCE:?immutable reviewed source is required}
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec bash "$script_dir/../../operations/with-autonomy-operation-lock.sh" -- bash "$0" "$@"
fi
[[ $source_root == /var/lib/actor-build/* || $source_root == /data/actor-build/* ]]
source_root=$(readlink -e "$source_root")
[[ $source_root == /var/lib/actor-build/* || $source_root == /data/actor-build/* ]]
revision=$(tr -d '[:space:]' <"$source_root/.actor-source/SOURCE_REVISION")
manifest=$(sha256sum "$source_root/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1)
[[ $revision =~ ^[a-f0-9]{40}$ && $manifest =~ ^[a-f0-9]{64}$ ]]
(cd "$source_root" && sha256sum --check .actor-source/RELEASE_SHA256SUMS >/dev/null)
base=${ACTOR_BOOTSTRAP_ROOT:-/data/actor-bootstrap/beijing-rebuild-20260915}
base=$(readlink -e "$base")
[[ $base == /data/actor-bootstrap/* && $base != /data/actor-bootstrap/ ]]
kubeconfig=$base/input/management.kubeconfig
test -f "$kubeconfig" && test ! -L "$kubeconfig"
endpoint=$(jq -er '.endpoint' "$base/receipts/workers-api/endpoint-installation.json")
out=$base/load-tests/workers-api-business-drain-$run_id
test ! -e "$out"
install -d -m 0700 "$out"
python3.11 "$source_root/infra/cells/deploy/tencent/fleet/load/workers-api-business-drain/qualify.py" \
	--kubeconfig "$kubeconfig" --endpoint "$endpoint" --run-id "$run_id" \
	--expected-image "$image" --source-revision "$revision" --source-manifest-sha256 "$manifest" \
	--receipt "$out/receipt.json" >"$out/qualify.log" 2>&1
jq -e '.schema=="actor-workers-api-business-drain/v1" and .verdict=="passed" and
  .stream.requestAttempts==1 and .stream.retries==0 and .stream.pendingAfterListenerStop==true and
  .stream.bytes==131072 and .traffic.failures==0 and .traffic.successfulDuringReplacement>=3 and
  .traffic.successfulAfterReady>=3 and .replacement.readyReplicas>=3 and .replacement.readyNodes>=3 and
  .cleanup.status==204' "$out/receipt.json" >/dev/null
printf 'workers_api_business_drain=passed receipt=%s sha256=%s\n' \
	"$out/receipt.json" "$(sha256sum "$out/receipt.json" | cut -d' ' -f1)"
