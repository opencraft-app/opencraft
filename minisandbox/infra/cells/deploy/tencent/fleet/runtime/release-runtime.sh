#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
[[ ${RUNTIME_HOST_DRAIN_PROFILE:-production} == production ]] || {
	echo "production runtime release requires the production Host drain profile" >&2
	exit 2
}
namespace=${RIVET_CELL_NAMESPACE:-actor-fdb-cell-system}
: "${RIVET_CELL_NAME:?RIVET_CELL_NAME must name the exact Cell}"
cell_name=$RIVET_CELL_NAME
runtime_profile=${RIVET_RUNTIME_PROFILE:-production}
availability_mode=${RIVET_AVAILABILITY_MODE:-production-multi-zone}
gasoline_storage_profile_enforce=${RIVET_GASOLINE_STORAGE_PROFILE_ENFORCE:-0}
case "$availability_mode" in
production-multi-zone) required_topology_zones=3 ;;
qualification-single-zone) required_topology_zones=1 ;;
*)
	echo "RIVET_AVAILABILITY_MODE must be production-multi-zone or qualification-single-zone" >&2
	exit 2
	;;
esac
if [[ $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ && ! ${RUNTIME_EXACT_SCALE_DOWN_ENABLED+x} ]]; then
	echo "production Cell releases must explicitly preserve or disable exact provider scale-down" >&2
	exit 2
fi
if [[ $runtime_profile == production && $cell_name =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ \
	&& $gasoline_storage_profile_enforce != 1 ]]; then
	echo "production Cell releases must resolve Gasoline retention from the bound StorageProfile" >&2
	exit 2
fi
ACTOR_IMAGE_LOCK_TOOL=$script_dir/../gitops/image-seed/image-lock.py
# shellcheck source=../gitops/image-seed/bind-inventory.sh
source "$script_dir/../gitops/image-seed/bind-inventory.sh"
actor_image_inventory_require
actor_image_inventory_bind_runtime_release \
	RIVET_RUNTIME_IMAGE RIVET_SOURCE_REVISION RIVET_SOURCE_MANIFEST_SHA256 rivet-runtime
actor_image_inventory_bind RIVET_REPORTER_IMAGE actor-fleet-controller
actor_image_inventory_bind RIVET_NATS_IMAGE nats
actor_image_inventory_bind RIVET_WORKERD_METRICS_IMAGE observability-busybox
actor_image_inventory_bind_build_identity \
	RIVET_REPORTER_SOURCE_REVISION RIVET_REPORTER_SOURCE_MANIFEST_SHA256 actor-fleet-controller
runtime_image=$RIVET_RUNTIME_IMAGE
reporter_image=$RIVET_REPORTER_IMAGE
nats_image=$RIVET_NATS_IMAGE
workerd_metrics_image=$RIVET_WORKERD_METRICS_IMAGE
worker_registry_url=${RIVET_WORKER_REGISTRY_URL:?RIVET_WORKER_REGISTRY_URL must point to the private Worker registry endpoint}
cold_bucket=${RIVET_COLD_BUCKET:?RIVET_COLD_BUCKET must be the exact Terraform Cell cold bucket}
cold_region=${RIVET_COLD_REGION:-${TENCENT_REGION:-ap-beijing}}
cold_endpoint=${RIVET_COLD_ENDPOINT:-https://cos.${cold_region}.myqcloud.com}
source_revision=${RIVET_SOURCE_REVISION:?RIVET_SOURCE_REVISION must identify the expected complete source revision}
source_manifest_sha=${RIVET_SOURCE_MANIFEST_SHA256:?RIVET_SOURCE_MANIFEST_SHA256 must bind the reviewed source manifest}
reporter_source_revision=${RIVET_REPORTER_SOURCE_REVISION:?RIVET_REPORTER_SOURCE_REVISION must identify the controller image source revision}
reporter_source_manifest_sha=${RIVET_REPORTER_SOURCE_MANIFEST_SHA256:?RIVET_REPORTER_SOURCE_MANIFEST_SHA256 must bind the controller image source manifest}
operations_dir=$(CDPATH= cd -- "$script_dir/../operations" && pwd)
release_ledger_helper=$operations_dir/release_ledger.py
[[ -f $release_ledger_helper ]] || {
	echo "static release ledger helper is missing: $release_ledger_helper" >&2
	exit 2
}
release_ledger_name=${cell_name}-release-ledger
release_receipt_dir=${RIVET_RELEASE_RECEIPT_DIR:-$script_dir/receipts}
default_runtime_admission_field_manager=rivet-runtime-admission-installer
runtime_admission_field_manager=${RUNTIME_ADMISSION_FIELD_MANAGER:-$default_runtime_admission_field_manager}
runtime_admission_rollback_field_manager=rivet-runtime-admission-rollback
runtime_capacity_recovery_field_manager=rivet-runtime-capacity-recovery
runtime_rollback_field_manager=rivet-runtime-rollback
runtime_release_hold_annotation=fleet.actor.dev/runtime-release-hold
runtime_release_hold_protocol=statefulset-uid-cas-v1
runtime_release_hold_id=release-$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
runtime_release_hold_builder=$script_dir/build-runtime-scale-in-hold-patch.py
runtime_capacity_settle_checker=$script_dir/check-runtime-capacity-settle.py
runtime_machine_set=${RUNTIME_MACHINE_SET:-np-runtime0}
capacity_controller_recovery=${RUNTIME_CAPACITY_CONTROLLER_RECOVERY:-0}
case "$capacity_controller_recovery" in
0 | 1) ;;
*) echo "RUNTIME_CAPACITY_CONTROLLER_RECOVERY must be 0 or 1" >&2; exit 2 ;;
esac
capacity_recovery_helper=$script_dir/capacity-controller-recovery.py
for artifact in "$runtime_release_hold_builder" "$runtime_capacity_settle_checker"; do
	[[ -f $artifact ]] || { echo "runtime release helper is missing: $artifact" >&2; exit 2; }
