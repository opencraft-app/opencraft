"""Execute the unmodified Bash entrypoint with offline boundary doubles.

The shell clock is advanced by a test-only BASH_ENV sleep function. There is no
cloud access, no accelerated production policy, and no claim-eligible receipt.
"""

import json
import fcntl
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

import yaml

from test_verify import sample


ROOT = Path(__file__).parent
RUN_ID = "a" * 32


class SupervisorTests(unittest.TestCase):
    def run_supervisor(self, load_status=0, cleanup_status=0, final_timeout=False,
                       missing_load_receipt=False, deployed_profile="production",
                       evidence_mode="production", drift_after_load=False, control_status=0):
        with tempfile.TemporaryDirectory(dir=os.environ.get("TMPDIR", "/data/tmp")) as temporary:
            base = Path(temporary)
            source = base / "source"
            fleet = source / "infra/cells/deploy/tencent/fleet"
            for relative in ("load/shared-agent-scale/runner.mjs",
                             "load/shared-agent-scale/cleanup.py",
                             "load/agent-upload-soak/observe.py"):
                file = fleet / relative
                file.parent.mkdir(parents=True, exist_ok=True)
                file.touch()
            control = fleet / "operations/assert-autonomy-control.sh"
            control.parent.mkdir(parents=True)
            control.write_text('''#!/usr/bin/env bash
set -euo pipefail
[[ $AUTONOMY_OPERATION_LOCK_HELD == 1 && $AUTONOMY_WORKFLOW == runtime.qualify ]]
[[ $AUTONOMY_CONTROL_CELL == actor-bj-a01 || $AUTONOMY_CONTROL_CELL == actor-bj-b01 ]]
[[ $AUTONOMY_CONTROL_NAMESPACE == actor-fdb-cell-system ]]
touch "$TEST_BASE/control-$AUTONOMY_CONTROL_CELL"
exit "$TEST_CONTROL_STATUS"
''')
            verifier = fleet / "load/ten-thousand-active/verify.py"
            verifier.parent.mkdir(parents=True)
            shutil.copyfile(ROOT / "verify.py", verifier)
            exploration = fleet / "load/exploration-capacity/verify.py"
            exploration.parent.mkdir(parents=True)
            shutil.copyfile(ROOT.parent / "exploration-capacity/verify.py", exploration)
            runtime = ROOT.parents[1] / "runtime"
            checker = fleet / "runtime/host-drain-profile.py"
            checker.parent.mkdir(parents=True)
            shutil.copyfile(runtime / "host-drain-profile.py", checker)
            raw = (runtime / "host-autoscaling.yaml").read_text()
            for name, value in {
                "__CELL_NAME__": "actor-bj-a01", "__NAMESPACE__": "actor-fdb-cell-system",
                "__CONTROLLER_IMAGE__": "registry.example/actor-fleet/actor-fleet-controller@sha256:" + "1" * 64,
                "__MIN_REPLICAS__": "4", "__MAX_REPLICAS__": "301", "__TARGET_ACTIVE_ACTORS__": "16",
                "__TOPOLOGY_MAX_SKEW__": "2", "__TOPOLOGY_REPAIR_ENABLED__": "false", "__RUNTIME_MACHINE_SET__": "np-runtime0",
            }.items():
                raw = raw.replace(name, value)
            deployment = next(value for value in yaml.safe_load_all(raw) if value["kind"] == "Deployment")
            if deployed_profile == "exploration":
                deployment["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/host-drain-profile"] = "exploration"
                env = {entry["name"]: entry for entry in deployment["spec"]["template"]["spec"]["containers"][0]["env"]}
                env["HOST_DRAIN_STABILIZATION"]["value"] = "30s"
                env["HOST_DRAIN_RECONCILE_INTERVAL"]["value"] = "2s"
            (base / "drain.fixture").write_text(json.dumps(deployment))
            for name in ("actor-bj-a01", "actor-bj-b01"):
                config = base / f"cells/{name}/cell.kubeconfig"
                config.parent.mkdir(parents=True)
                config.write_text("offline fixture, not a kubeconfig\n")
                (base / f"{name}-federation-endpoint.json").write_text("{}\n")
            endpoint = base / "receipts/workers-api/endpoint-installation.json"
            endpoint.parent.mkdir(parents=True)
            endpoint.write_text('{"endpoint":"http://offline.invalid"}\n')
            # These deliberately all-pass documents check that a failed command
            # cannot hide behind already-written input evidence.
            active_target = 10000 if evidence_mode == "production" else 320
            objects = 11000 if evidence_mode == "production" else 352
            hosts = 300 if evidence_mode == "production" else 12
            values = [sample(0, 0, 4, 4), sample(1, active_target, hosts, hosts),
                      sample(2, active_target, hosts, hosts), sample(3, active_target, hosts, hosts),
                      sample(4, 0, hosts - 1, hosts, "Observing"), sample(5, 0, 4, 4)]
            (base / "trace.fixture").write_text("".join(json.dumps(row) + "\n" for row in values))
            (base / "load.fixture").write_text(json.dumps({
                "schema": "actor-shared-agent-scale/v1", "runId": RUN_ID,
                "verdict": "passed", "target": objects, "activeTarget": active_target,
                "activeReady": active_target, "activeProven": active_target,
                "counters": {"scheduled": objects, "objectsCreated": objects, "objectsFailed": 0,
                             "readySloBreaches": 0, "requestRetries": 0,
                             "activeFailed": 0, "activeIdentityMismatches": 0},
            }))
            (base / "cleanup.fixture").write_text(json.dumps({
                "schema": "actor-shared-agent-cleanup/v1", "verdict": "passed",
                "runs": [{"runId": RUN_ID, "scheduled": objects}],
                "objects": {"total": objects, "deleted": objects, "pending": 0},
            }))
            node = base / "node-double"
            node.write_text("""#!/usr/bin/env bash
set -euo pipefail
printf '%s\\n' "$@" > "$TEST_BASE/node.args"
mkdir -p "$TEST_OUT/load"
if [[ $TEST_MISSING_LOAD != 1 ]]; then
  cp "$TEST_BASE/load.fixture" "$TEST_OUT/load/receipt.json"
fi
touch "$TEST_BASE/load-finished"
exit "$TEST_LOAD_STATUS"
""")
            node.chmod(0o700)
            bash_env = base / "boundary-doubles.sh"
            bash_env.write_text("""
sleep() {
  if [[ $1 == 20 ]]; then
    for ((tries=0; tries<200; tries++)); do
      [[ ! -f $TEST_BASE/observer-ready ]] || break
      command sleep 0.01
    done
    [[ -f $TEST_BASE/observer-ready ]] || return 93
  fi
  if [[ -f $TEST_BASE/load-finished && $TEST_FINAL_TIMEOUT == 1 ]]; then
    SECONDS=$((SECONDS + 129600))
  else
    SECONDS=$((SECONDS + $1))
  fi
}
kubectl() {
  printf '%s\\n' "$*" >>"$TEST_BASE/kubectl.calls"
  [[ " $* " == *" get "* ]] || return 90
  if [[ -f $TEST_BASE/load-finished && $TEST_FINAL_TIMEOUT == 1 ]]; then
    echo 'offline API unavailable' >&2; return 1
  fi
  case " $* " in
    *" get deployment "*)
      if [[ -f $TEST_BASE/load-finished && $TEST_PROFILE_DRIFT == 1 ]]; then
        echo 'not-json'
      else
        command cat "$TEST_BASE/drain.fixture"
      fi ;;
    *" get statefulset "*) printf '%s\\n' '{"metadata":{"annotations":{"fleet.actor.dev/workerd-host-drain-state":"{\\"phase\\":\\"Idle\\"}"}},"spec":{"replicas":4},"status":{"readyReplicas":4,"currentReplicas":4,"currentRevision":"r1","updateRevision":"r1"}}' ;;
    *" get machineset np-runtime0 "*) printf '%s\\n' '{"metadata":{},"spec":{"replicas":4},"status":{"replicas":4,"readyReplicas":4}}' ;;
    *" get machineset np-runtime1 "*) echo 'NotFound' >&2; return 1 ;;
    *" get nodes "*) command jq -n '{items:[range(4)|{metadata:{labels:{"fleet.actor.dev/runtime-admitted":"true"}},status:{conditions:[{type:"Ready",status:"True"}]}}]}' ;;
    *) return 91 ;;
  esac
}
python3.11() {
  case "$1" in
    */host-drain-profile.py) command python3 "$@" ;;
    */observe.py)
      cp "$TEST_BASE/trace.fixture" "$TEST_OUT/capacity.ndjson"
      touch "$TEST_BASE/observer-ready"
      trap 'touch "$TEST_BASE/observer-stopped"; exit 0' TERM INT
      while true; do command sleep 0.01; done ;;
    */cleanup.py)
      cp "$TEST_BASE/cleanup.fixture" "$TEST_OUT/cleanup-receipt.json"
      touch "$TEST_BASE/cleanup-called"
      return "$TEST_CLEANUP_STATUS" ;;
    */verify.py)
      touch "$TEST_BASE/verifier-called"
      command python3 "$@" ;;
    *) return 92 ;;
  esac
}
""")
            prefix = "ten-thousand-active" if evidence_mode == "production" else "exploration-capacity"
            out = base / f"load-tests/{prefix}-{RUN_ID}"
            env = dict(os.environ, BASH_ENV=str(bash_env), ACTOR_REVIEWED_SOURCE=str(source),
                       ACTOR_BOOTSTRAP_ROOT=str(base), ACTOR_BUILD_ROOT=str(base),
                       ACTOR_NODE_BINARY=str(node), TEST_BASE=str(base), TEST_OUT=str(out),
                       TEST_LOAD_STATUS=str(load_status), TEST_CLEANUP_STATUS=str(cleanup_status),
                       TEST_FINAL_TIMEOUT=str(int(final_timeout)),
                       TEST_MISSING_LOAD=str(int(missing_load_receipt)), PYTHONDONTWRITEBYTECODE="1",
                       TEST_PROFILE_DRIFT=str(int(drift_after_load)), AUTONOMY_OPERATION_LOCK_HELD="1",
                       TEST_CONTROL_STATUS=str(control_status))
            entry = ROOT / "run-on-builder.sh" if evidence_mode == "production" else ROOT.parent / "exploration-capacity/run-on-builder.sh"
            result = subprocess.run(["bash", str(entry), RUN_ID],
                                    env=env, capture_output=True, text=True, timeout=10)
            if evidence_mode == "exploration" and control_status != 0:
                self.assertFalse(out.exists())
                self.assertFalse((base / "kubectl.calls").exists())
                self.assertFalse((base / "load-finished").exists())
                return result, None
            if deployed_profile != evidence_mode:
                self.assertFalse((base / "load-finished").exists())
                self.assertFalse((base / "observer-ready").exists())
                self.assertFalse((base / "cleanup-called").exists())
                self.assertFalse((base / "verifier-called").exists())
                self.assertFalse((out / "receipt.json").exists())
                return result, None
            self.assertTrue((base / "verifier-called").exists(), result.stderr)
            self.assertTrue((base / "observer-stopped").exists(), result.stderr)
            self.assertEqual((base / "cleanup-called").exists(), not missing_load_receipt)
            if evidence_mode == "exploration":
                for cell in ("actor-bj-a01", "actor-bj-b01"):
                    self.assertTrue((base / f"control-{cell}").exists())
            arguments = (base / "node.args").read_text().splitlines()
            for flag, value in {
                "--count": str(objects), "--active": str(active_target), "--warmup": str(active_target),
                "--rate": "20", "--warmup-rate": "2", "--active-interval-ms": "10000",
                "--ready-slo-ms": "3000", "--retries": "3",
                "--workers": "16" if evidence_mode == "production" else "4",
                "--warmup-settle-ms": "120000" if evidence_mode == "production" else "30000",
                "--observe-after-ms": "600000" if evidence_mode == "production" else "60000",
            }.items():
                self.assertEqual(arguments[arguments.index(flag) + 1], value, flag)
            calls = (base / "kubectl.calls").read_text().splitlines()
            self.assertTrue(all(" get " in f" {call} " for call in calls))
            receipt_path = out / "receipt.json"
            receipt = json.loads(receipt_path.read_bytes()) if receipt_path.exists() else None
            if receipt_path.exists():
                self.assertEqual(receipt_path.stat().st_mode & 0o777, 0o600)
            return result, receipt

    def test_complete_cycle_still_passes(self):
        result, receipt = self.run_supervisor()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(receipt["verdict"], "passed")
        self.assertIn("ten_thousand_active_qualification=passed", result.stdout)

    def test_exploration_deployment_rejected_before_any_load(self):
        result, receipt = self.run_supervisor(deployed_profile="exploration")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIsNone(receipt)
        self.assertIn("Host drain profile input rejected", result.stderr)

    def test_final_timeout_writes_failed_receipt_and_stops_observer(self):
        result, receipt = self.run_supervisor(final_timeout=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertEqual(receipt["verdict"], "failed")
        self.assertEqual(receipt["executionExitStatuses"]["finalCapacity"], 1)
        self.assertFalse(receipt["checks"]["finalLowCapacity"])
        self.assertIn("final_capacity_exit_status=1", result.stdout)
        self.assertIn("ten_thousand_active_qualification=failed", result.stdout)
        self.assertNotIn("ten_thousand_active_qualification=passed", result.stdout)

    def test_load_and_cleanup_process_failures_are_fail_closed(self):
        for kwargs in ({"load_status": 42}, {"cleanup_status": 1}):
            with self.subTest(kwargs=kwargs):
                result, receipt = self.run_supervisor(**kwargs)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(receipt["verdict"], "failed")
                self.assertFalse(receipt["checks"]["executionSucceeded"])
                self.assertNotIn("ten_thousand_active_qualification=passed", result.stdout)

    def test_missing_input_never_claims_success(self):
        result, receipt = self.run_supervisor(load_status=1, missing_load_receipt=True)
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIsNone(receipt)
        self.assertIn("verifier_exit_status=1", result.stdout)
        self.assertIn("ten_thousand_active_qualification=failed", result.stdout)

    def test_exploration_cycle_is_explicitly_development_only(self):
        result, receipt = self.run_supervisor(deployed_profile="exploration", evidence_mode="exploration")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(receipt["schema"], "actor-exploration-capacity/v1")
        self.assertEqual(receipt["evidenceScope"], "development-exploration")
        self.assertIs(receipt["claimEligible"], False)
        self.assertEqual(receipt["expected"]["active"], 320)
        self.assertIn("activeTargetSustained", receipt["checks"])
        self.assertNotIn("tenThousandActiveSustained", receipt["checks"])
        self.assertIn("exploration_capacity_development=passed", result.stdout)
        self.assertNotIn("ten_thousand_active_qualification=passed", result.stdout)

    def test_exploration_rejects_production_profile_before_load(self):
        result, receipt = self.run_supervisor(evidence_mode="exploration")
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIsNone(receipt)

    def test_exploration_control_block_precedes_api_and_output_creation(self):
        result, receipt = self.run_supervisor(evidence_mode="exploration", control_status=2)
        self.assertEqual(result.returncode, 2, result.stderr)
        self.assertIsNone(receipt)

    def test_profile_drift_cannot_hide_behind_passing_load_and_capacity(self):
        for mode in ("production", "exploration"):
            with self.subTest(mode=mode):
                result, receipt = self.run_supervisor(deployed_profile=mode, evidence_mode=mode, drift_after_load=True)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(receipt["verdict"], "failed")
                self.assertFalse(receipt["checks"]["hostDrainProfilePassed"])
                self.assertEqual(receipt["executionExitStatuses"]["drainProfile"], 1)

    def test_exploration_failures_still_cleanup_and_never_pass(self):
        for failure in ({"load_status": 42}, {"cleanup_status": 1}, {"final_timeout": True}):
            with self.subTest(failure=failure):
                result, receipt = self.run_supervisor(deployed_profile="exploration", evidence_mode="exploration", **failure)
                self.assertEqual(result.returncode, 1, result.stderr)
                self.assertEqual(receipt["verdict"], "failed")
                self.assertNotIn("exploration_capacity_development=passed", result.stdout)

    def test_exploration_cannot_bypass_the_real_shared_operation_lock(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            base = Path(temporary)
            lock = base / "operation.lock"
            with lock.open("w") as stream:
                fcntl.flock(stream, fcntl.LOCK_EX | fcntl.LOCK_NB)
                environment = {"PATH": os.environ["PATH"], "AUTONOMY_CONTROL_LOCK_PATH": str(lock)}
                result = subprocess.run(
                    ["bash", str(ROOT.parent / "exploration-capacity/run-on-builder.sh"), RUN_ID],
                    env=environment, capture_output=True, text=True, timeout=5,
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("another risky Cell operation", result.stderr)
                self.assertEqual(set(base.iterdir()), {lock})

    def test_private_cycle_rejects_exploration_without_a_held_operation(self):
        result = subprocess.run(
            ["bash", str(ROOT.parent / "capacity-cycle/run-on-builder.sh"), "exploration", RUN_ID],
            env={"PATH": os.environ["PATH"]}, capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 75)
        self.assertIn("whole-operation lock", result.stderr)

    def test_production_entry_cannot_be_switched_with_extra_arguments(self):
        result = subprocess.run(
            ["bash", str(ROOT / "run-on-builder.sh"), RUN_ID, "exploration"],
            env={"PATH": os.environ["PATH"]}, capture_output=True, text=True, timeout=5,
        )
        self.assertEqual(result.returncode, 2)


if __name__ == "__main__":
    unittest.main()
