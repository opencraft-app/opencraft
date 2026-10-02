#!/usr/bin/env bash
set -euo pipefail
umask 077

# Execute the complete pre-admission qualification for one Argo-converged Cell.
# This workflow deliberately stops before publish-qualified-release.sh: changing
# RivetCell.spec.desiredState remains the explicit operator boundary.
script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_root=$(CDPATH= cd -- "$script_dir/.." && pwd)
operations_dir=$fleet_root/operations
runtime_dir=$fleet_root/runtime

: "${CELL:?CELL must name the exact new Cell}"
CELL_NAMESPACE=${CELL_NAMESPACE:-actor-fdb-cell-system}
: "${KUBECONFIG_PATH:?KUBECONFIG_PATH must name the exact Cell kubeconfig}"
: "${ARGO_CONVERGENCE_RECEIPT:?ARGO_CONVERGENCE_RECEIPT is required}"
: "${INITIAL_RUNTIME_RELEASE_RECEIPT:?INITIAL_RUNTIME_RELEASE_RECEIPT is required}"
: "${AUTONOMY_SOURCE_REVISION:?AUTONOMY_SOURCE_REVISION is required}"
: "${AUTONOMY_SOURCE_MANIFEST_SHA256:?AUTONOMY_SOURCE_MANIFEST_SHA256 is required}"
: "${AUTONOMY_SOURCE_TARGET:?AUTONOMY_SOURCE_TARGET is required}"
: "${ACTOR_IMAGE_INVENTORY:?ACTOR_IMAGE_INVENTORY must bind the qualification Workers API image}"
: "${QUALIFICATION_REGISTRY_URL:?QUALIFICATION_REGISTRY_URL must name the private regional Worker Registry}"
: "${INITIAL_QUALIFICATION_EXECUTE:?set INITIAL_QUALIFICATION_EXECUTE=true after reviewing the convergence receipt}"
[[ $INITIAL_QUALIFICATION_EXECUTE == true ]] || {
	echo "refusing initial qualification: INITIAL_QUALIFICATION_EXECUTE must be true" >&2
	exit 2
}

receipt_dir=${QUALIFICATION_RECEIPT_DIR:-/data/actor-qualification/receipts}
control_dir=${AUTONOMY_CONTROL_OUTPUT_DIR:-/var/lib/actor/autonomy/decisions}
audit_dir=${AUTONOMY_AUDIT_RECEIPT_DIR:-/var/lib/actor/autonomy/receipts}
run_id=${INITIAL_QUALIFICATION_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)-$(tr -d - </proc/sys/kernel/random/uuid | cut -c1-8)}
bottomless_receipt=$receipt_dir/${CELL}-bottomless-production-${run_id}.json
engine_ha_receipt=$receipt_dir/${CELL}-engine-ha-${run_id}.json
workflow_receipt=${INITIAL_QUALIFICATION_RECEIPT:-$receipt_dir/${CELL}-initial-qualification-${run_id}.json}