done
[[ $runtime_admission_field_manager =~ ^[A-Za-z0-9_.-]{1,128}$ ]] || {
	echo "RUNTIME_ADMISSION_FIELD_MANAGER is invalid" >&2
	exit 2
}

if [[ ${AUTONOMY_CONTROL_ENFORCE:-1} != 0 ]]; then
	if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
		exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
	fi
	AUTONOMY_WORKFLOW="runtime.release" \
	AUTONOMY_CONTROL_CELL="$cell_name" \
	AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	AUTONOMY_CONTROL_DECISIONS_DIR="${AUTONOMY_CONTROL_DECISIONS_DIR:-/var/lib/actor/autonomy/decisions}" \
	"$operations_dir/assert-autonomy-control.sh"
fi

[[ $runtime_profile == production ]] || {
	echo "release-runtime.sh only accepts RIVET_RUNTIME_PROFILE=production" >&2
	exit 2
}
[[ $reporter_source_revision =~ ^[0-9a-f]{40}$ ]] || {
	echo "RIVET_REPORTER_SOURCE_REVISION must be a full 40-character commit ID" >&2
	exit 2
}
[[ $reporter_source_manifest_sha =~ ^[0-9a-f]{64}$ ]] || {
	echo "RIVET_REPORTER_SOURCE_MANIFEST_SHA256 must be a sha256 hex digest" >&2
	exit 2
}
kubeconfig_args=()
[[ -n ${KUBECONFIG:-} ]] && kubeconfig_args=(--kubeconfig "$KUBECONFIG")

temporary=$(mktemp -d)
rollout_started=false
ledger_write_started=false
ledger_existed=false
runtime_release_hold_acquired=false
capacity_recovery_started=false
cleanup() { rm -rf -- "$temporary"; }

