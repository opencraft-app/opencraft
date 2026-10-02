#!/usr/bin/env bash
set -euo pipefail

usage() { echo "Usage: publish-qualified-release.sh ABSOLUTE_AUTONOMY_CONTROL.json" >&2; }
[[ $# -eq 1 ]] || { usage; exit 2; }
control=$(readlink -e "$1")
[[ -f $control && $control == /* ]] || { echo "control receipt must be an existing absolute file" >&2; exit 2; }

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
: "${CELL:=${RIVET_CELL_NAME:-}}"
: "${CELL:?CELL or RIVET_CELL_NAME must name the exact Cell to activate}"
cell=$CELL
namespace=${CELL_NAMESPACE:-${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}}
kubeconfig=${KUBECONFIG_PATH:-${KUBECONFIG:-}}
kubectl=${KUBECTL:-kubectl}
receipt_dir=${QUALIFICATION_RECEIPT_DIR:-/data/actor-qualification/receipts}
[[ -f $kubeconfig ]] || { echo "Cell kubeconfig is required" >&2; exit 2; }
[[ $cell =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ && $namespace =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ ]] || {
	echo "Cell identity is invalid" >&2; exit 2;
}
for command in "$kubectl" jq python3 sha256sum; do
	command -v "$command" >/dev/null || { echo "missing qualification publisher command: $command" >&2; exit 2; }
done

if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec "$script_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
fi
AUTONOMY_WORKFLOW=qualification.publish \
AUTONOMY_CONTROL_FILE="$control" \
AUTONOMY_CONTROL_CELL="$cell" \
AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	"$script_dir/assert-autonomy-control.sh" >/dev/null

temporary=$(mktemp -d /data/tmp/qualification-activation.XXXXXX)
receipt_temporary=
trap 'rm -rf -- "$temporary"; [[ -z $receipt_temporary ]] || rm -f -- "$receipt_temporary"' EXIT INT TERM
kube=("$kubectl" --kubeconfig "$kubeconfig" -n "$namespace")
"${kube[@]}" get deployment "${cell}-engine" -o json >"$temporary/deployment.json"
"${kube[@]}" get statefulset "${cell}-runtime-hosts" -o json >"$temporary/statefulset.json"
"${kube[@]}" get pods -o json >"$temporary/pods.json"
python3 "$script_dir/plan-qualification-activation.py" \
	--control "$control" --deployment "$temporary/deployment.json" \
	--statefulset "$temporary/statefulset.json" --pods "$temporary/pods.json" \
	--output "$temporary/plan.json"

plan_cell=$(jq -er '.cell' "$temporary/plan.json")
plan_namespace=$(jq -er '.namespace' "$temporary/plan.json")
[[ $plan_cell == "$cell" && $plan_namespace == "$namespace" ]] || {
	echo "qualification plan changed the Cell identity" >&2; exit 1;
}
control_sha=$(jq -er '.control_receipt_sha256' "$temporary/plan.json")
receipt_ref=$(jq -er '.qualification.receipt_ref' "$temporary/plan.json")
receipt_digest=$(jq -er '.qualification.receipt_digest' "$temporary/plan.json")
release_digest=$(jq -er '.qualification.release_digest' "$temporary/plan.json")

# Publish the exact control bytes as an immutable in-cluster availability root
# before any admission state can refer to it.
CELL="$cell" CELL_NAMESPACE="$namespace" KUBECONFIG_PATH="$kubeconfig" \
QUALIFICATION_RECEIPT_DIR=$(dirname -- "$control") \
	"$script_dir/cache-qualification-receipt.sh" "$control" >/dev/null
cache_name=actor-evidence-${cell}-${control_sha:0:20}
cache=$("${kube[@]}" get configmap "$cache_name" -o json)
jq -e --arg sha "$control_sha" '
  .immutable == true and .metadata.annotations["evidence.actor.dev/sha256"] == $sha
' <<<"$cache" >/dev/null

started_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
"${kube[@]}" set env deployment/"${cell}-cell-reporter" \
	CAPACITY_RISK=Normal QUALIFICATION_READY=true \
	QUALIFICATION_RECEIPT="$receipt_ref" QUALIFICATION_DIGEST="$receipt_digest" \
	QUALIFICATION_RELEASE_DIGEST="$release_digest" >/dev/null
"${kube[@]}" rollout status deployment/"${cell}-cell-reporter" --timeout=5m >/dev/null

deadline=$((SECONDS + 180))
while ((SECONDS < deadline)); do
	if report=$("${kube[@]}" get rivetcellreport "$cell" -o json 2>/dev/null) && \
		jq -e --arg ref "$receipt_ref" --arg digest "$receipt_digest" --arg release "$release_digest" '
          .spec.releaseDigest == $release and
          .spec.qualification.ready == true and
          .spec.qualification.receiptRef == $ref and
          .spec.qualification.receiptDigest == $digest and
          .spec.qualification.releaseDigest == $release
        ' <<<"$report" >/dev/null; then
		break
	fi
	sleep 2
done
((SECONDS < deadline)) || { echo "release-bound qualification report did not converge" >&2; exit 1; }

cell_json=$("${kube[@]}" get rivetcell "$cell" -o json)
desired=$(jq -er '.spec.desiredState' <<<"$cell_json")
cell_uid=$(jq -er '.metadata.uid' <<<"$cell_json")
case "$desired" in
Ready) ;;
Provisioning | Qualifying)
	resource_version=$(jq -er '.metadata.resourceVersion' <<<"$cell_json")
	patch=$(jq -cn --arg uid "$cell_uid" --arg rv "$resource_version" --arg old "$desired" '[
      {op:"test",path:"/metadata/uid",value:$uid},
      {op:"test",path:"/metadata/resourceVersion",value:$rv},
      {op:"test",path:"/spec/desiredState",value:$old},
      {op:"replace",path:"/spec/desiredState",value:"Ready"}
    ]')
	"${kube[@]}" patch rivetcell "$cell" --type=json -p "$patch" >/dev/null
	;;
*) echo "Cell desiredState $desired cannot be activated" >&2; exit 1 ;;
esac

deadline=$((SECONDS + 300))
while ((SECONDS < deadline)); do
	ready=$("${kube[@]}" get rivetcell "$cell" -o jsonpath='{.status.readyForPlacement}' 2>/dev/null || true)
	[[ $ready == true ]] && break
	sleep 2
done
((SECONDS < deadline)) || { echo "Cell remained closed after exact qualification publication" >&2; exit 1; }

final_cell_json=$("${kube[@]}" get rivetcell "$cell" -o json)
jq -e --arg uid "$cell_uid" '
  .metadata.uid == $uid and
  .metadata.generation == .status.observedGeneration and
  .spec.desiredState == "Ready" and
  .status.phase == "Ready" and
  .status.readyForPlacement == true and
  .status.capacityRisk == "Normal"
' <<<"$final_cell_json" >/dev/null || {
	echo "Cell identity or final admission status changed before receipt publication" >&2; exit 1;
}
cell_generation=$(jq -er '.metadata.generation' <<<"$final_cell_json")
cell_observed_generation=$(jq -er '.status.observedGeneration' <<<"$final_cell_json")
cell_profile_digest=$(jq -er '.metadata.annotations["fleet.actor.dev/profile-digest"]' <<<"$final_cell_json")
[[ $cell_profile_digest =~ ^sha256:[0-9a-f]{64}$ ]] || {
	echo "Cell profile digest is absent from the admitted identity" >&2; exit 1;
}

mkdir -p "$receipt_dir"
run_id=$(date -u +%Y%m%dT%H%M%SZ)-${control_sha:0:12}
receipt=$receipt_dir/${cell}-qualification-activation-${run_id}.json
[[ ! -e $receipt ]] || { echo "qualification activation receipt already exists: $receipt" >&2; exit 1; }
receipt_temporary=$(mktemp "$receipt_dir/.${cell}-qualification-activation.XXXXXX")
finished_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
jq -n --arg cell "$cell" --arg namespace "$namespace" --arg started "$started_at" \
	--arg finished "$finished_at" --arg control "$control" --arg control_sha "$control_sha" \
	--arg ref "$receipt_ref" --arg digest "$receipt_digest" --arg release "$release_digest" \
	--arg uid "$cell_uid" --arg profile "$cell_profile_digest" \
	--argjson generation "$cell_generation" --argjson observed_generation "$cell_observed_generation" \
	--slurpfile plan "$temporary/plan.json" '{
      schema:"actor-cell-qualification-activation/v1", verdict:"passed",
      cell:$cell, namespace:$namespace, started_at:$started, finished_at:$finished,
      cell_identity:{uid:$uid,generation:$generation,observed_generation:$observed_generation,profile_digest:$profile},
      control_receipt:$control, control_receipt_sha256:$control_sha,
      qualification:{receipt_ref:$ref,receipt_digest:$digest,release_digest:$release},
      desired_state:"Ready", ready_for_placement:true, activation_plan:$plan[0]
    }' >"$receipt_temporary"
chmod 0644 "$receipt_temporary"
python3 - "$receipt_temporary" <<'PY'
import os,sys
descriptor=os.open(sys.argv[1], os.O_RDONLY)
try: os.fsync(descriptor)
finally: os.close(descriptor)
PY
ln "$receipt_temporary" "$receipt"
rm -f -- "$receipt_temporary"
receipt_temporary=
CELL="$cell" CELL_NAMESPACE="$namespace" KUBECONFIG_PATH="$kubeconfig" \
	"$script_dir/cache-qualification-receipt.sh" "$receipt" >/dev/null
printf 'qualification_activation=passed receipt=%s sha256=%s release=%s\n' \
	"$receipt" "$(sha256sum "$receipt" | cut -d' ' -f1)" "$release_digest"