[[ $CELL =~ ^actor-[a-z0-9]+-[a-z][0-9]{2}$ \
	&& $CELL_NAMESPACE =~ ^[a-z0-9]([-a-z0-9]*[a-z0-9])?$ \
	&& $run_id =~ ^[0-9A-Za-z-]{1,64}$ ]] || {
	echo "initial qualification Cell, namespace, or run ID is invalid" >&2
	exit 2
}
for path in "$KUBECONFIG_PATH" "$ARGO_CONVERGENCE_RECEIPT" "$INITIAL_RUNTIME_RELEASE_RECEIPT" "$ACTOR_IMAGE_INVENTORY"; do
	[[ $path == /* && -f $path && ! -L $path ]] || {
		echo "initial qualification input must be an absolute non-symlink regular file: $path" >&2
		exit 2
	}
done
reviewed_source_name=${AUTONOMY_SOURCE_TARGET##*/}
[[ $AUTONOMY_SOURCE_REVISION =~ ^[0-9a-f]{40}$ \
	&& $AUTONOMY_SOURCE_MANIFEST_SHA256 =~ ^[0-9a-f]{64}$ \
	&& $AUTONOMY_SOURCE_TARGET == /* \
	&& $reviewed_source_name =~ ^[a-z0-9-]+-src-${AUTONOMY_SOURCE_REVISION}-${AUTONOMY_SOURCE_MANIFEST_SHA256}$ \
	&& -d $AUTONOMY_SOURCE_TARGET && ! -L $AUTONOMY_SOURCE_TARGET \
	&& -f $AUTONOMY_SOURCE_TARGET/.actor-source/SOURCE_REVISION \
	&& -f $AUTONOMY_SOURCE_TARGET/.actor-source/RELEASE_SHA256SUMS \
	&& $(tr -d '[:space:]' <"$AUTONOMY_SOURCE_TARGET/.actor-source/SOURCE_REVISION") == "$AUTONOMY_SOURCE_REVISION" \
	&& $(sha256sum "$AUTONOMY_SOURCE_TARGET/.actor-source/RELEASE_SHA256SUMS" | cut -d' ' -f1) == "$AUTONOMY_SOURCE_MANIFEST_SHA256" ]] || {
	echo "initial qualification reviewed-source identity is malformed or not physically materialized" >&2
	exit 2
}
[[ ${INITIAL_RUNTIME_RELEASE_RECEIPT##*/} =~ ^${CELL}-runtime-release-[0-9a-f]{64}\.json$ ]] || {
	echo "initial runtime release receipt name does not bind the exact Cell and release ID" >&2
	exit 2
}
for output in "$bottomless_receipt" "$engine_ha_receipt" "$workflow_receipt"; do
	[[ $output == /* && ! -e $output ]] || {
		echo "initial qualification output must be a new absolute path: $output" >&2
		exit 2
	}
done
for artifact in "$runtime_dir/install-qualification-workers-api.sh" \
	"$runtime_dir/qualify-runtime.sh" "$runtime_dir/qualify-engine-ha.sh" \
	"$operations_dir/run-autonomy-governance.sh"; do
	[[ -x $artifact ]] || { echo "initial qualification artifact is unavailable: $artifact" >&2; exit 2; }
done
for command in jq python3 sha256sum flock; do
	command -v "$command" >/dev/null || { echo "initial qualification command is missing: $command" >&2; exit 2; }
done

python3 - "$ARGO_CONVERGENCE_RECEIPT" "$INITIAL_RUNTIME_RELEASE_RECEIPT" "$ACTOR_IMAGE_INVENTORY" "$CELL" "$CELL_NAMESPACE" <<'PY'
import json, sys
payload=json.load(open(sys.argv[1]))
if payload.get("schema") != "actor-cell-argo-convergence/v1" or payload.get("verdict") != "passed":
    raise SystemExit("Argo convergence receipt is not a terminal pass")
cell=payload.get("cell", {})
if cell.get("id") != sys.argv[4] or not cell.get("uid"):
    raise SystemExit("Argo convergence receipt belongs to another Cell")
if payload.get("argo", {}).get("application", {}).get("sync") != "Synced" or payload.get("argo", {}).get("application", {}).get("health") != "Healthy":
    raise SystemExit("Argo convergence receipt is not Synced and Healthy")
if payload.get("argo", {}).get("project") != "actor-cell-bootstrap" or payload.get("argo", {}).get("registrationScope") != "production":
    raise SystemExit("Argo convergence receipt is not from production Cell registration")
release=json.load(open(sys.argv[2]))
images=json.load(open(sys.argv[3]))
if release.get("schemaVersion") != "actor-fleet-static-release-ledger/v1":
    raise SystemExit("initial runtime release receipt schema is invalid")
if release.get("cell") != sys.argv[4] or release.get("namespace") != sys.argv[5]:
    raise SystemExit("initial runtime release receipt belongs to another Cell")
release_id=release.get("releaseId", "")
if not isinstance(release_id, str) or not release_id.startswith("sha256:") or sys.argv[2].rsplit("-", 1)[-1] != release_id[7:] + ".json":
    raise SystemExit("initial runtime release receipt filename does not bind its release ID")
inventory_digest=images.get("inventoryDigest")
if not isinstance(inventory_digest, str) or payload.get("imageInventoryDigest") != inventory_digest:
    raise SystemExit("Argo convergence and initial runtime release use different image inventories")
inventory_refs={item.get("ref") for item in images.get("images", []) if isinstance(item, dict)}
release_refs=set()
for workload in release.get("workloads", []):
    if not isinstance(workload, dict):
        raise SystemExit("initial runtime release workload inventory is malformed")
    for group in (workload.get("containers", {}), workload.get("initContainers", {})):
        if not isinstance(group, dict):
            raise SystemExit("initial runtime release container inventory is malformed")
        release_refs.update(group.values())
if not release_refs or not release_refs.issubset(inventory_refs):
    raise SystemExit("initial runtime release is outside the Argo-bound image inventory")
PY

mkdir -p /data/tmp "$receipt_dir" "$control_dir" "$audit_dir"
if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
fi

export CELL CELL_NAMESPACE KUBECONFIG_PATH
export AUTONOMY_QUALIFICATION_MODE=initial-cell
export AUTONOMY_CONTROL_OUTPUT_DIR=$control_dir
export AUTONOMY_CONTROL_DECISIONS_DIR=$control_dir
export AUTONOMY_AUDIT_RECEIPT_DIR=$audit_dir
export RUNTIME_RECEIPTS_DIR=$receipt_dir
export RELEASE_RECEIPTS_DIR=$(dirname -- "$INITIAL_RUNTIME_RELEASE_RECEIPT")

# A Cell cannot join the regional placement set until these receipts pass, so
# its public /v1 qualification endpoint uses the exact pre-admission Cell UID
# instead of the regional ShardPool.
KUBECONFIG=$KUBECONFIG_PATH RIVET_CELL_NAME=$CELL RIVET_CELL_NAMESPACE=$CELL_NAMESPACE \
	"$runtime_dir/install-qualification-workers-api.sh"

# Produce a current fail-closed control decision. Missing qualification roots
# are an expected bootstrap state; live health failure remains blocking.
preflight_marker=$(mktemp /data/tmp/${CELL}-initial-preflight.XXXXXX)
trap 'rm -f -- "$preflight_marker"' EXIT INT TERM
set +e
"$operations_dir/run-autonomy-governance.sh" \
	--receipt-dir "$control_dir" --output-dir "$control_dir" \
	--policy "$operations_dir/autonomy-policy.json" >/data/tmp/${CELL}-initial-preflight-${run_id}.log 2>&1
preflight_status=$?
set -e
((preflight_status == 0 || preflight_status == 2)) || {
	echo "initial qualification preflight returned an unexpected decision: $preflight_status" >&2
	exit 1
}
mapfile -t preflight_controls < <(find "$control_dir" -maxdepth 1 -type f \
	-name "autonomy-control-${CELL}-*.json" -newer "$preflight_marker" -print)
(( ${#preflight_controls[@]} == 1 )) || {
	echo "initial qualification preflight did not produce exactly one control receipt" >&2
	exit 1
}
export AUTONOMY_CONTROL_FILE=${preflight_controls[0]}
rm -f -- "$preflight_marker"
trap - EXIT INT TERM

KUBECONFIG=$KUBECONFIG_PATH RIVET_CELL_NAME=$CELL RIVET_CELL_NAMESPACE=$CELL_NAMESPACE \
QUALIFICATION_PROFILE=production-cell QUALIFICATION_RECEIPT=$bottomless_receipt \
AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 AUTONOMY_OPERATION_LOCK_HELD=1 \
	"$runtime_dir/qualify-runtime.sh"

KUBECONFIG=$KUBECONFIG_PATH RIVET_CELL_NAME=$CELL RIVET_CELL_NAMESPACE=$CELL_NAMESPACE \
ENGINE_HA_RECEIPT=$engine_ha_receipt ENGINE_HA_DYNAMIC_RUNTIME_CAPACITY=true \
AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 \
AUTONOMY_OPERATION_LOCK_HELD=1 \
	"$runtime_dir/qualify-engine-ha.sh"

marker=$(mktemp /data/tmp/${CELL}-initial-final.XXXXXX)
trap 'rm -f -- "$marker"' EXIT INT TERM
unset AUTONOMY_CONTROL_FILE
"$operations_dir/run-autonomy-governance.sh" \
	--receipt-dir "$control_dir" --output-dir "$control_dir" \
	--policy "$operations_dir/autonomy-policy.json"
mapfile -t final_audits < <(find "$audit_dir" -maxdepth 1 -type f \
	-name "autonomy-audit-${CELL}-*.json" -newer "$marker" -print)
mapfile -t final_controls < <(find "$control_dir" -maxdepth 1 -type f \
	-name "autonomy-control-${CELL}-*.json" -newer "$marker" -print)
(( ${#final_audits[@]} == 1 && ${#final_controls[@]} == 1 )) || {
	echo "initial qualification did not produce exactly one final audit/control pair" >&2
	exit 1
}
final_audit=${final_audits[0]}
final_control=${final_controls[0]}

python3 - "$ARGO_CONVERGENCE_RECEIPT" "$bottomless_receipt" "$engine_ha_receipt" \
	"$final_audit" "$final_control" "$workflow_receipt" "$CELL" "$CELL_NAMESPACE" <<'PY'
import hashlib, json, os, sys
paths=[os.path.realpath(value) for value in sys.argv[1:6]]
output=sys.argv[6]
expected_cell, expected_namespace=sys.argv[7:]
documents=[]
digests=[]
for path in paths:
    with open(path, "rb") as stream:
        data=stream.read()
    documents.append(json.loads(data))
    digests.append(hashlib.sha256(data).hexdigest())
argo, bottomless, engine, audit, control=documents
if audit.get("schemaVersion") != "actor-fdb-autonomy-audit-v1" or audit.get("verdict") != "passed":
    raise SystemExit("final initial-Cell audit did not pass")
if audit.get("cell") != expected_cell or audit.get("namespace") != expected_namespace:
    raise SystemExit("final audit belongs to another Cell")
if audit.get("evidence", {}).get("qualification_mode") != "initial-cell":
    raise SystemExit("final audit did not use initial-cell mode")
evidence_items=audit.get("evidence", {}).get("receipts", [])
if not isinstance(evidence_items, list):
    raise SystemExit("final audit receipt inventory is malformed")
evidence={}
for item in evidence_items:
    if not isinstance(item, dict) or not isinstance(item.get("name"), str):
        raise SystemExit("final audit receipt inventory is malformed")
    if item["name"] in evidence:
        raise SystemExit("final audit contains duplicate receipt evidence")
    evidence[item["name"]]=item
for name, expected_path in (("bottomless", paths[1]), ("engine_ha", paths[2])):
    item=evidence.get(name, {})
    observed=item.get("path")
    if item.get("passed") is not True or not isinstance(observed, str) or os.path.realpath(observed) != expected_path:
        raise SystemExit("final audit did not select the exact current-run " + name + " receipt")
if control.get("schemaVersion") != "actor-fdb-autonomy-control-v1" or control.get("control") != "allow":
    raise SystemExit("final initial-Cell control is not allow")
if control.get("source_receipt_sha256") != digests[3]:
    raise SystemExit("final control does not bind the exact audit bytes")
if control.get("cell") != expected_cell or control.get("namespace") != expected_namespace:
    raise SystemExit("final control belongs to another Cell")
receipt={
    "schema":"actor-cell-initial-qualification/v2", "verdict":"passed",
    "cell":expected_cell, "namespace":expected_namespace,
    "sourceIdentity":audit.get("sourceIdentity"),
    "argo":{"receipt":paths[0],"sha256":digests[0],"cell_uid":argo["cell"]["uid"]},
    "qualification":{
        "bottomless":{"receipt":paths[1],"sha256":digests[1]},
        "engine_ha":{"receipt":paths[2],"sha256":digests[2]},
        "audit":{"receipt":paths[3],"sha256":digests[3]},
        "control":{"receipt":paths[4],"sha256":digests[4]},
    },
    "operator_activation_required":True,
}
temporary=output+".tmp"
with open(temporary,"x") as stream:
    json.dump(receipt,stream,indent=2,sort_keys=True); stream.write("\n")
os.replace(temporary,output)
PY
trap - EXIT INT TERM
rm -f -- "$marker"
printf 'initial_cell_qualification=passed receipt=%s audit=%s control=%s operator_activation_required=true\n' \
	"$workflow_receipt" "$final_audit" "$final_control"