recover_capacity_controller() {
	local journal_name=${cell_name}-cap-recovery-${runtime_release_hold_id#release-}
	[[ -f $capacity_recovery_helper ]] || { echo "capacity recovery helper is missing" >&2; return 1; }
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-runtime-capacity" \
		-o json >"$temporary/capacity-recovery-current.json"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-runtime-hosts" \
		-o json >"$temporary/capacity-recovery-runtime.json"
	kubectl "${kubeconfig_args[@]}" get machineset "$runtime_machine_set" \
		-o json >"$temporary/capacity-recovery-machineset.json"
	kubectl "${kubeconfig_args[@]}" get machines \
		-l "node.tke.cloud.tencent.com/machineset=${runtime_machine_set}" \
		-o json >"$temporary/capacity-recovery-machines.json"
	kubectl "${kubeconfig_args[@]}" get nodes \
		-l "node.tke.cloud.tencent.com/machineset=${runtime_machine_set}" \
		-o json >"$temporary/capacity-recovery-nodes.json"
	python3 "$capacity_recovery_helper" prepare \
		--deployment "$temporary/capacity-recovery-current.json" \
		--original-deployment "$temporary/capacity.json" \
		--statefulset "$temporary/capacity-recovery-runtime.json" \
		--hold-identity "$temporary/runtime-release-hold-identity.json" \
		--machineset "$temporary/capacity-recovery-machineset.json" \
		--machines "$temporary/capacity-recovery-machines.json" \
		--nodes "$temporary/capacity-recovery-nodes.json" \
		--cell "$cell_name" --namespace "$namespace" --image "$reporter_image" \
		--revision "$reporter_source_revision" --manifest "$reporter_source_manifest_sha" \
		--journal-name "$journal_name" --journal "$temporary/capacity-recovery-journal.json" \
		--patch "$temporary/capacity-recovery-patch.json"
	# Persist the exact original template before any ambiguous deployment ACK.
	# The immutable journal and live hold survive a killed release process.
	kubectl "${kubeconfig_args[@]}" create -f "$temporary/capacity-recovery-journal.json" \
		-o json >"$temporary/capacity-recovery-persisted-journal.json"
	capacity_recovery_started=true
	kubectl "${kubeconfig_args[@]}" -n "$namespace" patch deployment "${cell_name}-runtime-capacity" \
		--field-manager="$runtime_capacity_recovery_field_manager" --type=json \
		--patch-file "$temporary/capacity-recovery-patch.json" >/dev/null
	kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
		deployment/"${cell_name}-runtime-capacity" --timeout=5m
	echo "capacity controller recovery staged under release hold: journal=$journal_name"
}

restore_recovered_capacity_controller() {
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-runtime-capacity" \
		-o json >"$temporary/capacity-recovery-rollback-current.json" || return 1
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-runtime-hosts" \
		-o json >"$temporary/capacity-recovery-rollback-runtime.json" || return 1
	python3 "$capacity_recovery_helper" rollback \
		--deployment "$temporary/capacity-recovery-rollback-current.json" \
		--statefulset "$temporary/capacity-recovery-rollback-runtime.json" \
		--journal "$temporary/capacity-recovery-persisted-journal.json" \
		--patch "$temporary/capacity-recovery-rollback-patch.json" || return 1
	kubectl "${kubeconfig_args[@]}" -n "$namespace" patch deployment "${cell_name}-runtime-capacity" \
		--field-manager="$runtime_capacity_recovery_field_manager" --type=json \
		--patch-file "$temporary/capacity-recovery-rollback-patch.json" >/dev/null || return 1
	kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
		deployment/"${cell_name}-runtime-capacity" --timeout=5m
}

acquire_runtime_release_hold() {
	local deadline=$((SECONDS + 900)) status acquired_at wait_reason previous_wait_reason=
	while ((SECONDS < deadline)); do
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
			"${cell_name}-runtime-hosts" -o json >"$temporary/runtime-release-hold-current.json"
		acquired_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
		set +e
		python3 "$runtime_release_hold_builder" \
			--statefulset "$temporary/runtime-release-hold-current.json" \
			--patch "$temporary/runtime-release-hold-acquire.json" \
			--identity "$temporary/runtime-release-hold-identity.json" \
			--hold-id "$runtime_release_hold_id" --acquired-at "$acquired_at" \
			2>"$temporary/runtime-release-hold-wait-reason"
		status=$?
		set -e
		if ((status != 0)); then
			if ((status == 75)); then
				wait_reason=$(<"$temporary/runtime-release-hold-wait-reason")
				if [[ $wait_reason != "$previous_wait_reason" ]]; then
					echo "runtime release hold waiting: $wait_reason" >&2
					previous_wait_reason=$wait_reason
				fi
				sleep 2
				continue
			fi
			cat "$temporary/runtime-release-hold-wait-reason" >&2
			return "$status"
		fi
		if kubectl "${kubeconfig_args[@]}" -n "$namespace" patch statefulset \
			"${cell_name}-runtime-hosts" --type=json \
			--patch-file "$temporary/runtime-release-hold-acquire.json" >/dev/null 2>&1; then
			runtime_release_hold_acquired=true
			echo "runtime release hold acquired: $runtime_release_hold_id"
			return 0
		fi
		sleep 1
	done
	[[ ! -s $temporary/runtime-release-hold-wait-reason ]] || cat "$temporary/runtime-release-hold-wait-reason" >&2
	echo "runtime release hold acquisition exceeded 900 seconds" >&2
	return 1
}

wait_for_runtime_capacity_settle() {
	local deadline=$((SECONDS + 900)) status wait_reason previous_wait_reason=
	while ((SECONDS < deadline)); do
		kubectl "${kubeconfig_args[@]}" get machineset "$runtime_machine_set" \
			-o json >"$temporary/runtime-capacity-settle-machineset.json"
		kubectl "${kubeconfig_args[@]}" get nodes \
			-l "node.tke.cloud.tencent.com/machineset=${runtime_machine_set}" \
			-o json >"$temporary/runtime-capacity-settle-nodes.json"
		set +e
		wait_reason=$(python3 "$runtime_capacity_settle_checker" \
			--machineset "$temporary/runtime-capacity-settle-machineset.json" \
			--nodes "$temporary/runtime-capacity-settle-nodes.json")
		status=$?
		set -e
		if ((status == 0)); then
			echo "runtime capacity is settled under release hold"
			return 0
		fi
		if ((status != 75)); then
			return "$status"
		fi
		if [[ $wait_reason != "$previous_wait_reason" ]]; then
			echo "runtime capacity settle waiting: $wait_reason" >&2
			previous_wait_reason=$wait_reason
		fi
		sleep 2
	done
	echo "runtime capacity did not settle under release hold within 900 seconds" >&2
	return 1
}

release_runtime_release_hold() {
	[[ $runtime_release_hold_acquired == true ]] || return 0
	local deadline=$((SECONDS + 120)) status
	while ((SECONDS < deadline)); do
		kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
			"${cell_name}-runtime-hosts" -o json >"$temporary/runtime-release-hold-current.json" || return 1
		set +e
		python3 - "$temporary/runtime-release-hold-current.json" \
			"$temporary/runtime-release-hold-identity.json" \
			"$temporary/runtime-release-hold-release.json" \
			"$runtime_release_hold_annotation" <<'PY'
import json, sys
source, identity_path, patch_path, annotation = sys.argv[1:]
document = json.load(open(source))
identity = json.load(open(identity_path))
metadata = document["metadata"]
annotations = metadata.get("annotations") or {}
encoded = annotations.get(annotation)
if not encoded:
    raise SystemExit("owned runtime release hold disappeared")
try:
    observed = json.loads(encoded)
except json.JSONDecodeError as error:
    raise SystemExit("owned runtime release hold became malformed") from error
if observed != identity or metadata.get("uid") != identity.get("workload_uid"):
    raise SystemExit("runtime release hold identity changed")
path = "/metadata/annotations/" + annotation.replace("~", "~0").replace("/", "~1")
operations = [
    {"op": "test", "path": "/metadata/uid", "value": identity["workload_uid"]},
    {"op": "test", "path": "/metadata/resourceVersion", "value": metadata["resourceVersion"]},
    {"op": "test", "path": path, "value": encoded},
    {"op": "remove", "path": path},
]
json.dump(operations, open(patch_path, "w"))
PY
		status=$?
		set -e
		if ((status != 0)); then
			return "$status"
		fi
		if kubectl "${kubeconfig_args[@]}" -n "$namespace" patch statefulset \
			"${cell_name}-runtime-hosts" --type=json \
			--patch-file "$temporary/runtime-release-hold-release.json" >/dev/null 2>&1; then
			runtime_release_hold_acquired=false
			echo "runtime release hold released: $runtime_release_hold_id"
			return 0
		fi
		sleep 1
	done
	echo "runtime release hold release exceeded 120 seconds" >&2
	return 1
}

rollback() {
	local status=$?
	((status != 0)) || status=1
	if [[ $capacity_recovery_started == true && $rollout_started == false ]]; then
		if ! restore_recovered_capacity_controller; then
			echo "capacity recovery rollback failed; retaining the release hold and durable journal" >&2
			cleanup
			exit "$status"
		fi
	fi
	if [[ $rollout_started == true ]]; then
		echo "release failed; restoring the exact pre-release ConfigMap and workload revisions" >&2
		# Forward updates converge the reconnect-capable candidate Engine before
		# NATS can roll. Restore NATS first while that client is still serving; if
		# NATS never changed these patches are no-ops. Only then restore Engine and
		# finally the exact Host template and update strategy.
		kubectl "${kubeconfig_args[@]}" -n "$namespace" patch configmap "${cell_name}-nats-config" \
			--field-manager="$runtime_rollback_field_manager" --type=json \
			--patch-file "$temporary/nats-config-patch.json" >/dev/null || true
		kubectl "${kubeconfig_args[@]}" -n "$namespace" patch statefulset "${cell_name}-nats" \
			--field-manager="$runtime_rollback_field_manager" --type=json \
			--patch-file "$temporary/nats-patch.json" >/dev/null || true
		kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
			statefulset/"${cell_name}-nats" --timeout=10m || true
		kubectl "${kubeconfig_args[@]}" -n "$namespace" patch configmap "${cell_name}-runtime-config" \
			--field-manager="$runtime_rollback_field_manager" --type=json \
			--patch-file "$temporary/configmap-patch.json" >/dev/null || true
		kubectl "${kubeconfig_args[@]}" -n "$namespace" patch deployment "${cell_name}-engine" \
			--field-manager="$runtime_rollback_field_manager" --type=json \
			--patch-file "$temporary/engine-patch.json" >/dev/null || true
		# Restore and converge Engine before touching Host identity. This is the
		# rollback mirror of the forward component-order invariant.
		kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
			deployment/"${cell_name}-engine" --timeout=10m || true
		kubectl "${kubeconfig_args[@]}" -n "$namespace" patch statefulset "${cell_name}-runtime-hosts" \
			--field-manager="$runtime_rollback_field_manager" --type=json \
			--patch-file "$temporary/runtime-patch.json" >/dev/null || true
		kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
			statefulset/"${cell_name}-runtime-hosts" --timeout=45m || true
		kubectl "${kubeconfig_args[@]}" -n "$namespace" patch deployment "${cell_name}-runtime-capacity" \
			--field-manager="$runtime_admission_rollback_field_manager" --type=json \
			--patch-file "$temporary/capacity-patch.json" >/dev/null || true
		if [[ -f $temporary/reporter-patch.json ]]; then
			kubectl "${kubeconfig_args[@]}" -n "$namespace" patch deployment "${cell_name}-cell-reporter" \
				--field-manager="$runtime_rollback_field_manager" --type=json \
				--patch-file "$temporary/reporter-patch.json" >/dev/null || true
		fi
		kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status deployment/"${cell_name}-runtime-capacity" --timeout=5m || true
		if [[ -f $temporary/reporter-patch.json ]]; then
			kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status deployment/"${cell_name}-cell-reporter" --timeout=5m || true
		fi
		# The update patches above restore exact values under an isolated rollback
		# manager. Transfer ConfigMaps and workload specs back to the declarative
		# installer so a later safe release is not blocked by rollback ownership.
		local ownership_sources=("$temporary/configmap.json" "$temporary/engine.json" \
			"$temporary/runtime.json" "$temporary/nats-config.json" "$temporary/nats.json")
		if [[ -f $temporary/reporter.json ]]; then
			ownership_sources+=("$temporary/reporter.json")
		fi
		python3 - "${ownership_sources[@]}" "$temporary/rollback-template-ownership.json" <<'PY'
import json, sys

items = []
for source in sys.argv[1:-1]:
    if not source:
        continue
    document = json.load(open(source))
    item = {
        "apiVersion": document["apiVersion"],
        "kind": document["kind"],
        "metadata": {
            "name": document["metadata"]["name"],
            "namespace": document["metadata"]["namespace"],
        },
    }
    if document["kind"] == "ConfigMap":
        item["data"] = document["data"]
    else:
        item["spec"] = document["spec"]
        if document["kind"] == "StatefulSet" and document["metadata"]["name"].endswith("-runtime-hosts"):
            item["spec"].pop("replicas", None)
    items.append(item)
json.dump({"apiVersion": "v1", "kind": "List", "items": items}, open(sys.argv[-1], "w"))
PY
		kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
			--field-manager=rivet-runtime-installer \
			-f "$temporary/rollback-template-ownership.json" >/dev/null || true
		python3 - "$temporary/capacity.json" "$temporary/rollback-admission-ownership.json" <<'PY'
import json, sys
document = json.load(open(sys.argv[1]))
item = {
    "apiVersion": document["apiVersion"],
    "kind": document["kind"],
    "metadata": {"name": document["metadata"]["name"], "namespace": document["metadata"]["namespace"]},
    "spec": document["spec"],
}
json.dump(item, open(sys.argv[2], "w"))
PY
		kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
			--field-manager="$runtime_admission_field_manager" \
			-f "$temporary/rollback-admission-ownership.json" >/dev/null || true
	fi
	if [[ $ledger_write_started == true ]]; then
		if [[ $ledger_existed == true ]]; then
			kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
				--field-manager=rivet-runtime-release-ledger \
				-f "$temporary/release-ledger-before-restore.json" >/dev/null || true
		else
			kubectl "${kubeconfig_args[@]}" -n "$namespace" delete configmap "$release_ledger_name" \
				--ignore-not-found --wait=true >/dev/null || true
		fi
	fi
	if ! release_runtime_release_hold; then
		echo "runtime release hold remains latched after rollback; Host scale-in stays fail-closed" >&2
	fi
	cleanup
	exit "$status"
}
trap rollback ERR INT TERM
trap cleanup EXIT

health_gate() {
	local backup_url backup_pod backup_description
	[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get foundationdbcluster "$cell_name" -o jsonpath='{.status.health.available}') == true ]]
	[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get foundationdbcluster "$cell_name" -o jsonpath='{.status.health.fullReplication}') == true ]]
	[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get foundationdbcluster "$cell_name" -o jsonpath='{.status.generations.reconciled}') == \
		$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get foundationdbcluster "$cell_name" -o jsonpath='{.metadata.generation}') ]]
	backup_url=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get foundationdbbackup "${cell_name}-continuous" -o jsonpath='{.status.backupDetails.url}')
	[[ $backup_url == blobstore://* ]]
	backup_pod=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pods \
		-l "foundationdb.org/deployment-name=${cell_name}-continuous-backup-agents" \
		-o jsonpath='{.items[0].metadata.name}')
	[[ -n $backup_pod ]]
	backup_description=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" exec "$backup_pod" \
		-c foundationdb -- timeout 45 fdbbackup describe -d "$backup_url")
	grep -q '^Restorable: true$' <<<"$backup_description"
}

