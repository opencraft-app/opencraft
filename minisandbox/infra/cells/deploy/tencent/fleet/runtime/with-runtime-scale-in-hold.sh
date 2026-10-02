#!/usr/bin/env bash
set -euo pipefail

[[ $# -gt 0 ]] || { echo "usage: with-runtime-scale-in-hold.sh COMMAND [ARG...]" >&2; exit 2; }
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
cell=${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")
annotation=fleet.actor.dev/runtime-release-hold
protocol=statefulset-uid-cas-v1
statefulset=${cell}-runtime-hosts
hold_id=qualification-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
hold_builder=$script_dir/build-runtime-scale-in-hold-patch.py
capacity_settle_checker=$script_dir/check-runtime-capacity-settle.py
runtime_machine_set=${RUNTIME_MACHINE_SET:-np-runtime0}
temporary=$(mktemp -d /data/tmp/runtime-scale-in-hold.XXXXXX)
acquired=false
for artifact in "$hold_builder" "$capacity_settle_checker"; do
	[[ -f $artifact ]] || { echo "runtime scale-in hold helper is missing: $artifact" >&2; exit 2; }
done

wait_for_runtime_capacity_settle() {
	local deadline=$((SECONDS + 900)) status reason previous_reason=
	while ((SECONDS < deadline)); do
		kubectl "${kubeconfig_args[@]}" get machineset "$runtime_machine_set" \
			-o json >"$temporary/runtime-capacity-settle-machineset.json"
		kubectl "${kubeconfig_args[@]}" get nodes \
			-l "node.tke.cloud.tencent.com/machineset=${runtime_machine_set}" \
			-o json >"$temporary/runtime-capacity-settle-nodes.json"
		set +e
		reason=$(python3 "$capacity_settle_checker" \
			--machineset "$temporary/runtime-capacity-settle-machineset.json" \
			--nodes "$temporary/runtime-capacity-settle-nodes.json")
		status=$?
		set -e
		if ((status == 0)); then
			echo "runtime capacity is settled under scale-in hold"
			return 0
		fi
		((status == 75)) || return "$status"
		if [[ $reason != "$previous_reason" ]]; then
			echo "runtime capacity settle waiting: $reason" >&2
			previous_reason=$reason
		fi
		sleep 2
	done
	echo "runtime capacity did not settle under scale-in hold within 900 seconds" >&2
	return 1
}

release_hold() {
	[[ $acquired == true ]] || return 0
	local deadline=$((SECONDS + 120)) status
	while ((SECONDS < deadline)); do
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "$statefulset" \
			-o json >"$temporary/current.json" || return 1
		set +e
		python3 - "$temporary/current.json" "$temporary/identity.json" \
			"$temporary/release.json" "$annotation" <<'PY'
import json, sys
source, identity_path, patch_path, annotation = sys.argv[1:]
document = json.load(open(source))
metadata = document["metadata"]
annotations = metadata.get("annotations") or {}
expected = json.load(open(identity_path))
raw = annotations.get(annotation)
if raw is None:
    raise SystemExit("owned runtime scale-in hold disappeared")
try:
    observed = json.loads(raw)
except ValueError as error:
    raise SystemExit("owned runtime scale-in hold became malformed") from error
if observed != expected:
    raise SystemExit("runtime scale-in hold identity changed")
path = "/metadata/annotations/" + annotation.replace("~", "~0").replace("/", "~1")
json.dump([
    {"op": "test", "path": "/metadata/uid", "value": metadata["uid"]},
    {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
    {"op": "test", "path": path, "value": raw},
    {"op": "remove", "path": path},
], open(patch_path, "w"))
PY
		status=$?
		set -e
		((status == 0)) || return "$status"
		if kubectl "${kubeconfig_args[@]}" -n "$namespace" patch statefulset "$statefulset" \
			--type=json --patch-file "$temporary/release.json" >/dev/null 2>&1; then
			acquired=false
			echo "runtime scale-in hold released: $hold_id"
			return 0
		fi
		sleep 1
	done
	echo "runtime scale-in hold release exceeded 120 seconds" >&2
	return 1
}

cleanup() {
	local status=$?
	trap - EXIT INT TERM
	if ! release_hold; then
		echo "runtime scale-in hold remains latched; scale-in stays fail-closed" >&2
		((status != 0)) || status=70
	fi
	rm -rf -- "$temporary"
	exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell}-host-drain" \
	-o jsonpath='{.spec.template.metadata.annotations.fleet\.actor\.dev/runtime-release-hold-protocol}') == "$protocol" ]] || {
	echo "Host drain controller does not support the required runtime scale-in hold protocol" >&2
	exit 1
}

deadline=$((SECONDS + 900))
previous_reason=
while ((SECONDS < deadline)); do
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "$statefulset" \
		-o json >"$temporary/current.json"
	acquired_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
	set +e
	python3 "$hold_builder" \
		--statefulset "$temporary/current.json" \
		--patch "$temporary/acquire.json" \
		--identity "$temporary/identity.json" \
		--hold-id "$hold_id" --acquired-at "$acquired_at" \
		2>"$temporary/wait-reason"
	status=$?
	set -e
	if ((status == 75)); then
		reason=$(<"$temporary/wait-reason")
		if [[ $reason != "$previous_reason" ]]; then
			echo "runtime scale-in hold waiting: $reason" >&2
			previous_reason=$reason
		fi
		sleep 2
		continue
	fi
	((status == 0)) || { cat "$temporary/wait-reason" >&2; exit "$status"; }
	if kubectl "${kubeconfig_args[@]}" -n "$namespace" patch statefulset "$statefulset" \
		--type=json --patch-file "$temporary/acquire.json" >/dev/null 2>&1; then
		acquired=true
		echo "runtime scale-in hold acquired: $hold_id"
		break
	fi
	sleep 1
done
[[ $acquired == true ]] || { echo "runtime scale-in hold acquisition exceeded 900 seconds" >&2; exit 1; }

wait_for_runtime_capacity_settle
RUNTIME_SCALE_IN_HOLD_HELD=1 "$@"
