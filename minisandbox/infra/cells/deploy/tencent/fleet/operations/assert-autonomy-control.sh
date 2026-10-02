#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)

workflow=${AUTONOMY_WORKFLOW:-unknown}
decisions_dir=${AUTONOMY_CONTROL_DECISIONS_DIR:-${AUTONOMY_CONTROL_OUTPUT_DIR:-/var/lib/actor/autonomy/decisions}}
control_file=${AUTONOMY_CONTROL_FILE:-}
max_age_hours=${AUTONOMY_CONTROL_MAX_AGE_HOURS:-24}
require_lock=${AUTONOMY_CONTROL_REQUIRE_LOCK:-1}
lock_path=${AUTONOMY_CONTROL_LOCK_PATH:-/data/tmp/actor-autonomy-operations.lock}
allow_degrade=${AUTONOMY_CONTROL_ALLOW_DEGRADE:-0}
allow_evidence_recovery=${AUTONOMY_CONTROL_ALLOW_EVIDENCE_RECOVERY:-0}
allow_static_release_recovery=${AUTONOMY_CONTROL_ALLOW_STATIC_RELEASE_RECOVERY:-0}
qualification_candidate_receipt=${AUTONOMY_CONTROL_QUALIFICATION_CANDIDATE_RECEIPT:-}
qualification_rollback_receipt=${AUTONOMY_CONTROL_QUALIFICATION_ROLLBACK_RECEIPT:-}
qualification_receipt_root=${AUTONOMY_CONTROL_QUALIFICATION_RECEIPT_ROOT:-}
expected_cell=${AUTONOMY_CONTROL_CELL:-${RIVET_CELL_NAME:-${CELL:-}}}
expected_namespace=${AUTONOMY_CONTROL_NAMESPACE:-${RIVET_CELL_NAMESPACE:-${CELL_NAMESPACE:-}}}
release_authorization=

