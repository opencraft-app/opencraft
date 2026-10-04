#!/usr/bin/env bash
set -euo pipefail
umask 077

run_id=${1:?usage: run-on-builder.sh RUN_ID}
[[ $run_id =~ ^[a-f0-9]{32}$ ]] || { echo "RUN_ID must be 32 lowercase hex characters" >&2; exit 2; }

source_root=${ACTOR_REVIEWED_SOURCE:?ACTOR_REVIEWED_SOURCE must name the immutable reviewed source}
base=${ACTOR_BOOTSTRAP_ROOT:-/data/actor-bootstrap/beijing-rebuild-20260915}
incoming=${ACTOR_BUILD_ROOT:-/data/actor-build/beijing-rebuild-20260915}
out=$base/load-tests/ten-thousand-active-$run_id
namespace=actor-fdb-cell-system
node=${ACTOR_NODE_BINARY:-$base/tools/node24/bin/node}
runner=$source_root/infra/cells/deploy/tencent/fleet/load/shared-agent-scale/runner.mjs
observer=$source_root/infra/cells/deploy/tencent/fleet/load/agent-upload-soak/observe.py
verifier=$source_root/infra/cells/deploy/tencent/fleet/load/ten-thousand-active/verify.py
cleanup_tool=$source_root/infra/cells/deploy/tencent/fleet/load/shared-agent-scale/cleanup.py
drain_profile_checker=$source_root/infra/cells/deploy/tencent/fleet/runtime/host-drain-profile.py
lock=$base/load-tests/ten-thousand-active.lock
cells=(actor-bj-a01 actor-bj-b01)

test -x "$node"
test -f "$runner" && test -f "$observer" && test -f "$verifier" && test -f "$cleanup_tool"
test -f "$drain_profile_checker"
test ! -e "$out"
install -d -m 0700 "$out" "$out/observer-input/cells/actor-bj-a01" "$out/observer-input/cells/actor-bj-b01"
exec 9>"$lock"
flock -n 9 || { echo "another ten-thousand-active qualification is running" >&2; exit 75; }

for cell in "${cells[@]}"; do
	config=$base/cells/$cell/cell.kubeconfig
	test -f "$config"
	install -m 0600 "$config" "$out/observer-input/cells/$cell/cell.kubeconfig"
	kubectl --kubeconfig "$config" -n "$namespace" get deployment "${cell}-host-drain" -o json \
		| python3.11 "$drain_profile_checker" check production
done
for cell in "${cells[@]}"; do
	test -f "$incoming/${cell}-federation-endpoint.json"
