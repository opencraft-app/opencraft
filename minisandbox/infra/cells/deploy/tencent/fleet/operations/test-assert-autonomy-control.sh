#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d /data/tmp/assert-autonomy-control.XXXXXX)
qualification_receipts=$temporary/qualification-receipts
mkdir -p "$qualification_receipts"
candidate_authorization=$(mktemp --suffix=.json "$qualification_receipts/actor-bj-q01-semantic-failure-candidate-test-XXXXXX")
rollback_run=$(python3 -c 'import uuid; print(uuid.uuid4().hex)')
rollback_authorization=$qualification_receipts/actor-bj-q01-user-transparent-upgrade-${rollback_run}.json
cleanup() { rm -rf -- "$temporary"; }
trap cleanup EXIT
export AUTONOMY_CONTROL_TEST_MODE=1
export AUTONOMY_CONTROL_QUALIFICATION_RECEIPT_ROOT=$qualification_receipts

timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)
bind_source() {
	local control=$1 source=$2 digest temporary_control
	digest=$(sha256sum "$source" | cut -d' ' -f1)
	temporary_control=${control}.new
	jq --arg source "$source" --arg digest "$digest" \
		'. + {source_receipt:$source,source_receipt_sha256:$digest}' "$control" >"$temporary_control"
	mv -- "$temporary_control" "$control"
}
write_receipt() {
	local path=$1 cell=$2 namespace=$3 control=$4
	local source=$temporary/source-$(basename "$path").json
	printf '{"cell":"%s","namespace":"%s"}\n' "$cell" "$namespace" >"$source"
	printf '{"schemaVersion":"actor-fdb-autonomy-control-v1","timestamp":"%s","cell":"%s","namespace":"%s","control":"%s","failures":[],"warnings":[]}\n' \
		"$timestamp" "$cell" "$namespace" "$control" >"$path"
	bind_source "$path" "$source"
}

write_receipt "$temporary/autonomy-control-20260904T000000Z.json" actor-bj-q01 actor-fdb-cell-system allow
write_receipt "$temporary/autonomy-control-20260904T000001Z.json" actor-bj-k01 actor-fdb-cell-system block

output=$(
	AUTONOMY_CONTROL_DECISIONS_DIR="$temporary" \
	AUTONOMY_CONTROL_CELL=actor-bj-q01 \
	AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
	AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
		"$script_dir/assert-autonomy-control.sh"
)
[[ $output == *"autonomy-control-20260904T000000Z.json"* ]]
[[ $output == *"decision=allow"* ]]

set +e
AUTONOMY_CONTROL_FILE="$temporary/autonomy-control-20260904T000001Z.json" \
AUTONOMY_CONTROL_CELL=actor-bj-q01 \
AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
	"$script_dir/assert-autonomy-control.sh" >"$temporary/mismatch.out" 2>&1
status=$?
set -e
[[ $status -eq 2 ]]
grep -q "decision=mismatch" "$temporary/mismatch.out"

set +e
AUTONOMY_CONTROL_DECISIONS_DIR="$temporary" \
AUTONOMY_CONTROL_CELL=actor-nonexistent \
AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
	"$script_dir/assert-autonomy-control.sh" >"$temporary/missing.out" 2>&1
status=$?
set -e
[[ $status -eq 2 ]]
grep -q "no autonomy-control receipt found" "$temporary/missing.out"