if [[ -n $qualification_candidate_receipt || -n $qualification_rollback_receipt ]]; then
  authorization_args=()
  if [[ -n $qualification_receipt_root ]]; then
    [[ ${AUTONOMY_CONTROL_TEST_MODE:-0} == 1 && $qualification_receipt_root == /data/tmp/* && -d $qualification_receipt_root ]] || {
      echo "autonomy-control: alternate qualification receipt root is test-only under /data/tmp" >&2
      exit 2
    }
    authorization_args+=(--receipt-root "$qualification_receipt_root")
  fi
  [[ -z $qualification_candidate_receipt ]] || authorization_args+=(--candidate-receipt "$qualification_candidate_receipt")
  [[ -z $qualification_rollback_receipt ]] || authorization_args+=(--rollback-receipt "$qualification_rollback_receipt")
  set +e
  release_authorization=$(python3 "$script_dir/verify-release-qualification-authorization.py" \
    --workflow "$workflow" --cell "$expected_cell" --namespace "$expected_namespace" \
    --runtime-image "${RIVET_RUNTIME_IMAGE:-}" \
    --source-revision "${RIVET_SOURCE_REVISION:-}" \
    --source-manifest "${RIVET_SOURCE_MANIFEST_SHA256:-}" \
    "${authorization_args[@]}" 2>&1)
  authorization_status=$?
  set -e
  if ((authorization_status != 0)); then
    echo "autonomy-control: invalid release qualification authorization: $release_authorization" >&2
    exit 2
  fi
fi

if [[ -n ${control_file} && ! -f ${control_file} ]]; then
  echo "autonomy-control: configured control receipt does not exist: $control_file" >&2
  exit 2
fi

if [[ -z ${control_file} ]]; then
  if [[ ! -d ${decisions_dir} ]]; then
    echo "autonomy-control: decisions directory not found: $decisions_dir" >&2
    exit 2
  fi
  control_file=$(python3 - "$decisions_dir" "$expected_cell" "$expected_namespace" <<'PY'
import glob
import json
import os
import sys

directory, expected_cell, expected_namespace = sys.argv[1:]
matches = []
for path in glob.glob(os.path.join(directory, "autonomy-control-*.json")):
    try:
        with open(path) as stream:
            payload = json.load(stream)
    except (OSError, ValueError):
        continue
    if expected_cell and payload.get("cell") != expected_cell:
        continue
    if expected_namespace and payload.get("namespace") != expected_namespace:
        continue
    matches.append(path)
print(sorted(matches)[-1] if matches else "")
PY
)
fi

if [[ -z ${control_file:-} || ! -f ${control_file} ]]; then
  echo "autonomy-control: no autonomy-control receipt found in ${decisions_dir}" >&2
  exit 2
fi

if [[ ${require_lock} == 1 ]]; then
  if ! command -v flock >/dev/null 2>&1; then
    echo "autonomy-control: flock required but not installed" >&2
    exit 2
  fi
  exec 9>"${lock_path}"
  if ! flock -n 9; then
    echo "autonomy-control: another risky cluster operation is running; refuse start for workflow=$workflow" >&2
    exit 1
  fi
fi

set +e
result=$(python3 - "$control_file" "$max_age_hours" "$allow_degrade" "$allow_evidence_recovery" "$allow_static_release_recovery" "$workflow" "$expected_cell" "$expected_namespace" "$release_authorization" "${RIVET_REPORTER_IMAGE:-}" "${RIVET_REPORTER_SOURCE_REVISION:-}" "${RIVET_REPORTER_SOURCE_MANIFEST_SHA256:-}" <<'PY'
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone

path, max_age_hours, allow_degrade, allow_evidence_recovery, allow_static_release_recovery, workflow, expected_cell, expected_namespace, release_authorization, reporter_image, reporter_revision, reporter_manifest = sys.argv[1:]
max_age_hours = float(max_age_hours)
allow_degrade = str(allow_degrade) in {"1", "true", "True", "yes", "YES"}
allow_evidence_recovery = str(allow_evidence_recovery) in {"1", "true", "True", "yes", "YES"}
allow_static_release_recovery = str(allow_static_release_recovery) in {"1", "true", "True", "yes", "YES"}

with open(path) as stream:
    payload = json.load(stream)

if payload.get("schemaVersion") != "actor-fdb-autonomy-control-v1":
    print(f"{path}|invalid|None|control receipt schema mismatch")
    raise SystemExit(2)

if expected_cell and payload.get("cell") != expected_cell:
    print(f"{path}|mismatch|None|control receipt cell {payload.get('cell')!r} does not match {expected_cell!r}")
    raise SystemExit(2)
if expected_namespace and payload.get("namespace") != expected_namespace:
    print(f"{path}|mismatch|None|control receipt namespace {payload.get('namespace')!r} does not match {expected_namespace!r}")
    raise SystemExit(2)

source_receipt = payload.get("source_receipt")
source_receipt_sha256 = payload.get("source_receipt_sha256")
if not isinstance(source_receipt, str) or not os.path.isabs(source_receipt):
    print(f"{path}|invalid|None|control receipt source path is missing or not absolute")
    raise SystemExit(2)
if not isinstance(source_receipt_sha256, str) or not re.fullmatch(r"[0-9a-f]{64}", source_receipt_sha256):
    print(f"{path}|invalid|None|control receipt source digest is missing or invalid")
    raise SystemExit(2)
try:
    with open(source_receipt, "rb") as stream:
        observed_source_sha256 = hashlib.sha256(stream.read()).hexdigest()
except OSError:
    print(f"{path}|invalid|None|control receipt source is unavailable")
    raise SystemExit(2)
if observed_source_sha256 != source_receipt_sha256:
    print(f"{path}|invalid|None|control receipt source digest mismatch")
    raise SystemExit(2)

def parse_age(ts):
    if not ts:
        return None
    try:
        # The builder still ships Python 3.6, which has no
        # datetime.fromisoformat. Control receipts are canonical UTC Zulu.
        parsed = datetime.strptime(ts, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None
    parsed = parsed.replace(tzinfo=timezone.utc)
    return max(0.0, (datetime.now(timezone.utc) - parsed).total_seconds() / 3600.0)

control = str(payload.get("control", "unknown")).lower()
age_hours = parse_age(payload.get("timestamp", ""))
if age_hours is None:
    control = "unknown"
    reason = "control receipt timestamp missing or unparsable"
    print(f"{path}|{control}|{age_hours if age_hours is not None else None}|{reason}")
    raise SystemExit(2)

if age_hours > max_age_hours:
    control = "stale"
    reason = f"control receipt is stale: {age_hours:.2f}h > {max_age_hours}h"
    print(f"{path}|{control}|{age_hours}|{reason}")
    raise SystemExit(2)

if control == "allow":
    print(f"{path}|allow|{age_hours}|none")
    raise SystemExit(0)

if control == "degrade":
    if allow_degrade:
        print(f"{path}|degrade-allowed|{age_hours}|degrade accepted due to AUTONOMY_CONTROL_ALLOW_DEGRADE=true")
        raise SystemExit(0)
    print(f"{path}|degrade|{age_hours}|workflow={workflow} blocked by autonomy control")
    raise SystemExit(1)

if control == "block":
    if release_authorization in {
        "intentional-semantic-failure-candidate",
        "completed-semantic-failure-rollback",
    }:
        print(f"{path}|qualification-authorized|{age_hours}|{release_authorization}")
        raise SystemExit(0)
    receipt_only = (
        "latest_bottomless_receipt_",
        "latest_engine_ha_receipt_",
        "latest_agent_arrival_receipt_",
        "latest_fdb_autoscaling_receipt_",
        "latest_user_transparent_upgrade_receipt_",
        "latest_semantic_failure_rollback_receipt_",
        "dr_receipt_",
    )
    recovery_workflows = {
        "runtime.release",
        "runtime.qualify",
        "runtime.engine-ha",
        "runtime.agent-arrival",
        "runtime.machine-repair",
        "runtime.automatic-machine-repair",
        "runtime.machine-repair-configure",
        "runtime.topology-repair",
        "autoscaling.qualify",
        "fdb.autoscaling.promote",
        "controller.release",
        "dr.capacity",
        "dr.physical-restore",
        "dr.zone-recovery",
        "dr.primary-az-loss",
    }
    failures = payload.get("failures", [])
    warnings = payload.get("warnings", [])
    receipt_failure = lambda item: isinstance(item, str) and item.startswith(receipt_only)
    bootstrap_mode_failure = "fdb_autoscaling_mode_not_automatic"
    topology_recovery_failures = {
        "runtime_not_in_three_zones",
        "prometheus_critical_alerts_exist",
        "prometheus_critical_alerts=1",
    }
    source = payload.get("source_receipt")
    audit = None
    try:
        with open(source) as stream:
            audit = json.load(stream)
    except (OSError, ValueError, TypeError):
        audit = None
    static_release_recovery_ok = False
    reporter_artifact_valid = (
        re.fullmatch(
            r"[a-z0-9][a-z0-9.-]*(?::[0-9]+)?/actor-fleet/actor-fleet-controller@sha256:[0-9a-f]{64}",
            reporter_image or "",
        ) is not None
        and re.fullmatch(r"[0-9a-f]{40}", reporter_revision or "") is not None
        and re.fullmatch(r"[0-9a-f]{64}", reporter_manifest or "") is not None
    )
    if allow_static_release_recovery and workflow == "runtime.release" and isinstance(audit, dict):
        readiness = audit.get("readiness_summary", {})
        static_release = audit.get("evidence", {}).get("static_release", audit.get("static_release", {}))
        drifts = static_release.get("drifts", [])
        expected_static_failures = {
            "static_release_ledger_not_converged",
            "static_release_drift_components=1",
        }
        observed_failures = set(failures) if all(isinstance(item, str) for item in failures) else set()
        optional_failed_evidence = {"latest_user_transparent_upgrade_receipt_failed"}
        static_release_recovery_ok = (
            not warnings
            and expected_static_failures.issubset(observed_failures)
            and observed_failures.issubset(expected_static_failures | optional_failed_evidence)
            and audit.get("cell") == expected_cell
            and audit.get("namespace") == expected_namespace
            and readiness.get("static_release_converged") is False
            and readiness.get("fdb_available") is True
            and readiness.get("fdb_full_replication") is True
            and readiness.get("backup_restorable") is True
            and readiness.get("engine_ready") is True
            and readiness.get("runtime_ready") is True
            and readiness.get("fdb_autoscaling_automatic") is True
            and readiness.get("fdb_autoscaling_stable") is True
            and readiness.get("active_topology_zones", {}).get("engine") == 3
            and readiness.get("active_topology_zones", {}).get("fdb") == 3
            and readiness.get("active_topology_zones", {}).get("runtime") == 3
            and static_release.get("ready") is False
            and static_release.get("driftCount") == 1
            and isinstance(drifts, list) and len(drifts) == 1
            and drifts[0].get("component") == "Deployment/%s-cell-reporter" % expected_cell
            and drifts[0].get("reason") == "static_spec_digest_mismatch"
            and static_release.get("externalReceiptMatches") is True
            and static_release.get("payloadDigestMatches") is True
            # release-runtime.sh has already bound this exact ref to the
            # complete image inventory. Keep this assertion registry-neutral
            # so a clean-room regional TCR is not mistaken for an unreviewed
            # artifact, while still rejecting tags and foreign repositories.
            and reporter_artifact_valid
        )
    if static_release_recovery_ok:
        print(f"{path}|static-release-recovery-allowed|{age_hours}|single reporter ledger repair authorized against an otherwise healthy Cell")
        raise SystemExit(0)
    # A create-first Cell cannot produce release-bound Bottomless, Engine HA,
    # or physical-restore receipts before its first immutable release ledger
    # exists. Authorize exactly that one bootstrap transition only when both
    # recovery capabilities were explicitly enabled, the sole firing alert is
    # the missing-ledger alert, and every live health/topology invariant is
    # already green. Any additional failure remains a hard block.
    initial_ledger_bootstrap_ok = False
    if (allow_static_release_recovery and allow_evidence_recovery
            and workflow == "runtime.release" and isinstance(audit, dict)):
        readiness = audit.get("readiness_summary", {})
        evidence = audit.get("evidence", {})
        static_release = evidence.get("static_release", {})
        drifts = static_release.get("drifts", [])
        alerts = audit.get("prometheus", {}).get("alerts", {}).get("firing", [])
        required_failures = {
            "static_release_ledger_not_converged",
            "static_release_drift_components=1",
            "prometheus_critical_alerts_exist",
            "prometheus_critical_alerts=1",
        }
        control_failures = set(failures) if all(isinstance(item, str) for item in failures) else set()
        audit_failures = set(audit.get("failures", [])) if all(
            isinstance(item, str) for item in audit.get("failures", [])
        ) else set()
        initial_ledger_bootstrap_ok = (
            not warnings
            and audit.get("warnings") == []
            and required_failures.issubset(control_failures)
            and required_failures.issubset(audit_failures)
            and all(item in required_failures or receipt_failure(item) for item in control_failures)
            and all(item in required_failures or receipt_failure(item) for item in audit_failures)
            and control_failures == audit_failures
            and audit.get("cell") == expected_cell
            and audit.get("namespace") == expected_namespace
            and evidence.get("strict_mode") is True
            # A create-first Cell may already have promoted FDB autoscaling
            # before its first Runtime ledger.  Both modes share the same
            # strict health/topology checks below; the mode name must not
            # deadlock that first immutable Runtime publication.
            and evidence.get("qualification_mode") in {"initial-cell", "autoscaling-cell"}
            and readiness.get("static_release_converged") is False
            and readiness.get("fdb_available") is True
            and readiness.get("fdb_full_replication") is True
            and readiness.get("backup_restorable") is True
            and readiness.get("engine_ready") is True
            and readiness.get("runtime_ready") is True
            and readiness.get("fdb_autoscaling_automatic") is True
            and readiness.get("fdb_autoscaling_stable") is True
            and readiness.get("active_topology_zones", {}).get("engine") == 3
            and readiness.get("active_topology_zones", {}).get("fdb") == 3
            and readiness.get("active_topology_zones", {}).get("runtime") == 3
            and static_release.get("ready") is False
            and static_release.get("driftCount") == 1
            and static_release.get("releaseId") is None
            and drifts == [{"component": "ledger", "reason": "release_ledger_configmap_missing"}]
            and len(alerts) == 1
            and alerts[0].get("alert") == "ActorStaticReleaseDrift"
            and alerts[0].get("severity") == "critical"
            and alerts[0].get("labels", {}).get("cell") == expected_cell
            and reporter_artifact_valid
        )
    if initial_ledger_bootstrap_ok:
        print(f"{path}|initial-ledger-bootstrap-allowed|{age_hours}|first immutable release ledger authorized on an otherwise healthy initial Cell")
        raise SystemExit(0)
    topology_recovery_ok = False
    if workflow == "runtime.topology-repair" and isinstance(audit, dict):
        kubernetes = audit.get("kubernetes", {})
        fdb = kubernetes.get("fdb", {})
        topology = kubernetes.get("topology", {})
        alerts = audit.get("prometheus", {}).get("alerts", {}).get("firing", [])
        topology_recovery_ok = (
            audit.get("cell") == expected_cell
            and audit.get("namespace") == expected_namespace
            and fdb.get("available") is True
            and fdb.get("healthy") is True
            and fdb.get("fullReplication") is True
            and fdb.get("reconcileAligned") is True
            and fdb.get("backupRunning") is True
            and fdb.get("backupRestorable") is True
            and topology.get("engineReadyReplicas") == 6
            and len(topology.get("engineZones", {})) == 3
            and topology.get("runtimeHostReady") == 3
            and topology.get("runtimeHostStatefulSetReplicas") == 3
            and len(topology.get("runtimeHostZones", {})) == 2
            and len(alerts) == 1
            and alerts[0].get("alert") == "ActorRuntimeZoneSkew"
            and alerts[0].get("severity") == "critical"
        )
    allowed_failure = lambda item: (
        receipt_failure(item)
        or item == bootstrap_mode_failure
        or (topology_recovery_ok and item in topology_recovery_failures)
    )
    bootstrap_ok = bootstrap_mode_failure not in failures
    if bootstrap_mode_failure in failures:
        bootstrap_ok = False
        try:
            if not isinstance(audit, dict):
                raise ValueError("source audit unavailable")
            autoscaling = audit["kubernetes"]["autoscaling"]
            bootstrap_ok = (
                audit.get("cell") == expected_cell
                and audit.get("namespace") == expected_namespace
                and autoscaling.get("mode") == "ObserveOnly"
                and autoscaling.get("desiredObservedAligned") is True
                and autoscaling.get("threeWayProcessAlignment") is True
                and autoscaling.get("volumeGCMode") == "ObserveOnly"
                and autoscaling.get("retentionAtLeast30Days") is True
            )
        except (OSError, ValueError, KeyError, TypeError):
            bootstrap_ok = False
    if (allow_evidence_recovery and workflow in recovery_workflows and failures and not warnings
            and all(allowed_failure(item) for item in failures) and bootstrap_ok):
        decision = "evidence-bootstrap-allowed" if bootstrap_mode_failure in failures else "evidence-recovery-allowed"
        reason = "qualification evidence may be regenerated from a healthy ObserveOnly FDB baseline"
        print(f"{path}|{decision}|{age_hours}|{reason}")
        raise SystemExit(0)
    print(f"{path}|block|{age_hours}|workflow={workflow} blocked by autonomy control")
    raise SystemExit(2)

print(f"{path}|unknown|{age_hours}|control value invalid: {control}")
raise SystemExit(2)
PY
)
rc=$?
set -e

if [[ $rc -ne 0 ]]; then
  IFS='|' read -r parsed_path parsed_control parsed_age parsed_reason <<<"$result"
  echo "autonomy-control: workflow=${workflow} decision=${parsed_control} age=${parsed_age}h receipt=${parsed_path}" >&2
  echo "autonomy-control: reason=${parsed_reason}" >&2
  if [[ $parsed_control == degrade ]]; then
    echo "autonomy-control: an approved temporary path may set AUTONOMY_CONTROL_ALLOW_DEGRADE=1." >&2
  else
    echo "autonomy-control: block has no generic bypass; a verified qualification or rollback receipt is required." >&2
  fi
  exit "$rc"
fi

IFS='|' read -r parsed_path parsed_control parsed_age parsed_reason <<<"$result"
if [[ $parsed_control == initial-ledger-bootstrap-allowed ]]; then
  # A missing-ledger audit is an edge-triggered bootstrap authorization, not
  # a reusable 24-hour release capability. Re-check the sole live fact that
  # the immutable receipt cannot prove at assertion time. The operation lock
  # serializes local mutation and release-runtime's Kubernetes release hold
  # rejects a concurrent operator before either can publish a second ledger.
  if [[ ${AUTONOMY_CONTROL_TEST_MODE:-0} == 1 ]]; then
    case ${AUTONOMY_CONTROL_TEST_INITIAL_LEDGER_EXISTS:-} in
      0) live_ledger= ;;
      1) live_ledger="configmap/${expected_cell}-release-ledger" ;;
      *)
        echo "autonomy-control: test initial-ledger state must be explicitly 0 or 1" >&2
        exit 2
        ;;
    esac
  else
    command -v kubectl >/dev/null 2>&1 || {
      echo "autonomy-control: kubectl is required to consume initial-ledger authorization" >&2
      exit 2
    }
    set +e
    live_ledger=$(kubectl -n "$expected_namespace" get configmap \
      "${expected_cell}-release-ledger" --ignore-not-found -o name 2>/dev/null)
    ledger_check_status=$?
    set -e
    if ((ledger_check_status != 0)); then
      echo "autonomy-control: cannot verify live initial-ledger state; fail closed" >&2
      exit 2
    fi
  fi
  if [[ -n $live_ledger ]]; then
    echo "autonomy-control: initial-ledger authorization was already consumed by $live_ledger" >&2
    exit 2
  fi
fi
echo "autonomy-control: workflow=${workflow} decision=${parsed_control} age=${parsed_age}h receipt=${parsed_path}"
echo "autonomy-control: proceed with guarded mutation"
exit 0