health_gate
host_drain_protocol=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment \
	"${cell_name}-host-drain" \
	-o jsonpath='{.spec.template.metadata.annotations.fleet\.actor\.dev/runtime-release-hold-protocol}')
[[ $host_drain_protocol == "$runtime_release_hold_protocol" ]] || {
	echo "Host drain controller does not support the required runtime release hold protocol" >&2
	exit 1
}
acquire_runtime_release_hold
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap "$release_ledger_name" \
	-o json >"$temporary/release-ledger-before.json" 2>/dev/null; then
	ledger_existed=true
	python3 - "$temporary/release-ledger-before.json" "$temporary/release-ledger-before-restore.json" <<'PY'
import json, sys

source = json.load(open(sys.argv[1]))
metadata = source.get("metadata", {})
annotations = {
    key: value for key, value in (metadata.get("annotations", {}) or {}).items()
    if key.startswith("fleet.actor.dev/")
}
document = {
    "apiVersion": "v1",
    "kind": "ConfigMap",
    "metadata": {
        "name": metadata["name"],
        "namespace": metadata["namespace"],
        "labels": metadata.get("labels", {}),
        "annotations": annotations,
    },
    "data": source.get("data", {}),
    "binaryData": source.get("binaryData", {}),
}
json.dump(document, open(sys.argv[2], "w"))
PY
fi
kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap "${cell_name}-runtime-config" \
	-o json >"$temporary/configmap.json"
kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-engine" \
	-o json >"$temporary/engine.json"
kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-runtime-hosts" \
	-o json >"$temporary/runtime.json"
kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap "${cell_name}-nats-config" \
	-o json >"$temporary/nats-config.json"
kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-nats" \
	-o json >"$temporary/nats.json"
kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-runtime-capacity" \
	-o json >"$temporary/capacity.json"
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-cell-reporter" \
	-o json >"$temporary/reporter.json" 2>/dev/null; then
	:
fi
python3 - "$temporary" <<'PY'
import json, sys
from pathlib import Path
root = Path(sys.argv[1])
for source, target, path, field in (
    ("configmap.json", "configmap-patch.json", "/data", "data"),
    ("engine.json", "engine-patch.json", "/spec/template", "spec.template"),
    ("runtime.json", "runtime-patch.json", "/spec/template", "spec.template"),
    ("nats-config.json", "nats-config-patch.json", "/data", "data"),
    ("nats.json", "nats-patch.json", "/spec/template", "spec.template"),
    ("capacity.json", "capacity-patch.json", "/spec/template", "spec.template"),
):
    document = json.loads((root / source).read_text())
    value = document["data"] if field == "data" else document["spec"]["template"]
    operations = [{"op": "replace", "path": path, "value": value}]
    if source == "runtime.json":
        # A failed forward rollout may have installed the OnDelete safety
        # fence. Restore the old template and old strategy in one API mutation
        # so the StatefulSet controller can never observe RollingUpdate with
        # the failed candidate template and delete an undrained old Host.
        operations.insert(0, {
            "op": "replace",
            "path": "/spec/updateStrategy",
            "value": document["spec"]["updateStrategy"],
        })
    (root / target).write_text(json.dumps(operations))
reporter = root / "reporter.json"
if reporter.exists():
    document = json.loads(reporter.read_text())
    (root / "reporter-patch.json").write_text(json.dumps([
        {"op": "replace", "path": "/spec/template", "value": document["spec"]["template"]}
    ]))
PY