cat >"$temporary/bootstrap-audit.json" <<JSON
{"cell":"actor-bj-q01","namespace":"actor-fdb-cell-system","kubernetes":{"autoscaling":{"mode":"ObserveOnly","desiredObservedAligned":true,"threeWayProcessAlignment":true,"volumeGCMode":"ObserveOnly","retentionAtLeast30Days":true}}}
JSON
cat >"$temporary/bootstrap-control.json" <<JSON
{"schemaVersion":"actor-fdb-autonomy-control-v1","timestamp":"$timestamp","cell":"actor-bj-q01","namespace":"actor-fdb-cell-system","control":"block","failures":["latest_bottomless_receipt_missing","fdb_autoscaling_mode_not_automatic"],"warnings":[],"source_receipt":"$temporary/bootstrap-audit.json"}
JSON
bind_source "$temporary/bootstrap-control.json" "$temporary/bootstrap-audit.json"
for workflow in runtime.release runtime.qualify runtime.agent-arrival runtime.machine-repair runtime.automatic-machine-repair runtime.machine-repair-configure fdb.autoscaling.promote dr.capacity dr.physical-restore; do
	output=$(
		AUTONOMY_CONTROL_FILE="$temporary/bootstrap-control.json" \
		AUTONOMY_CONTROL_CELL=actor-bj-q01 \
		AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
		AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
		AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 \
		AUTONOMY_WORKFLOW="$workflow" \
			"$script_dir/assert-autonomy-control.sh"
	)
	[[ $output == *"decision=evidence-bootstrap-allowed"* ]]
done

# A failed/missing upgrade receipt must be regenerable only through an explicit
# evidence-recovery release; otherwise adding the upgrade gate deadlocks the
# sole workflow that can produce its replacement evidence.
printf '{"cell":"actor-bj-q01","namespace":"actor-fdb-cell-system"}\n' >"$temporary/upgrade-evidence-audit.json"
cat >"$temporary/upgrade-evidence-control.json" <<JSON
{"schemaVersion":"actor-fdb-autonomy-control-v1","timestamp":"$timestamp","cell":"actor-bj-q01","namespace":"actor-fdb-cell-system","control":"block","failures":["latest_user_transparent_upgrade_receipt_failed"],"warnings":[]}
JSON
bind_source "$temporary/upgrade-evidence-control.json" "$temporary/upgrade-evidence-audit.json"
AUTONOMY_WORKFLOW=runtime.release \
	AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 \
	AUTONOMY_CONTROL_FILE="$temporary/upgrade-evidence-control.json" \
	AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
	AUTONOMY_CONTROL_CELL=actor-bj-q01 \
	AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
		"$script_dir/assert-autonomy-control.sh" >/dev/null
set +e
AUTONOMY_WORKFLOW=runtime.release \
	AUTONOMY_CONTROL_FILE="$temporary/upgrade-evidence-control.json" \
	AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
	AUTONOMY_CONTROL_CELL=actor-bj-q01 \
	AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
		"$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

# A block may be crossed only by a receipt that binds the exact intentionally
# broken runtime artifact being qualified. ALLOW_DEGRADE alone remains unable
# to cross a block.
runtime_image=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/rivet-runtime@sha256:$(printf a%.0s {1..64})
failed_candidate_image=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/rivet-runtime@sha256:$(printf b%.0s {1..64})
runtime_revision=$(printf c%.0s {1..40})
runtime_manifest=$(printf d%.0s {1..64})
cat >"$candidate_authorization" <<JSON
{"schema":"actor-bj-q01-semantic-failure-candidate/v1","verdict":"passed","intentionallyNotProduction":true,"candidateRuntimeImage":"$runtime_image","sourceRevision":"$runtime_revision","candidateSourceManifestSHA256":"$runtime_manifest"}
JSON
output=$(
	AUTONOMY_WORKFLOW=runtime.release \
	AUTONOMY_CONTROL_FILE="$temporary/upgrade-evidence-control.json" \
	AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
	AUTONOMY_CONTROL_CELL=actor-bj-q01 \
	AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
	AUTONOMY_CONTROL_QUALIFICATION_CANDIDATE_RECEIPT="$candidate_authorization" \
	RIVET_RUNTIME_IMAGE="$runtime_image" \
	RIVET_SOURCE_REVISION="$runtime_revision" \
	RIVET_SOURCE_MANIFEST_SHA256="$runtime_manifest" \
		"$script_dir/assert-autonomy-control.sh"
)
[[ $output == *"decision=qualification-authorized"* ]]
set +e
AUTONOMY_WORKFLOW=runtime.release \
AUTONOMY_CONTROL_FILE="$temporary/upgrade-evidence-control.json" \
AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
AUTONOMY_CONTROL_CELL=actor-bj-q01 \
AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
AUTONOMY_CONTROL_QUALIFICATION_CANDIDATE_RECEIPT="$candidate_authorization" \
RIVET_RUNTIME_IMAGE="$failed_candidate_image" \
RIVET_SOURCE_REVISION="$runtime_revision" \
RIVET_SOURCE_MANIFEST_SHA256="$runtime_manifest" \
	"$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

