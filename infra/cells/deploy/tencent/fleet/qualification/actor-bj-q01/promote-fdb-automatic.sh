#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
fleet_dir=$(CDPATH= cd -- "$script_dir/../.." && pwd)
operations_dir=$fleet_dir/operations
receipt_root=${RUNTIME_RECEIPTS_DIR:-/data/actor-qualification/receipts}
cell=${CELL:-actor-bj-q01}
namespace=${CELL_NAMESPACE:-actor-fdb-cell-system}
profile=${ACTOR_FDB_PROFILE:-rivet-fdb-operator-cbs-beijing-q01-v1}
shard_class=${ACTOR_SHARD_CLASS:-rivet-fdb-cos-kubernetes-q01-v1}
kubeconfig=${KUBECONFIG:-/var/lib/actor-build/credentials/actor-bj-q01.kubeconfig}

[[ $# -eq 1 ]] || {
	echo "Usage: promote-fdb-automatic.sh AUTOSCALING_RECEIPT.json" >&2
	exit 2
}
if [[ ${AUTONOMY_OPERATION_LOCK_HELD:-0} != 1 ]]; then
	exec "$operations_dir/with-autonomy-operation-lock.sh" -- "$0" "$@"
fi

receipt=$(readlink -e "$1")
root=$(readlink -e "$receipt_root")
[[ -f $receipt && $receipt == "$root"/* && $(basename -- "$receipt") == "${cell}-fdb-autoscaling-"*.json ]] || {
	echo "qualification receipt must be a bounded $cell autoscaling receipt" >&2
	exit 2
}
for command in jq kubectl python3 sha256sum; do
	command -v "$command" >/dev/null || { echo "missing command: $command" >&2; exit 2; }
done
[[ -f $kubeconfig ]] || { echo "private builder kubeconfig is missing" >&2; exit 2; }

# A failed newer attempt is authoritative.  Never promote by selecting an
# older green receipt from the same Cell.
latest=$(python3 - "$root" "$cell" <<'PY'
import glob, os, sys
root, cell = sys.argv[1:]
paths = glob.glob(os.path.join(root, cell + "-fdb-autoscaling-*.json"))
print(max(paths, key=os.path.getmtime) if paths else "")
PY
)
[[ $latest == "$receipt" ]] || {
	echo "qualification receipt is not the latest terminal autoscaling attempt" >&2
	exit 1
}
receipt_age_seconds=$(python3 - "$receipt" <<'PY'
import os, sys, time
print(max(0, int(time.time() - os.stat(sys.argv[1]).st_mtime)))
PY
)
((receipt_age_seconds <= 86400)) || {
	echo "qualification receipt is older than the 24-hour promotion window" >&2
	exit 1
}
python3 "$fleet_dir/autoscaling/verify_receipt.py" "$receipt" >/dev/null

source_root=$(CDPATH= cd -- "$fleet_dir/../../../../.." && pwd)
source_identity_dir=$source_root/.actor-source
[[ -s $source_identity_dir/SOURCE_REVISION && -s $source_identity_dir/RELEASE_SHA256SUMS ]] || {
	echo "promotion must execute from an immutable reviewed source tree" >&2
	exit 2
}
source_revision=$(tr -d '[:space:]' <"$source_identity_dir/SOURCE_REVISION")
source_manifest=$(sha256sum "$source_identity_dir/RELEASE_SHA256SUMS" | cut -d' ' -f1)
[[ $source_revision =~ ^[0-9a-f]{40}$ && $source_manifest =~ ^[0-9a-f]{64}$ ]] || {
	echo "reviewed source identity is invalid" >&2
	exit 2
}

AUTONOMY_WORKFLOW=fdb.autoscaling.promote \
AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 \
AUTONOMY_CONTROL_CELL="$cell" \
AUTONOMY_CONTROL_NAMESPACE="$namespace" \
	"$operations_dir/assert-autonomy-control.sh"

temporary=$(mktemp -d /data/tmp/q01-fdb-promotion.XXXXXX)
rollback_required=false
cleanup() { rm -rf -- "$temporary"; }
rollback() {
	local status=$1
	if [[ $status -ne 0 && $rollback_required == true ]]; then
		echo "FDB Automatic promotion failed; restoring the exact ObserveOnly profile" >&2
		kubectl --kubeconfig "$kubeconfig" patch rivetcellprofile "$profile" --type merge \
			-p "$(<"$temporary/profile-rollback.json")" >/dev/null 2>&1 || true
		kubectl --kubeconfig "$kubeconfig" patch shardclass "$shard_class" --type merge \
			-p "$(<"$temporary/class-rollback.json")" >/dev/null 2>&1 || true
	fi
	cleanup
	exit "$status"
}
trap 'rollback $?' EXIT
trap 'rollback 130' INT
trap 'rollback 143' TERM

kubectl --kubeconfig "$kubeconfig" get rivetcellprofile "$profile" -o json >"$temporary/profile.json"
kubectl --kubeconfig "$kubeconfig" get shardclass "$shard_class" -o json >"$temporary/class.json"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get rivetcell "$cell" -o json >"$temporary/cell.json"
kubectl --kubeconfig "$kubeconfig" -n "$namespace" get foundationdbcluster "$cell" -o json >"$temporary/fdb.json"
kubectl --kubeconfig "$kubeconfig" get machineset np-fdbpool0 -o json >"$temporary/machine.json"

python3 - "$script_dir/fleet-cell.yaml" "$receipt" "$temporary/profile.json" \
	"$temporary/class.json" "$temporary/cell.json" "$temporary/fdb.json" \
	"$temporary/machine.json" "$temporary" <<'PY'
import hashlib, json, sys
from pathlib import Path
import yaml

(manifest_path, receipt_path, profile_path, class_path, cell_path, fdb_path,
 machine_path, output_dir) = sys.argv[1:]
docs = [doc for doc in yaml.safe_load_all(Path(manifest_path).read_text()) if doc]
desired_profile = next(doc for doc in docs if doc.get("kind") == "RivetCellProfile")
desired_class = next(doc for doc in docs if doc.get("kind") == "ShardClass")
receipt = json.loads(Path(receipt_path).read_text())
profile = json.loads(Path(profile_path).read_text())
shard_class = json.loads(Path(class_path).read_text())
cell = json.loads(Path(cell_path).read_text())
fdb = json.loads(Path(fdb_path).read_text())
machine = json.loads(Path(machine_path).read_text())

assert desired_profile["metadata"]["name"] == profile["metadata"]["name"]
assert desired_class["metadata"]["name"] == shard_class["metadata"]["name"]
assert desired_profile["spec"]["foundationDB"]["autoscaling"]["mode"] == "Automatic"
old_spec = json.loads(json.dumps(desired_profile["spec"]))
old_spec["foundationDB"]["autoscaling"]["mode"] = "ObserveOnly"
assert profile["spec"] == old_spec
canonical = json.dumps(old_spec, sort_keys=True, separators=(",", ":")).encode()
old_digest = "sha256:" + hashlib.sha256(canonical).hexdigest()
assert shard_class["spec"]["profileRef"] == {
    "name": profile["metadata"]["name"], "digest": old_digest,
}
assert desired_class["spec"]["profileRef"]["name"] == profile["metadata"]["name"]
new_canonical = json.dumps(desired_profile["spec"], sort_keys=True, separators=(",", ":")).encode()
new_digest = "sha256:" + hashlib.sha256(new_canonical).hexdigest()
assert desired_class["spec"]["profileRef"]["digest"] == new_digest

assert receipt["cell"] == cell["metadata"]["name"]
assert receipt["rivetCell"]["metadata"]["uid"] == cell["metadata"]["uid"]
assert receipt["foundationDB"]["metadata"]["uid"] == fdb["metadata"]["uid"]
assert receipt["machineSet"]["metadata"]["uid"] == machine["metadata"]["uid"]
autoscale = cell.get("status", {}).get("foundationDBAutoscaling", {})
health = fdb.get("status", {}).get("health", {})
assert autoscale.get("mode") == "ObserveOnly"
assert autoscale.get("desiredProcessCount") == autoscale.get("observedProcessCount") == 9
assert fdb.get("spec", {}).get("processCounts", {}).get("storage") == 9
assert health.get("available") and health.get("healthy") and health.get("fullReplication")
assert fdb.get("status", {}).get("generations", {}).get("reconciled") == fdb["metadata"]["generation"]
status = machine.get("status", {})
assert machine.get("spec", {}).get("replicas") == 9
assert status.get("readyReplicas") == status.get("availableReplicas") == 9

Path(output_dir, "profile-rollback.json").write_text(json.dumps({"spec": {"foundationDB": {"autoscaling": old_spec["foundationDB"]["autoscaling"]}}}, separators=(",", ":")))
Path(output_dir, "class-rollback.json").write_text(json.dumps({"spec": {"profileRef": shard_class["spec"]["profileRef"]}}, separators=(",", ":")))
Path(output_dir, "profile-promote.json").write_text(json.dumps({"spec": {"foundationDB": {"autoscaling": desired_profile["spec"]["foundationDB"]["autoscaling"]}}}, separators=(",", ":")))
Path(output_dir, "class-promote.json").write_text(json.dumps({"spec": {"profileRef": desired_class["spec"]["profileRef"]}}, separators=(",", ":")))
Path(output_dir, "identity.json").write_text(json.dumps({"oldProfileDigest": old_digest, "newProfileDigest": new_digest}, separators=(",", ":")))
PY

active_jobs=$(kubectl --kubeconfig "$kubeconfig" get jobs -A -o json | jq '[.items[]|select((.status.active // 0)>0)]|length')
active_operations=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get fdbscaleoperations -o json | jq '[.items[]|select(.status.phase!="Succeeded" and .status.phase!="Failed" and .status.phase!="RolledBack")]|length')
[[ $active_jobs == 0 && $active_operations == 0 ]] || {
	echo "active Jobs or FDB scale operations block Automatic promotion" >&2
	exit 1
}

backup_url=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get foundationdbbackup "${cell}-continuous" -o jsonpath='{.status.backupDetails.url}')
backup_pod=$(kubectl --kubeconfig "$kubeconfig" -n "$namespace" get pods -l "foundationdb.org/deployment-name=${cell}-continuous-backup-agents" -o jsonpath='{.items[0].metadata.name}')
[[ $backup_url == blobstore://* && -n $backup_pod ]]
kubectl --kubeconfig "$kubeconfig" -n "$namespace" exec "$backup_pod" -c foundationdb -- \
	timeout 45 fdbbackup describe -d "$backup_url" | grep -q '^Restorable: true$'

rollback_required=true
# The profile is written first.  Until the class digest advances the controller
# rejects the mismatch, so no partially promoted policy can become active.
kubectl --kubeconfig "$kubeconfig" patch rivetcellprofile "$profile" --type merge \
	-p "$(<"$temporary/profile-promote.json")" >/dev/null
kubectl --kubeconfig "$kubeconfig" patch shardclass "$shard_class" --type merge \
	-p "$(<"$temporary/class-promote.json")" >/dev/null

deadline=$((SECONDS + 600))
while ((SECONDS < deadline)); do
	if kubectl --kubeconfig "$kubeconfig" -n "$namespace" get rivetcell "$cell" -o json | \
		jq -e '.status.foundationDBAutoscaling as $a | $a.mode=="Automatic" and $a.phase=="Stable" and $a.desiredProcessCount==9 and $a.observedProcessCount==9 and $a.recommendedProcessCount==9' >/dev/null; then
		break
	fi
	sleep 10
done
((SECONDS < deadline)) || { echo "Cell did not converge to stable Automatic mode" >&2; exit 1; }

receipt_sha=$(sha256sum "$receipt" | cut -d' ' -f1)
promotion_receipt="$root/${cell}-fdb-automatic-promotion-$(date -u +%Y%m%dT%H%M%SZ).json"
python3 - "$promotion_receipt" "$cell" "$namespace" "$receipt" "$receipt_sha" \
	"$source_revision" "$source_manifest" "$temporary/identity.json" <<'PY'
import json, os, sys, tempfile
from datetime import datetime
path, cell, namespace, qualification, qualification_sha, revision, manifest, identity_path = sys.argv[1:]
identity = json.load(open(identity_path))
payload = {
    "schemaVersion": "actor-fdb-automatic-promotion-v1",
    "verdict": "passed",
    "completedAt": datetime.utcnow().replace(microsecond=0).isoformat() + "Z",
    "cell": cell,
    "namespace": namespace,
    "qualificationReceipt": qualification,
    "qualificationReceiptSHA256": qualification_sha,
    "sourceIdentity": {"revision": revision, "manifest_sha256": manifest},
    "fromMode": "ObserveOnly",
    "toMode": "Automatic",
    **identity,
}
directory = os.path.dirname(path)
fd, temporary = tempfile.mkstemp(prefix=".fdb-promotion-", dir=directory)
with os.fdopen(fd, "w") as output:
    json.dump(payload, output, indent=2, sort_keys=True)
    output.write("\n")
os.replace(temporary, path)
print("fdb_automatic_promotion_receipt=" + path)
PY

rollback_required=false
trap - EXIT INT TERM
cleanup
printf 'fdb_automatic_promotion=passed cell=%s mode=Automatic\n' "$cell"
