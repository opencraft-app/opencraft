#!/usr/bin/env bash
set -euo pipefail
umask 077

run_id=${1:?usage: run-on-builder.sh RUN_ID}
[[ $run_id =~ ^[a-f0-9]{32}$ ]] || { echo "RUN_ID must be 32 lowercase hex characters" >&2; exit 2; }

source_root=${ACTOR_REVIEWED_SOURCE:?ACTOR_REVIEWED_SOURCE must name the immutable reviewed source}
base=${ACTOR_BOOTSTRAP_ROOT:-/data/actor-bootstrap/beijing-rebuild-20260915}
out=$base/load-tests/workers-api-autoscaling-$run_id
kubeconfig=$base/input/management.kubeconfig
node=${ACTOR_NODE_BINARY:-$base/tools/node24/bin/node}
runner=$source_root/infra/cells/deploy/tencent/fleet/load/stateless-autoscaling/runner.mjs
observer=$source_root/infra/cells/deploy/tencent/fleet/load/workers-api-autoscaling/observe.py
verifier=$source_root/infra/cells/deploy/tencent/fleet/load/workers-api-autoscaling/verify.py
lock=$base/load-tests/workers-api-autoscaling.lock
floor=3
cells=(actor-bj-a01 actor-bj-b01)

test -x "$node"
test -f "$kubeconfig" && test ! -L "$kubeconfig"
test -f "$runner" && test -f "$observer" && test -f "$verifier"
test ! -e "$out"
install -d -m 0700 "$out"
exec 9>"$lock"
flock -n 9 || { echo "another Workers API autoscaling qualification is running" >&2; exit 75; }