# The rollback authority is a different receipt: it proves a completed
# candidate rollout, public /v1 failure, retained 32-Object fixture, and exact
# prior runtime target. A pre-rollout failure cannot satisfy this shape.
python3 - "$rollback_authorization" "$runtime_image" "$failed_candidate_image" <<'PY'
import json,sys
path,stable,candidate=sys.argv[1:]
refs=[{"object":"object","id":"obj-%02d" % i,"worker":"gate","class_name":"Counter"} for i in range(32)]
pod={"image_ids":[stable]}
document={
    "schema":"actor-bj-q01-user-transparent-upgrade/v4",
    "verdict":"failed", "release_exit_code":0, "public_api_only":True,
    "public_probe":{"failures":[{"error":"intentional"}]},
    "cleanup_errors":[], "rollback_objects_retained":True,
    "object_refs":refs, "rollback_object_refs":refs,
    "before":{"engine_pods":[pod],"runtime_pods":[pod]},
    "after":{"engine_pods":[{"image_ids":[candidate]}],
             "runtime_pods":[{"image_ids":[candidate]}]},
    "target_images":{"engine":{"container/engine":candidate},
                     "runtime":{"container/workerd-host":candidate}},
}
json.dump(document,open(path,"w"),sort_keys=True)
PY
output=$(
	AUTONOMY_WORKFLOW=runtime.release \
	AUTONOMY_CONTROL_FILE="$temporary/upgrade-evidence-control.json" \
	AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
	AUTONOMY_CONTROL_CELL=actor-bj-q01 \
	AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
	AUTONOMY_CONTROL_QUALIFICATION_ROLLBACK_RECEIPT="$rollback_authorization" \
	RIVET_RUNTIME_IMAGE="$runtime_image" \
	RIVET_SOURCE_REVISION="$runtime_revision" \
	RIVET_SOURCE_MANIFEST_SHA256="$runtime_manifest" \
		"$script_dir/assert-autonomy-control.sh"
)
[[ $output == *"decision=qualification-authorized"* ]]
python3 - "$temporary/upgrade-evidence-control.json" <<'PY'
import json,sys
p=sys.argv[1]; x=json.load(open(p)); x["warnings"]=["real_health_warning"]
json.dump(x,open(p,"w"))
PY
set +e
AUTONOMY_WORKFLOW=runtime.release \
	AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 \
	AUTONOMY_CONTROL_FILE="$temporary/upgrade-evidence-control.json" \
	AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
	AUTONOMY_CONTROL_CELL=actor-bj-q01 \
	AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
		"$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

python3 - "$temporary/bootstrap-audit.json" <<'PY'
import json, sys
p=sys.argv[1]
x=json.load(open(p)); x["kubernetes"]["autoscaling"]["threeWayProcessAlignment"]=False
json.dump(x,open(p,"w"))
PY
set +e
AUTONOMY_CONTROL_FILE="$temporary/bootstrap-control.json" \
AUTONOMY_CONTROL_CELL=actor-bj-q01 \
AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 \
AUTONOMY_WORKFLOW=runtime.qualify \
	"$script_dir/assert-autonomy-control.sh" >"$temporary/unsafe-bootstrap.out" 2>&1
status=$?
set -e
[[ $status -eq 2 ]]
grep -q "decision=invalid" "$temporary/unsafe-bootstrap.out"

