#!/usr/bin/env bash
set -euo pipefail
umask 077
[[ $# == 1 && $1 =~ ^[0-9a-f]{32}$ ]] || { echo 'usage: FRESH_RUN_ID' >&2; exit 2; }
run_id=$1
unit=minisandbox-strict10k-$run_id
wrapper=/data/actor-build/release/minisandbox-strict10k-runtime2757-tools120-2385bb343b8d.sh
product=/data/actor-build/runtime-builder-verify-eec1f1ef/input/product-runtime-2757.receipt.json
product_sha=aea4ca3f31b280c99f710833203352547373fdd1299f8a0b6f44a3f033662b72
base=/data/actor-bootstrap/beijing-rebuild-20260915
log=$base/load-tests/strict10k-supervisor-$run_id.log
[[ $(sha256sum "$wrapper" | cut -d' ' -f1) == 2385bb343b8d549c3ca4b0acec14f804af8f413fa19ae4d423255af81425a74f ]]
[[ $(sha256sum "$product" | cut -d' ' -f1) == "$product_sha" ]]
[[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]
[[ $(systemctl show -p MainPID --value minisandbox-strict10k-200a42ae03ef4e128505b0def22e8af8.service) == 0 ]]
for cell in actor-bj-a01 actor-bj-b01; do
  root=$base/cells/$cell/receipts/runtime-admission-2757fc785d8f572d1b6430e471100c4a880aefac-$product_sha-cycle-owner-v2
  grep -q '^qualification_activation=passed ' "$root/activation-private.log"
done
# The wrapper revalidates both complete receipt chains and exact live identities
# while holding the original whole-operation lock. Never wrap the launcher in it.
export KUBECONFIG=$base/input/management.kubeconfig
nodes=$(kubectl get nodes -o json)
jq -e '(.items|length)==3 and all(.items[];
  .metadata.deletionTimestamp==null and
  any(.status.conditions[]; .type=="Ready" and .status=="True") and
  any(.status.conditions[]; .type=="DiskPressure" and .status=="False"))' <<<"$nodes" >/dev/null
kubectl -n workers-api-system get hpa workers-api -o json | jq -e '
  .spec.minReplicas==3 and .spec.maxReplicas==30 and
  any(.status.conditions[]; .type=="ScalingActive" and .status=="True") and
  any(.status.currentMetrics[]; .type=="Pods" and .pods.metric.name=="workers_api_routing_requests_per_second" and .pods.current.averageValue!=null) and
  any(.status.currentMetrics[]; .type=="Pods" and .pods.metric.name=="workers_api_routing_requests_in_flight" and .pods.current.averageValue!=null)' >/dev/null
# Query current Node names, not the previous release's remembered Node IP.
mapfile -t node_names < <(jq -er '.items[].metadata.name' <<<"$nodes")
[[ ${#node_names[@]} == 3 ]]
for node_name in "${node_names[@]}"; do
  [[ $node_name =~ ^[A-Za-z0-9][A-Za-z0-9.-]*$ ]]
  kubectl get --raw "/api/v1/nodes/$node_name/proxy/stats/summary" | jq -e '
    .node.fs.availableBytes > (.node.fs.capacityBytes * 0.15 + 2147483648) and
    .node.fs.inodesFree > 100000' >/dev/null
done
unset KUBECONFIG
[[ $(systemctl show "$unit.service" --property=LoadState --value) == not-found ]]
test ! -e "$log"
test ! -e "$base/load-tests/ten-thousand-active-$run_id"
test ! -e "$base/load-tests/ten-thousand-active-$run_id-preflight"
systemd-run --unit "$unit" --service-type=exec \
  --property=WorkingDirectory=/data/actor-build/release \
  --property=Environment=TMPDIR=/data/tmp \
  --property="StandardOutput=append:$log" --property="StandardError=append:$log" \
  --property=KillMode=control-group --property=TimeoutStopSec=120 \
  --property=RuntimeMaxSec=172800 --property=Restart=no --property=RemainAfterExit=yes \
  /usr/bin/bash "$wrapper" "$run_id" "$product" "$product_sha"
systemctl show "$unit.service" --property=Id --property=LoadState --property=ActiveState \
  --property=SubState --property=MainPID --property=InvocationID --property=ExecMainCode \
  --property=ExecMainStatus --property=Result
printf 'strict10k_submitted=true run_id=%s unit=%s supervisor_log=%s\n' "$run_id" "$unit.service" "$log"
