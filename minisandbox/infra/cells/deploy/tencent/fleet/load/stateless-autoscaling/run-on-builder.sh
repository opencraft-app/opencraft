#!/usr/bin/env bash
set -euo pipefail
umask 077

run_id=${1:?usage: run-on-builder.sh RUN_ID}
[[ $run_id =~ ^[a-f0-9]{32}$ ]] || { echo "RUN_ID must be 32 lowercase hex characters" >&2; exit 2; }

source_root=${ACTOR_REVIEWED_SOURCE:?ACTOR_REVIEWED_SOURCE must name the immutable reviewed source}
base=${ACTOR_BOOTSTRAP_ROOT:-/data/actor-bootstrap/beijing-rebuild-20260915}
out=$base/load-tests/stateless-autoscaling-$run_id
node=${ACTOR_NODE_BINARY:-$base/tools/node24/bin/node}
runner=$source_root/infra/cells/deploy/tencent/fleet/load/stateless-autoscaling/runner.mjs
observer=$source_root/infra/cells/deploy/tencent/fleet/load/stateless-autoscaling/observe.py
verifier=$source_root/infra/cells/deploy/tencent/fleet/load/stateless-autoscaling/verify.py
lock=$base/load-tests/stateless-autoscaling.lock
namespace=actor-stateless-system
floor=3
cells=(actor-bj-a01 actor-bj-b01)

test -x "$node"
test -f "$runner" && test -f "$observer" && test -f "$verifier"
test ! -e "$out"
install -d -m 0700 "$out"
exec 9>"$lock"
flock -n 9 || { echo "another stateless autoscaling qualification is running" >&2; exit 75; }