done
endpoint=$(jq -er '.endpoint' "$base/receipts/workers-api/endpoint-installation.json")/v1
[[ $endpoint == http://*/v1 || $endpoint == https://*/v1 ]]

cell_is_low() {
	# Assign the dependent path after the local Cell value. In Bash, expansion
	# within one compound `local cell=... config=...` can observe the caller's
	# previous `cell` value and silently query the other Cell's kubeconfig.
	local cell=$1
	local config=$base/cells/$cell/cell.kubeconfig
	local state nodes
	state=$(kubectl --kubeconfig "$config" -n "$namespace" get statefulset "${cell}-runtime-hosts" -o json) || return 1
	jq -e '.spec.replicas==4 and .status.readyReplicas==4 and .status.currentReplicas==4 and
      .status.currentRevision==.status.updateRevision and
      (.metadata.annotations["fleet.actor.dev/runtime-release-hold"]//"")=="" and
      ((.metadata.annotations["fleet.actor.dev/workerd-host-drain-state"]|fromjson).phase=="Idle")' \
		<<<"$state" >/dev/null || return 1
	state=$(kubectl --kubeconfig "$config" get machineset np-runtime0 -o json) || return 1
	jq -e '.spec.replicas==4 and .status.replicas==4 and .status.readyReplicas==4 and
      (.metadata.annotations["fleet.actor.dev/runtime-capacity-downscale-intent"]//"")==""' \
		<<<"$state" >/dev/null || return 1
	# np-runtime1 was the retired overflow pool in the pre-rebuild fleet.  A
	# cleanly rebuilt Cell does not create that object at all; an old Cell may
	# retain it at an exact zero floor.  Both states mean that the retired pool
	# contributes no hidden capacity.  Any other API failure remains fail closed.
	if state=$(kubectl --kubeconfig "$config" get machineset np-runtime1 -o json 2>"$out/np-runtime1-$cell.err"); then
		jq -e '.spec.replicas==0 and (.status.replicas//0)==0 and (.status.readyReplicas//0)==0' \
			<<<"$state" >/dev/null || return 1
	elif grep -q 'NotFound' "$out/np-runtime1-$cell.err"; then
		:
	else
		return 1
	fi
	nodes=$(kubectl --kubeconfig "$config" get nodes \
		-l 'rivet.dev/compute=true,node.tke.cloud.tencent.com/machineset=np-runtime0' -o json) || return 1
	jq -e '.items|length==4 and all(.[];
      .metadata.labels["fleet.actor.dev/runtime-admitted"]=="true" and
      (any(.status.conditions[]; .type=="Ready" and .status=="True")) and
      (all(.spec.taints[]?; .key!="fleet.actor.dev/runtime-admission" and
        .key!="fleet.actor.dev/runtime-capacity-drain")))' <<<"$nodes" >/dev/null
}

wait_for_low() {
	local phase=$1 timeout=$2 began=$SECONDS last_report=0
	while ((SECONDS - began < timeout)); do
		if cell_is_low actor-bj-a01 && cell_is_low actor-bj-b01; then
			printf 'capacity_phase=%s status=low elapsed_seconds=%d\n' "$phase" "$((SECONDS - began))" | tee -a "$out/state.log" || return 1
			return 0
		fi
		if ((SECONDS - last_report >= 300)); then
			printf 'capacity_phase=%s status=waiting elapsed_seconds=%d\n' "$phase" "$((SECONDS - began))" | tee -a "$out/state.log" || return 1
			last_report=$SECONDS
		fi
		sleep 30 || return 1
	done
	echo "$phase capacity convergence timed out" >&2
	return 1
}

# This is a real low-origin qualification. Starting from pre-provisioned
# capacity would prove load serving but not unattended expansion.
wait_for_low initial 43200

python3.11 "$observer" \
	--base "$out/observer-input" --output "$out/capacity.ndjson" \
	--seconds 172800 --interval 15 \
	--federation-a "$incoming/actor-bj-a01-federation-endpoint.json" \
	--federation-b "$incoming/actor-bj-b01-federation-endpoint.json" \
	>"$out/observer.log" 2>&1 &
observer_pid=$!
cleanup() {
	kill -TERM "$observer_pid" 2>/dev/null || true
	wait "$observer_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
sleep 20

set +e
"$node" "$runner" \
	--endpoint "$endpoint" --output "$out/load" --run-id "$run_id" \
	--count 11000 --rate 20 --active 10000 --workers 16 \
	--warmup 10000 --warmup-rate 2 --warmup-settle-ms 120000 \
	--active-interval-ms 10000 --observe-after-ms 600000 \
	--timeout-ms 30000 --max-in-flight 2048 \
	--max-consecutive-failures 100 --retries 3 --ready-slo-ms 3000 \
	>"$out/load.log" 2>&1
load_status=$?
set -e
printf 'load_exit_status=%d\n' "$load_status" | tee -a "$out/state.log"

# Every qualification owns its deterministic Object identities.  Cleanup is
# mandatory even when the load verdict failed; otherwise repeated capacity
# experiments silently consume the Cell's logical-byte admission budget.
cleanup_status=1
if [[ -f $out/load/receipt.json ]]; then
	set +e
	python3.11 "$cleanup_tool" \
		--endpoint "$endpoint" --receipt "$out/load/receipt.json" \
		--manifest "$out/cleanup.sqlite" --output "$out/cleanup-receipt.json" \
		--concurrency 64 --batch-size 1024 --rate 100 --retries 8 \
		>"$out/cleanup.log" 2>&1
	cleanup_status=$?
	set -e
fi
printf 'cleanup_exit_status=%d\n' "$cleanup_status" | tee -a "$out/state.log"

# Even a failed load waits for the production sleep/drain path. A timeout is
# failure evidence, not permission to force capacity down. Capture it before
# stopping the observer so set -e cannot skip the final verifier/failed receipt.
final_capacity_status=0
wait_for_low final 129600 || final_capacity_status=$?
printf 'final_capacity_exit_status=%d\n' "$final_capacity_status" | tee -a "$out/state.log"
sleep 45
cleanup
trap - EXIT INT TERM

set +e
python3.11 "$verifier" \
	--trace "$out/capacity.ndjson" --load-receipt "$out/load/receipt.json" \
	--cleanup-receipt "$out/cleanup-receipt.json" \
	--output "$out/receipt.json" --expected-active 10000 --expected-objects 11000 \
	--floor-per-cell 4 --hard-active-per-host 32 \
	--load-exit-status "$load_status" --cleanup-exit-status "$cleanup_status" \
	--final-capacity-exit-status "$final_capacity_status"
verification_status=$?
set -e
if ((load_status != 0 || cleanup_status != 0 || final_capacity_status != 0 || verification_status != 0)); then
	printf 'ten_thousand_active_qualification=failed run_id=%s load_exit_status=%d cleanup_exit_status=%d final_capacity_exit_status=%d verifier_exit_status=%d\n' \
		"$run_id" "$load_status" "$cleanup_status" "$final_capacity_status" "$verification_status"
	exit 1
fi
printf 'ten_thousand_active_qualification=passed run_id=%s receipt=%s\n' "$run_id" "$out/receipt.json"