cat >"$temporary/topology-audit.json" <<JSON
{"cell":"actor-bj-q01","namespace":"actor-fdb-cell-system","kubernetes":{"fdb":{"available":true,"healthy":true,"fullReplication":true,"reconcileAligned":true,"backupRunning":true,"backupRestorable":true},"autoscaling":{"mode":"ObserveOnly","desiredObservedAligned":true,"threeWayProcessAlignment":true,"volumeGCMode":"ObserveOnly","retentionAtLeast30Days":true},"topology":{"engineReadyReplicas":6,"engineZones":{"a":2,"b":2,"c":2},"runtimeHostReady":3,"runtimeHostStatefulSetReplicas":3,"runtimeHostZones":{"b":2,"c":1}}},"prometheus":{"alerts":{"firing":[{"alert":"ActorRuntimeZoneSkew","severity":"critical"}]}}}
JSON
cat >"$temporary/topology-control.json" <<JSON
{"schemaVersion":"actor-fdb-autonomy-control-v1","timestamp":"$timestamp","cell":"actor-bj-q01","namespace":"actor-fdb-cell-system","control":"block","failures":["latest_bottomless_receipt_missing","fdb_autoscaling_mode_not_automatic","runtime_not_in_three_zones","prometheus_critical_alerts_exist","prometheus_critical_alerts=1"],"warnings":[],"source_receipt":"$temporary/topology-audit.json"}
JSON
bind_source "$temporary/topology-control.json" "$temporary/topology-audit.json"
output=$(
	AUTONOMY_CONTROL_FILE="$temporary/topology-control.json" \
	AUTONOMY_CONTROL_CELL=actor-bj-q01 \
	AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
	AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
	AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 \
	AUTONOMY_WORKFLOW=runtime.topology-repair \
		"$script_dir/assert-autonomy-control.sh"
)
[[ $output == *"decision=evidence-bootstrap-allowed"* ]]

python3 - "$temporary/topology-audit.json" <<'PY'
import json,sys
p=sys.argv[1]; x=json.load(open(p)); x["prometheus"]["alerts"]["firing"][0]["alert"]="ActorFDBUnavailable"; json.dump(x,open(p,"w"))
PY
set +e
AUTONOMY_CONTROL_FILE="$temporary/topology-control.json" \
AUTONOMY_CONTROL_CELL=actor-bj-q01 \
AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system \
AUTONOMY_CONTROL_REQUIRE_LOCK=0 \
AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1 \
AUTONOMY_WORKFLOW=runtime.topology-repair \
	"$script_dir/assert-autonomy-control.sh" >"$temporary/unsafe-topology.out" 2>&1
status=$?
set -e
[[ $status -eq 2 ]]
grep -q "decision=invalid" "$temporary/unsafe-topology.out"