endpoint=$(jq -er '.endpoint' "$base/receipts/workers-api/endpoint-installation.json")/v1
[[ $endpoint == http://*/v1 || $endpoint == https://*/v1 ]]
for cell in "${cells[@]}"; do
	test -f "$base/cells/$cell/cell.kubeconfig"
done

cell_hpa_metrics_are_active() {
	local cell=$1 config=$base/cells/$1/cell.kubeconfig state
	state=$(kubectl --kubeconfig "$config" -n "$namespace" get hpa "${cell}-stateless-executor" -o json) || return 1
	jq -e '
      any(.status.conditions[]?; .type=="ScalingActive" and .status=="True") and
      ([.status.currentMetrics[]? | select(.type=="External") | .external.metric.name] | sort) ==
        ["rivet_stateless_in_flight_total", "rivet_stateless_peak_in_flight", "rivet_stateless_queued_total"]
    ' <<<"$state" >/dev/null
}

wait_for_hpa_metrics() {
	local began=$SECONDS
	while ((SECONDS - began < 600)); do
		if cell_hpa_metrics_are_active actor-bj-a01 && cell_hpa_metrics_are_active actor-bj-b01; then
			printf 'capacity_phase=metrics status=active elapsed_seconds=%d\n' "$((SECONDS - began))" | tee -a "$out/state.log"
			return 0
		fi
		sleep 10
	done
	echo "stateless HPA external metrics did not become active" >&2
	return 1
}

cell_is_low() {
	local cell=$1 config=$base/cells/$1/cell.kubeconfig state nodes runtime_image runtime_digest machine_set
	state=$(kubectl --kubeconfig "$config" -n "$namespace" get hpa "${cell}-stateless-executor" -o json) || return 1
	jq -e --argjson floor "$floor" '.spec.minReplicas==$floor and .status.currentReplicas==$floor and .status.desiredReplicas==$floor' <<<"$state" >/dev/null || return 1
	state=$(kubectl --kubeconfig "$config" -n "$namespace" get deployment "${cell}-stateless-executor" -o json) || return 1
	jq -e --argjson floor "$floor" '.spec.replicas==$floor and .status.readyReplicas==$floor and .status.availableReplicas==$floor and .status.observedGeneration==.metadata.generation' <<<"$state" >/dev/null || return 1
	runtime_image=$(jq -er '.spec.template.spec.containers[]|select(.name=="workerd")|.image' <<<"$state") || return 1
	runtime_digest=$(jq -er '.spec.template.metadata.annotations["fleet.actor.dev/runtime-digest"]' <<<"$state") || return 1
	machine_set=$(jq -er '.metadata.annotations["fleet.actor.dev/stateless-machine-set"]' <<<"$state") || return 1
	[[ $machine_set =~ ^np-[a-z0-9]{8}$ ]] || return 1
	[[ $runtime_digest =~ ^sha256:[0-9a-f]{64}$ && $runtime_image == *@"$runtime_digest" ]] || return 1
	state=$(kubectl --kubeconfig "$config" get machineset "$machine_set" -o json) || return 1
	jq -e --argjson floor "$floor" '.spec.replicas==$floor and .status.replicas==$floor and .status.readyReplicas==$floor and .spec.scaling.minReplicas==$floor' <<<"$state" >/dev/null || return 1
	nodes=$(kubectl --kubeconfig "$config" get nodes -l "node.tke.cloud.tencent.com/machineset=$machine_set" -o json) || return 1
	jq -e --argjson floor "$floor" --arg image "$runtime_image" '.items|length==$floor and all(.[];
      .metadata.labels["fleet.actor.dev/stateless-admitted"]=="true" and
      ((.metadata.annotations["fleet.actor.dev/stateless-admission-state"]|fromjson) as $state |
        $state.phase=="Admitted" and $state.identity.runtime_image==$image and
        ($state.identity.profile_digest|type=="string") and ($state.identity.profile_digest|length)>0) and
      any(.status.conditions[]; .type=="Ready" and .status=="True") and
      all(.spec.taints[]?; .key!="startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission"))' <<<"$nodes" >/dev/null
}

wait_for_low() {
	local phase=$1 timeout=$2 began=$SECONDS last_report=0
	while ((SECONDS - began < timeout)); do
		if cell_is_low actor-bj-a01 && cell_is_low actor-bj-b01; then
			printf 'capacity_phase=%s status=low elapsed_seconds=%d\n' "$phase" "$((SECONDS - began))" | tee -a "$out/state.log"
			return 0
		fi
		if ((SECONDS - last_report >= 300)); then
			printf 'capacity_phase=%s status=waiting elapsed_seconds=%d\n' "$phase" "$((SECONDS - began))" | tee -a "$out/state.log"
			last_report=$SECONDS
		fi
		sleep 20
	done
	echo "$phase stateless capacity convergence timed out" >&2
	return 1
}

# Starting from already inflated capacity would prove request serving, not
# unattended scale-from-floor behavior.
wait_for_hpa_metrics
wait_for_low initial 14400

python3.11 "$observer" \
	--cell "actor-bj-a01=$base/cells/actor-bj-a01/cell.kubeconfig" \
	--cell "actor-bj-b01=$base/cells/actor-bj-b01/cell.kubeconfig" \
	--output "$out/capacity.ndjson" --seconds 21600 --interval 10 \
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
	--duration-ms 900000 --hold-ms 450000 --rate 2.5 \
	--max-in-flight 1500 --request-timeout-ms 510000 \
	>"$out/load.log" 2>&1
load_status=$?
set -e
printf 'load_exit_status=%d\n' "$load_status" | tee -a "$out/state.log"

# HPA has a five-minute stabilization window and TKE owns the later Node
# contraction. Observe those real timers instead of patching desired state.
wait_for_low final 14400
sleep 20
cleanup
trap - EXIT INT TERM

set +e
python3.11 "$verifier" \
	--trace "$out/capacity.ndjson" --load-receipt "$out/load/receipt.json" \
	--output "$out/receipt.json" --cell actor-bj-a01 --cell actor-bj-b01 --floor "$floor"
verify_status=$?
set -e
test "$load_status" = 0
test "$verify_status" = 0
printf 'stateless_autoscaling_qualification=passed run_id=%s receipt=%s\n' "$run_id" "$out/receipt.json"