write_debt_target=${RIVET_FDB_WRITE_DEBT_TARGET_BYTES:-10485760}
write_debt_limit=${RIVET_FDB_WRITE_DEBT_LIMIT_BYTES:-12582912}
cold_max_concurrent_requests=${RIVET_COLD_MAX_CONCURRENT_REQUESTS:-16}
gasoline_worker_poll_interval_ms=${RIVET_GASOLINE_WORKER_POLL_INTERVAL_MS:-2000}
gasoline_worker_pull_batch_size=${RIVET_GASOLINE_WORKER_PULL_BATCH_SIZE:-256}
gasoline_worker_max_active_workflows=${RIVET_GASOLINE_WORKER_MAX_ACTIVE_WORKFLOWS:-4096}
depot_manager_refresh_max_concurrency=${RIVET_DEPOT_MANAGER_REFRESH_MAX_CONCURRENCY:-8}
depot_compaction_max_concurrency=${RIVET_DEPOT_COMPACTION_MAX_CONCURRENCY:-2}
gasoline_worker_secondary_grace_ms=${RIVET_GASOLINE_WORKER_SECONDARY_GRACE_MS:-1000}
gasoline_history_prune_eligibility_seconds=${RIVET_GASOLINE_HISTORY_PRUNE_ELIGIBILITY_SECONDS:-900}
gasoline_terminal_prune_eligibility_seconds=${RIVET_GASOLINE_TERMINAL_PRUNE_ELIGIBILITY_SECONDS:-604800}
gasoline_prune_interval_seconds=${RIVET_GASOLINE_PRUNE_INTERVAL_SECONDS:-60}
if [[ $gasoline_storage_profile_enforce == 1 ]]; then
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get rivetcell "$cell_name" -o json >"$temporary/storage-cell.json"
	storage_class=$(jq -er '.spec.className' "$temporary/storage-cell.json")
	kubectl "${kubeconfig_args[@]}" get shardclass "$storage_class" -o json >"$temporary/storage-class.json"
	storage_profile=$(jq -er '.spec.profileRef.name' "$temporary/storage-class.json")
	kubectl "${kubeconfig_args[@]}" get rivetcellprofile "$storage_profile" -o json >"$temporary/storage-profile.json"
	python3 "$script_dir/resolve-gasoline-storage-profile.py" \
		"$temporary/storage-cell.json" "$temporary/storage-class.json" "$temporary/storage-profile.json" \
		--expected-cell "$cell_name" >"$temporary/gasoline-storage-policy.json"
	profile_history=$(jq -er '.history_grace_seconds' "$temporary/gasoline-storage-policy.json")
	profile_terminal=$(jq -er '.terminal_grace_seconds' "$temporary/gasoline-storage-policy.json")
	profile_interval=$(jq -er '.prune_interval_seconds' "$temporary/gasoline-storage-policy.json")
	profile_cold_region=$(jq -er '.cold_region' "$temporary/gasoline-storage-policy.json")
	profile_cold_endpoint=$(jq -er '.cold_endpoint' "$temporary/gasoline-storage-policy.json")
	for binding in \
		"RIVET_GASOLINE_HISTORY_PRUNE_ELIGIBILITY_SECONDS:$profile_history" \
		"RIVET_GASOLINE_TERMINAL_PRUNE_ELIGIBILITY_SECONDS:$profile_terminal" \
		"RIVET_GASOLINE_PRUNE_INTERVAL_SECONDS:$profile_interval"; do
		name=${binding%%:*}
		desired=${binding#*:}
		if [[ ${!name+x} && ${!name} != "$desired" ]]; then
			echo "$name conflicts with the bound StorageProfile" >&2
			exit 2
		fi
	done
	if [[ ${RIVET_COLD_REGION+x} && $RIVET_COLD_REGION != "$profile_cold_region" ]]; then
		echo "RIVET_COLD_REGION conflicts with the bound StorageProfile" >&2
		exit 2
	fi
	if [[ ${RIVET_COLD_ENDPOINT+x} && $RIVET_COLD_ENDPOINT != "$profile_cold_endpoint" ]]; then
		echo "RIVET_COLD_ENDPOINT conflicts with the bound StorageProfile" >&2
		exit 2
	fi
	cold_region=$profile_cold_region
	cold_endpoint=$profile_cold_endpoint
	gasoline_history_prune_eligibility_seconds=$profile_history
	gasoline_terminal_prune_eligibility_seconds=$profile_terminal
	gasoline_prune_interval_seconds=$profile_interval
fi
envoy_slot_jitter=${RIVET_ENVOY_SLOT_JITTER:-16}
envoy_allocation_max_in_flight_per_pool=${RIVET_ENVOY_ALLOCATION_MAX_IN_FLIGHT_PER_POOL:-1}
python3 "$script_dir/render-runtime-config.py" "$script_dir/runtime.yaml" "$temporary/config.jsonc" \
	--cell-name "$cell_name" \
	--cold-bucket "$cold_bucket" \
	--cold-endpoint "$cold_endpoint" --cold-region "$cold_region" \
	--write-debt-target "$write_debt_target" --write-debt-limit "$write_debt_limit" \
	--cold-max-concurrent-requests "$cold_max_concurrent_requests" \
	--gasoline-worker-poll-interval-ms "$gasoline_worker_poll_interval_ms" \
	--gasoline-worker-pull-batch-size "$gasoline_worker_pull_batch_size" \
	--gasoline-worker-max-active-workflows "$gasoline_worker_max_active_workflows" \
	--depot-manager-refresh-max-concurrency "$depot_manager_refresh_max_concurrency" \
	--depot-compaction-max-concurrency "$depot_compaction_max_concurrency" \
	--gasoline-worker-secondary-grace-ms "$gasoline_worker_secondary_grace_ms" \
	--gasoline-history-prune-eligibility-seconds "$gasoline_history_prune_eligibility_seconds" \
	--gasoline-terminal-prune-eligibility-seconds "$gasoline_terminal_prune_eligibility_seconds" \
	--gasoline-prune-interval-seconds "$gasoline_prune_interval_seconds" \
	--envoy-slot-jitter "$envoy_slot_jitter" \
	--envoy-allocation-max-in-flight-per-pool "$envoy_allocation_max_in_flight_per_pool"
# A rollback-capable image release cannot authorize an earlier irreversible
# history/terminal deletion boundary. That is a separately fenced
# StorageProfile policy transition.
python3 "$script_dir/validate-gasoline-retention-transition.py" \
	"$temporary/configmap.json" "$temporary/config.jsonc"
RIVET_RUNTIME_CONFIG_FILE="$temporary/config.jsonc" \
	RIVET_SOURCE_REVISION="$source_revision" \
	RIVET_SOURCE_MANIFEST_SHA256="$source_manifest_sha" \
	"$script_dir/validate-runtime-image.sh"

# The runtime image validator does not exercise the separately released
# controller/reporter image. Pull and execute every required entrypoint on each control
# node before changing a live Deployment; a registry-side manifest rewrite or
# stale/nonexistent digest must fail before rollout_started becomes true.
ACTOR_IMAGE_PREFLIGHT_NAMESPACE="$namespace" \
	ACTOR_IMAGE_PREFLIGHT_NAME=runtime-capacity-release \
	ACTOR_IMAGE_PREFLIGHT_IMAGE="$reporter_image" \
	ACTOR_IMAGE_PREFLIGHT_PULL_SECRET=actor-fleet-tcr \
	ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR=fleet.actor.dev/control-pool=true \
	ACTOR_IMAGE_PREFLIGHT_EXPECTED_EXIT_CODE=0 \
	"$operations_dir/preflight-image-pull.sh" /usr/local/bin/workerd-runtime-capacity-controller --help
ACTOR_IMAGE_PREFLIGHT_NAMESPACE="$namespace" \
	ACTOR_IMAGE_PREFLIGHT_NAME=host-drain-release \
	ACTOR_IMAGE_PREFLIGHT_IMAGE="$reporter_image" \
	ACTOR_IMAGE_PREFLIGHT_PULL_SECRET=actor-fleet-tcr \
	ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR=fleet.actor.dev/control-pool=true \
	ACTOR_IMAGE_PREFLIGHT_EXPECTED_EXIT_CODE=0 \
	ACTOR_IMAGE_PREFLIGHT_REQUIRED_OUTPUT='Usage: workerd-host-drain-controller [--help]' \
	"$operations_dir/preflight-image-pull.sh" /usr/local/bin/workerd-host-drain-controller --help
ACTOR_IMAGE_PREFLIGHT_NAMESPACE="$namespace" \
	ACTOR_IMAGE_PREFLIGHT_NAME=cell-reporter-release \
	ACTOR_IMAGE_PREFLIGHT_IMAGE="$reporter_image" \
	ACTOR_IMAGE_PREFLIGHT_PULL_SECRET=actor-fleet-tcr \
	ACTOR_IMAGE_PREFLIGHT_NODE_SELECTOR=fleet.actor.dev/control-pool=true \
	ACTOR_IMAGE_PREFLIGHT_EXPECTED_EXIT_CODE=1 \
	"$operations_dir/preflight-image-pull.sh" /usr/local/bin/rivet-cell-reporter --help

if [[ $capacity_controller_recovery == 1 ]]; then
	recover_capacity_controller
fi
wait_for_runtime_capacity_settle

rollout_started=true
# Qualification is runtime lifecycle state owned by publish-qualified-release,
# not by the static runtime installer. Close placement by removing its entire
# environment overlay with the same kubectl-set field manager before applying
# a new reporter template. The reporter defaults are fail-closed, and rollback
# restores the exact previous template if any later release step fails.
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-cell-reporter" >/dev/null 2>&1; then
	kubectl "${kubeconfig_args[@]}" -n "$namespace" set env deployment/"${cell_name}-cell-reporter" \
		CAPACITY_RISK- QUALIFICATION_READY- QUALIFICATION_RECEIPT- \
		QUALIFICATION_DIGEST- QUALIFICATION_RELEASE_DIGEST- >/dev/null
	kubectl "${kubeconfig_args[@]}" -n "$namespace" rollout status \
		deployment/"${cell_name}-cell-reporter" --timeout=5m
fi
RIVET_REPORTER_IMAGE="$reporter_image" \
	RIVET_REPORTER_SOURCE_REVISION="$reporter_source_revision" \
	RIVET_REPORTER_SOURCE_MANIFEST_SHA256="$reporter_source_manifest_sha" \
RIVET_NATS_IMAGE="$nats_image" \
RIVET_WORKERD_METRICS_IMAGE="$workerd_metrics_image" \
RIVET_WORKER_REGISTRY_URL="$worker_registry_url" \
RIVET_COLD_BUCKET="$cold_bucket" \
RIVET_COLD_ENDPOINT="$cold_endpoint" \
RIVET_COLD_REGION="$cold_region" \
RIVET_AVAILABILITY_MODE="$availability_mode" \
RUNTIME_STATIC_RELEASE_TRANSACTION=1 \
	"$script_dir/install.sh"

[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-engine" -o jsonpath='{.status.readyReplicas}') == 6 ]]
# Runtime replicas are live capacity owned by HPA/Host drain.  A release may
# begin while the Cell is scaled above its configured Host floor; require every
# currently desired replica to be updated and Ready without asserting or
# resetting the count.
read -r runtime_spec_replicas runtime_ready_replicas runtime_updated_replicas \
	runtime_current_revision runtime_update_revision < <(
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset \
		"${cell_name}-runtime-hosts" \
		-o jsonpath='{.spec.replicas}{" "}{.status.readyReplicas}{" "}{.status.updatedReplicas}{" "}{.status.currentRevision}{" "}{.status.updateRevision}{"\n"}'
)
[[ $runtime_spec_replicas =~ ^[0-9]+$ ]]
((runtime_spec_replicas >= 3))
[[ $runtime_ready_replicas == "$runtime_spec_replicas" ]]
[[ $runtime_updated_replicas == "$runtime_spec_replicas" ]]
[[ -n $runtime_current_revision && $runtime_current_revision == "$runtime_update_revision" ]]
[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-engine" -o jsonpath='{.spec.template.spec.containers[0].image}') == "$runtime_image" ]]
[[ $(kubectl "${kubeconfig_args[@]}" -n "$namespace" get statefulset "${cell_name}-runtime-hosts" -o jsonpath='{.spec.template.spec.containers[0].image}') == "$runtime_image" ]]
for component in engine workerd-host; do
	nodes=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get pod -l "fleet.actor.dev/component=$component" -o jsonpath='{range .items[*]}{.spec.nodeName}{"\n"}{end}' | sed '/^$/d' | sort -u)
	[[ $(wc -l <<<"$nodes") -ge 3 ]]
	zones=$(while read -r node; do
		kubectl "${kubeconfig_args[@]}" get node "$node" -o jsonpath='{.metadata.labels.topology\.kubernetes\.io/zone}{"\n"}'
	done <<<"$nodes" | sort -u | wc -l)
	[[ $zones -ge $required_topology_zones ]]
done
health_gate
release_runtime_release_hold

# The interval itself is durable workflow history. A process restart therefore
# cannot shorten an already-recorded sleep. The indexed kick runs only after the
# rollout and public health gate; retention decreases were rejected above, so a
# later automatic rollback cannot need data this cycle made newly eligible.
"$operations_dir/kick-gasoline-pruner.sh" "$cell_name" "$namespace" "${KUBECONFIG:--}"

# Publish the release ledger only after every rollout and health gate passed.
# The ledger fingerprints the workload specs without replicas, so HPA, Host
# drain, MachineSet, Node admission, and FDB reconcilers retain sole ownership
# of their dynamic state.  A failed ConfigMap write is still inside the release
# transaction and restores both the old workloads and the old ledger.
for item in \
	"deployment:${cell_name}-engine:release-live-engine.json" \
	"statefulset:${cell_name}-runtime-hosts:release-live-runtime.json" \
	"deployment:${cell_name}-runtime-capacity:release-live-capacity.json" \
	"statefulset:${cell_name}-nats:release-live-nats.json"; do
	IFS=: read -r kind name output <<<"$item"
	kubectl "${kubeconfig_args[@]}" -n "$namespace" get "$kind" "$name" -o json >"$temporary/$output"
done
kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap "${cell_name}-runtime-config" \
	-o json >"$temporary/release-live-runtime-config.json"
kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap "${cell_name}-nats-config" \
	-o json >"$temporary/release-live-nats-config.json"
ledger_args=(
	--cell "$cell_name"
	--namespace "$namespace"
	--released-at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
	--source-revision "$source_revision"
	--source-manifest-sha256 "$source_manifest_sha"
	--reporter-source-revision "$reporter_source_revision"
	--reporter-source-manifest-sha256 "$reporter_source_manifest_sha"
	--runtime-image "$runtime_image"
	--reporter-image "$reporter_image"
	--nats-image "$nats_image"
	--workerd-metrics-image "$workerd_metrics_image"
	--engine "$temporary/release-live-engine.json"
	--runtime-hosts "$temporary/release-live-runtime.json"
	--runtime-capacity "$temporary/release-live-capacity.json"
	--nats "$temporary/release-live-nats.json"
	--runtime-config "$temporary/release-live-runtime-config.json"
	--nats-config "$temporary/release-live-nats-config.json"
	--output "$temporary/release-ledger.json"
)
if kubectl "${kubeconfig_args[@]}" -n "$namespace" get deployment "${cell_name}-cell-reporter" \
	-o json >"$temporary/release-live-reporter.json" 2>/dev/null; then
	ledger_args+=(--reporter "$temporary/release-live-reporter.json")
fi
python3 "$release_ledger_helper" "${ledger_args[@]}"
ledger_sha256=$(sha256sum "$temporary/release-ledger.json" | awk '{print $1}')
python3 - "$temporary/release-ledger.json" "$temporary/release-ledger-configmap.json" \
	"$release_ledger_name" "$namespace" "$ledger_sha256" <<'PY'
import json, sys

ledger_path, output_path, name, namespace, payload_sha256 = sys.argv[1:]
payload = open(ledger_path).read()
json.dump({
    "apiVersion": "v1",
    "kind": "ConfigMap",
    "metadata": {
        "name": name,
        "namespace": namespace,
        "labels": {
            "fleet.actor.dev/static-release-ledger": "true",
            "fleet.actor.dev/cell-name": json.loads(payload)["cell"],
        },
        "annotations": {
            "fleet.actor.dev/release-receipt-sha256": "sha256:" + payload_sha256,
        },
    },
    "data": {"ledger.json": payload},
}, open(output_path, "w"))
PY
ledger_write_started=true
kubectl "${kubeconfig_args[@]}" apply --server-side --force-conflicts \
	--field-manager=rivet-runtime-release-ledger \
	-f "$temporary/release-ledger-configmap.json" >/dev/null
live_ledger_sha256=$(kubectl "${kubeconfig_args[@]}" -n "$namespace" get configmap "$release_ledger_name" \
	-o jsonpath='{.metadata.annotations.fleet\.actor\.dev/release-receipt-sha256}')
[[ $live_ledger_sha256 == "sha256:$ledger_sha256" ]]

install -d -m 0750 "$release_receipt_dir"
release_id=$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["releaseId"])' "$temporary/release-ledger.json")
release_receipt="$release_receipt_dir/${cell_name}-runtime-release-${release_id#sha256:}.json"
release_receipt_temporary=$(mktemp "$release_receipt_dir/.release-ledger.XXXXXX")
install -m 0640 "$temporary/release-ledger.json" "$release_receipt_temporary"
mv -Tf "$release_receipt_temporary" "$release_receipt"
rollout_started=false
capacity_recovery_started=false
echo "production runtime release converged: $runtime_image"
echo "static release ledger: $release_id receipt=$release_receipt sha256=$ledger_sha256"