# Static release recovery is intentionally narrower than evidence recovery. It
# can only replace the single drifting reporter on an otherwise healthy Cell,
# and it binds the exact immutable reporter artifact being deployed.
reporter_image=lightclaw-bj82.tencentcloudcr.com/actor-fleet/actor-fleet-controller@sha256:$(printf e%.0s {1..64})
reporter_revision=$(printf f%.0s {1..40})
reporter_manifest=$(printf 1%.0s {1..64})
cat >"$temporary/static-release-audit.json" <<JSON
{"cell":"actor-bj-q01","namespace":"actor-fdb-cell-system","readiness_summary":{"active_topology_zones":{"engine":3,"fdb":3,"runtime":3},"backup_restorable":true,"engine_ready":true,"fdb_autoscaling_automatic":true,"fdb_autoscaling_stable":true,"fdb_available":true,"fdb_full_replication":true,"runtime_ready":true,"static_release_converged":false},"evidence":{"static_release":{"ready":false,"driftCount":1,"drifts":[{"component":"Deployment/actor-bj-q01-cell-reporter","reason":"static_spec_digest_mismatch"}],"externalReceiptMatches":true,"payloadDigestMatches":true}}}
JSON
cat >"$temporary/static-release-control.json" <<JSON
{"schemaVersion":"actor-fdb-autonomy-control-v1","timestamp":"$timestamp","cell":"actor-bj-q01","namespace":"actor-fdb-cell-system","control":"block","failures":["latest_user_transparent_upgrade_receipt_failed","static_release_ledger_not_converged","static_release_drift_components=1"],"warnings":[]}
JSON
bind_source "$temporary/static-release-control.json" "$temporary/static-release-audit.json"
static_release_environment=(
	AUTONOMY_CONTROL_FILE="$temporary/static-release-control.json"
	AUTONOMY_CONTROL_REQUIRE_LOCK=0
	AUTONOMY_CONTROL_CELL=actor-bj-q01
	AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system
	AUTONOMY_CONTROL_ALLOW_STATIC_RELEASE_RECOVERY=1
	AUTONOMY_WORKFLOW=runtime.release
	RIVET_REPORTER_IMAGE="$reporter_image"
	RIVET_REPORTER_SOURCE_REVISION="$reporter_revision"
	RIVET_REPORTER_SOURCE_MANIFEST_SHA256="$reporter_manifest"
)
output=$(env "${static_release_environment[@]}" "$script_dir/assert-autonomy-control.sh")
[[ $output == *"decision=static-release-recovery-allowed"* ]]

regional_reporter_image=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/actor-fleet-controller@sha256:$(printf d%.0s {1..64})
output=$(env "${static_release_environment[@]}" RIVET_REPORTER_IMAGE="$regional_reporter_image" \
	"$script_dir/assert-autonomy-control.sh")
[[ $output == *"decision=static-release-recovery-allowed"* ]]

set +e
env "${static_release_environment[@]}" \
	RIVET_REPORTER_IMAGE=actor-fleet-beijing.tencentcloudcr.com/actor-fleet/actor-fleet-controller:latest \
	"$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

cat >"$temporary/initial-ledger-audit.json" <<JSON
{"cell":"actor-bj-q01","namespace":"actor-fdb-cell-system","failures":["latest_bottomless_receipt_missing","latest_engine_ha_receipt_missing","latest_agent_arrival_receipt_failed","latest_fdb_autoscaling_receipt_missing","latest_user_transparent_upgrade_receipt_missing","latest_semantic_failure_rollback_receipt_missing","dr_receipt_missing","static_release_ledger_not_converged","static_release_drift_components=1","prometheus_critical_alerts_exist","prometheus_critical_alerts=1"],"warnings":[],"readiness_summary":{"active_topology_zones":{"engine":3,"fdb":3,"runtime":3},"backup_restorable":true,"engine_ready":true,"fdb_autoscaling_automatic":true,"fdb_autoscaling_stable":true,"fdb_available":true,"fdb_full_replication":true,"runtime_ready":true,"static_release_converged":false},"evidence":{"strict_mode":true,"qualification_mode":"initial-cell","static_release":{"ready":false,"driftCount":1,"releaseId":null,"drifts":[{"component":"ledger","reason":"release_ledger_configmap_missing"}]}},"prometheus":{"alerts":{"firing":[{"alert":"ActorStaticReleaseDrift","severity":"critical","labels":{"cell":"actor-bj-q01"}}]}}}
JSON
cat >"$temporary/initial-ledger-control.json" <<JSON
{"schemaVersion":"actor-fdb-autonomy-control-v1","timestamp":"$timestamp","cell":"actor-bj-q01","namespace":"actor-fdb-cell-system","control":"block","failures":["latest_bottomless_receipt_missing","latest_engine_ha_receipt_missing","latest_agent_arrival_receipt_failed","latest_fdb_autoscaling_receipt_missing","latest_user_transparent_upgrade_receipt_missing","latest_semantic_failure_rollback_receipt_missing","dr_receipt_missing","static_release_ledger_not_converged","static_release_drift_components=1","prometheus_critical_alerts_exist","prometheus_critical_alerts=1"],"warnings":[]}
JSON
bind_source "$temporary/initial-ledger-control.json" "$temporary/initial-ledger-audit.json"
initial_ledger_environment=(
	AUTONOMY_CONTROL_FILE="$temporary/initial-ledger-control.json"
	AUTONOMY_CONTROL_REQUIRE_LOCK=0
	AUTONOMY_CONTROL_CELL=actor-bj-q01
	AUTONOMY_CONTROL_NAMESPACE=actor-fdb-cell-system
	AUTONOMY_CONTROL_ALLOW_STATIC_RELEASE_RECOVERY=1
	AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=1
	AUTONOMY_CONTROL_TEST_MODE=1
	AUTONOMY_CONTROL_TEST_INITIAL_LEDGER_EXISTS=0
	AUTONOMY_WORKFLOW=runtime.release
	RIVET_REPORTER_IMAGE="$regional_reporter_image"
	RIVET_REPORTER_SOURCE_REVISION="$reporter_revision"
	RIVET_REPORTER_SOURCE_MANIFEST_SHA256="$reporter_manifest"
)
output=$(env "${initial_ledger_environment[@]}" "$script_dir/assert-autonomy-control.sh")
[[ $output == *"decision=initial-ledger-bootstrap-allowed"* ]]

