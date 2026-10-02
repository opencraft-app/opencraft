#!/usr/bin/env bash
set -euo pipefail

usage() {
	echo "Usage: kick-gasoline-pruner.sh CELL NAMESPACE KUBECONFIG" >&2
}
[[ $# -eq 3 ]] || { usage; exit 2; }
cell=$1
namespace=$2
kubeconfig=$3
kubectl_bin=${KUBECTL:-kubectl}

[[ $cell =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "Cell must be a DNS label" >&2
	exit 2
}
[[ $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "namespace is invalid" >&2
	exit 2
}
kubeconfig_args=()
if [[ $kubeconfig != - ]]; then
	[[ -f $kubeconfig ]] || { echo "kubeconfig does not exist" >&2; exit 2; }
	kubeconfig_args=(--kubeconfig "$kubeconfig")
fi

runtime_config=$($kubectl_bin "${kubeconfig_args[@]}" -n "$namespace" \
	get configmap "${cell}-runtime-config" -o json)
read -r configured_cell interval_seconds < <(
	jq -er '.data["config.jsonc"] | fromjson | .runtime |
    [.gasoline_cell_namespace, .gasoline_prune_interval_duration] | @tsv' \
		<<<"$runtime_config"
)
[[ $configured_cell == "$cell" && $interval_seconds =~ ^[0-9]+$ ]] || {
	echo "runtime ConfigMap is not bound to the exact Cell" >&2
	exit 1
}
((interval_seconds >= 1 && interval_seconds <= 43200)) || {
	echo "Gasoline prune interval is outside the reviewed operating bound" >&2
	exit 1
}

mapfile -t engine_pods < <(
	$kubectl_bin "${kubeconfig_args[@]}" -n "$namespace" get pods \
		-l "fleet.actor.dev/cell-name=${cell},fleet.actor.dev/component=engine" -o json |
		jq -er '.items[] | select(.status.phase == "Running") |
      select(any(.status.conditions[]?; .type == "Ready" and .status == "True")) |
      .metadata.name' | sort
)
[[ ${#engine_pods[@]} -ge 1 ]] || {
	echo "Cell has no Ready Engine Pod" >&2
	exit 1
}
pod=${engine_pods[0]}
engine() {
	$kubectl_bin "${kubeconfig_args[@]}" -n "$namespace" exec "$pod" -c engine -- \
		/opt/actor/bin/rivet-engine --config /etc/actor/runtime/config.jsonc "$@"
}

# This is the indexed, null-tag lookup written for every workflow. Limit two
# so an invariant violation is detected without scanning the workflow table.
query="ls 0/1/2/str:${cell}/workflow/by_name_and_tag/str:gasoline_pruner/str:/str: --limit 2 --style list"
lookup=$(engine udb -q "$query" 2>&1)
mapfile -t ids < <(
	sed -nE 's#^[[:space:]]+/([a-z0-9]{30}) = \[\]$#\1#p' <<<"$lookup"
)
[[ ${#ids[@]} -eq 1 ]] || {
	echo "expected exactly one indexed gasoline_pruner; found ${#ids[@]}" >&2
	exit 1
}
workflow_id=${ids[0]}

state=
for _ in $(seq 1 30); do
	before=$(engine wf get "$workflow_id" 2>&1 || true)
	grep -Eq '^gasoline_pruner$' <<<"$before" || {
		echo "indexed workflow is not gasoline_pruner" >&2
		exit 1
	}
	grep -Eq "^[[:space:]]+id ${workflow_id}$" <<<"$before" || {
		echo "indexed gasoline_pruner identity changed" >&2
		exit 1
	}
	state=$(sed -nE 's/^[[:space:]]+state ([a-z]+)$/\1/p' <<<"$before" | tail -1)
	[[ $state == sleeping ]] && break
	[[ $state == running ]] || {
		echo "the exact gasoline_pruner is in non-runnable state: ${state:-unknown}" >&2
		exit 1
	}
	sleep 1
done
[[ $state == sleeping ]] || {
	echo "the exact gasoline_pruner did not leave running state" >&2
	exit 1
}

engine wf wake "$workflow_id" >/dev/null 2>&1
deadline=
for _ in $(seq 1 30); do
	after=$(engine wf get "$workflow_id" 2>&1 || true)
	deadline=$(sed -nE 's/^[[:space:]]+error sleeping until ([0-9]+)$/\1/p' <<<"$after" | tail -1)
	now_ms=$(($(date +%s) * 1000))
	if [[ $deadline =~ ^[0-9]+$ ]] &&
		((deadline >= now_ms && deadline <= now_ms + (interval_seconds + 30) * 1000)); then
		printf 'gasoline_pruner_kick=passed cell=%s workflow_id=%s interval_seconds=%s deadline_ms=%s\n' \
			"$cell" "$workflow_id" "$interval_seconds" "$deadline"
		exit 0
	fi
	sleep 1
done

echo "gasoline_pruner did not complete a cycle on the active interval" >&2
exit 1