endpoint=$(jq -er '.endpoint' "$base/receipts/workers-api/endpoint-installation.json")/v1
[[ $endpoint == http://*/v1 || $endpoint == https://*/v1 ]]
for cell in "${cells[@]}"; do
	test -f "$base/cells/$cell/cell.kubeconfig"
done

is_low() {
	local hpa deployment
	hpa=$(kubectl --kubeconfig "$kubeconfig" -n workers-api-system get hpa workers-api -o json) || return 1
	deployment=$(kubectl --kubeconfig "$kubeconfig" -n workers-api-system get deployment workers-api -o json) || return 1
	jq -e --argjson floor "$floor" '
      .spec.minReplicas==$floor and .spec.maxReplicas==30 and
      .spec.behavior.scaleDown.stabilizationWindowSeconds==300 and
      .status.currentReplicas==$floor and .status.desiredReplicas==$floor and
      any(.status.conditions[]?; .type=="ScalingActive" and .status=="True") and
      ([.status.currentMetrics[]? | select(.type=="Pods") | .pods.metric.name] | sort) ==
        ["workers_api_routing_requests_in_flight","workers_api_routing_requests_per_second"]
    ' <<<"$hpa" >/dev/null || return 1
	jq -e --argjson floor "$floor" '
      .spec.replicas==$floor and .status.readyReplicas==$floor and
      .status.availableReplicas==$floor and .status.observedGeneration==.metadata.generation
    ' <<<"$deployment" >/dev/null
}

wait_for_low() {
	local phase=$1 timeout=$2 began=$SECONDS
	while ((SECONDS - began < timeout)); do
		if is_low; then
			printf 'router_phase=%s status=low elapsed_seconds=%d\n' "$phase" "$((SECONDS-began))" | tee -a "$out/state.log"
			return 0
		fi
		sleep 10
	done
	echo "$phase Workers API capacity convergence timed out" >&2
	return 1
}

cell_is_low() {
	local cell=$1
	local config=$base/cells/$cell/cell.kubeconfig
	local hpa deployment machine_set state nodes
	hpa=$(kubectl --kubeconfig "$config" -n actor-stateless-system get hpa "${cell}-stateless-executor" -o json) || return 1
	jq -e --argjson floor "$floor" '
      .status.currentReplicas==$floor and .status.desiredReplicas==$floor and
      any(.status.conditions[]?; .type=="ScalingActive" and .status=="True")
    ' <<<"$hpa" >/dev/null || return 1
	deployment=$(kubectl --kubeconfig "$config" -n actor-stateless-system get deployment "${cell}-stateless-executor" -o json) || return 1
	jq -e --argjson floor "$floor" '
      .spec.replicas==$floor and .status.readyReplicas==$floor and .status.availableReplicas==$floor
    ' <<<"$deployment" >/dev/null || return 1
	machine_set=$(jq -er '.metadata.annotations["fleet.actor.dev/stateless-machine-set"]' <<<"$deployment") || return 1
	state=$(kubectl --kubeconfig "$config" get machineset "$machine_set" -o json) || return 1
	jq -e --argjson floor "$floor" '
      .spec.replicas==$floor and .status.replicas==$floor and .status.readyReplicas==$floor
    ' <<<"$state" >/dev/null || return 1
	nodes=$(kubectl --kubeconfig "$config" get nodes -l "node.tke.cloud.tencent.com/machineset=$machine_set" -o json) || return 1
	jq -e --argjson floor "$floor" '.items|length==$floor and all(.[];
      .metadata.labels["fleet.actor.dev/stateless-admitted"]=="true" and
      any(.status.conditions[]?; .type=="Ready" and .status=="True"))' <<<"$nodes" >/dev/null
}

wait_for_dependent_low() {
	local phase=$1 timeout=$2 began=$SECONDS
	while ((SECONDS - began < timeout)); do
		if cell_is_low actor-bj-a01 && cell_is_low actor-bj-b01; then
			jq -cn --arg phase "$phase" --argjson elapsed "$((SECONDS-began))" \
				'{phase:$phase,elapsedSeconds:$elapsed,cells:{"actor-bj-a01":{pods:3,nodes:3},"actor-bj-b01":{pods:3,nodes:3}}}' \
				>>"$out/dependent-capacity.ndjson"
			printf 'dependent_phase=%s status=low elapsed_seconds=%d\n' "$phase" "$((SECONDS-began))" | tee -a "$out/state.log"
			return 0
		fi
		sleep 20
	done
	echo "$phase dependent stateless capacity convergence timed out" >&2
	return 1
}

# This gate observes the exact production policy. It never patches the HPA or
# Deployment, so a pass proves the configured metric and timers are sufficient.
wait_for_low initial 1200
wait_for_dependent_low initial 14400
python3.11 "$observer" --kubeconfig "$kubeconfig" --output "$out/capacity.ndjson" \
	--seconds 3600 --interval 5 >"$out/observer.log" 2>&1 &
observer_pid=$!
cleanup() {
	kill -TERM "$observer_pid" 2>/dev/null || true
	wait "$observer_pid" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
sleep 15
kill -0 "$observer_pid" 2>/dev/null || { cat "$out/observer.log" >&2; exit 1; }
test -s "$out/capacity.ndjson" || { echo "capacity observer produced no sample" >&2; exit 1; }

set +e
"$node" "$runner" --endpoint "$endpoint" --output "$out/load" --run-id "$run_id" \
	--duration-ms 90000 --hold-ms 180000 --rate 2.5 --max-in-flight 300 \
	--request-timeout-ms 240000 >"$out/load.log" 2>&1
load_status=$?
set -e
printf 'load_exit_status=%d\n' "$load_status" | tee -a "$out/state.log"

wait_for_low final 2400
wait_for_dependent_low final 14400
sleep 30
cleanup
trap - EXIT INT TERM
python3.11 "$verifier" --trace "$out/capacity.ndjson" --load-receipt "$out/load/receipt.json" \
	--dependent-capacity "$out/dependent-capacity.ndjson" \
	--output "$out/receipt.json" --floor "$floor" --minimum-requests 200
test "$load_status" = 0
printf 'workers_api_autoscaling_qualification=passed run_id=%s receipt=%s\n' "$run_id" "$out/receipt.json"