python3 - "$temporary/initial-ledger-control.json" "$temporary/initial-ledger-audit.json" <<'PY'
import hashlib,json,sys
control_path,audit_path=sys.argv[1:]
audit=json.load(open(audit_path)); audit["evidence"]["qualification_mode"]="autoscaling-cell"
json.dump(audit,open(audit_path,"w"))
control=json.load(open(control_path))
control["source_receipt_sha256"]=hashlib.sha256(open(audit_path,"rb").read()).hexdigest()
json.dump(control,open(control_path,"w"))
PY
output=$(env "${initial_ledger_environment[@]}" "$script_dir/assert-autonomy-control.sh")
[[ $output == *"decision=initial-ledger-bootstrap-allowed"* ]]

set +e
env "${initial_ledger_environment[@]}" AUTONOMY_CONTROL_TEST_INITIAL_LEDGER_EXISTS=1 \
	"$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

set +e
env "${initial_ledger_environment[@]}" AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY=0 \
	"$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

python3 - "$temporary/initial-ledger-control.json" "$temporary/initial-ledger-audit.json" <<'PY'
import hashlib,json,sys
control_path,audit_path=sys.argv[1:]
audit=json.load(open(audit_path)); audit["failures"].append("foundationdb_available=false")
json.dump(audit,open(audit_path,"w"))
control=json.load(open(control_path)); control["failures"].append("foundationdb_available=false")
control["source_receipt_sha256"]=hashlib.sha256(open(audit_path,"rb").read()).hexdigest()
json.dump(control,open(control_path,"w"))
PY
set +e
env "${initial_ledger_environment[@]}" "$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

set +e
env "${static_release_environment[@]}" RIVET_REPORTER_SOURCE_REVISION=invalid \
	"$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

set +e
env "${static_release_environment[@]}" AUTONOMY_CONTROL_ALLOW_STATIC_RELEASE_RECOVERY=0 \
	"$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

set +e
env "${static_release_environment[@]}" AUTONOMY_WORKFLOW=runtime.machine-repair \
	"$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

python3 - "$temporary/static-release-control.json" <<'PY'
import json,sys
p=sys.argv[1]; x=json.load(open(p)); x["failures"].append("fdb_unavailable"); json.dump(x,open(p,"w"))
PY
bind_source "$temporary/static-release-control.json" "$temporary/static-release-audit.json"
set +e
env "${static_release_environment[@]}" "$script_dir/assert-autonomy-control.sh" >/dev/null 2>&1
status=$?
set -e
[[ $status -eq 2 ]]

echo "assert-autonomy-control Cell binding: pass"
