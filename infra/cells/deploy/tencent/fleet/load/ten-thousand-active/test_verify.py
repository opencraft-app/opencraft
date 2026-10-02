import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).parent
RUNNER = ROOT / "run-on-builder.sh"


def cell(name, active, hosts, machines, phase="Idle", legacy=0):
    nodes = [
        {"name": f"{name}-{index}", "ready": True, "admitted": True,
         "taints": [{"key": "rivet.dev/compute", "value": "true", "effect": "NoSchedule"}]}
        for index in range(machines)
    ]
    return {
        "cell": name, "errors": [], "activeActors": [str(active)], "nodes": nodes,
        "foundationDB": {
            "uid": f"{name}-fdb", "generation": 2, "reconciledGeneration": 2,
            "configured": True,
            "health": {"available": True, "fullReplication": True, "healthy": True},
        },
        "foundationDBPods": {"total": 9, "ready": 9, "restarts": 0},
        "hostConfig": {"replicas": hosts, "ready": hosts, "currentRevision": "r1",
                       "updateRevision": "r1", "drainState": json.dumps({"phase": phase}),
                       "releaseHold": None},
        "machineSet": {"desired": machines, "current": machines, "ready": machines,
                       "downscaleIntent": None},
        "legacyMachineSet": {"desired": legacy, "current": legacy, "ready": legacy},
    }


def sample(index, active, hosts, machines, phase="Idle"):
    return {
        "observedAt": f"2026-09-20T00:{index:02d}:00+00:00",
        "cells": [cell("actor-bj-a01", active / 2, hosts, machines, phase),
                  cell("actor-bj-b01", active / 2, hosts, machines, phase)],
    }


class VerifyTest(unittest.TestCase):
    def test_low_capacity_probe_derives_kubeconfig_from_local_cell(self):
        script = RUNNER.read_text()
        self.assertIn(
            "local cell=$1\n\tlocal config=$base/cells/$cell/cell.kubeconfig",
            script,
        )
        self.assertNotIn("local cell=$1 config=", script)

    def test_retired_pool_may_be_absent_but_other_api_failures_fail_closed(self):
        script = RUNNER.read_text()
        self.assertIn(
            'get machineset np-runtime1 -o json 2>"$out/np-runtime1-$cell.err"',
            script,
        )
        self.assertIn("grep -q 'NotFound'", script)
        self.assertIn("else\n\t\treturn 1\n\tfi", script)

    def run_verifier(self, remove_final=False, warmup_timeouts=0, degrade_fdb=False,
                     cleanup_pending=0):
        root = os.environ.get("TMPDIR", "/data/tmp")
        with tempfile.TemporaryDirectory(dir=root) as temporary:
            temporary = Path(temporary)
            trace = temporary / "capacity.ndjson"
            values = [sample(0, 0, 4, 4), sample(1, 10000, 300, 300),
                      sample(2, 10000, 300, 300), sample(3, 10000, 300, 300),
                      sample(4, 0, 299, 300, "Observing")]
            if not remove_final:
                values.append(sample(5, 0, 4, 4))
            if degrade_fdb:
                values[2]["cells"][0]["foundationDB"]["health"]["fullReplication"] = False
                values[-1]["cells"][0]["foundationDBPods"]["ready"] = 8
            trace.write_text("".join(json.dumps(value) + "\n" for value in values))
            load = temporary / "load.json"
            load.write_text(json.dumps({
                "schema": "actor-shared-agent-scale/v1", "runId": "a" * 32,
                "verdict": "passed", "target": 11000, "activeTarget": 10000,
                "activeReady": 10000, "activeProven": 10000,
                "counters": {"scheduled": 11000, "objectsCreated": 11000, "objectsFailed": 0,
                             "readySloBreaches": 0, "requestRetries": 0,
                             "warmupBackpressureTimeouts": warmup_timeouts,
                             "activeFailed": 0, "activeIdentityMismatches": 0},
                "warmupBackpressure": {"timeouts": warmup_timeouts},
            }))
            cleanup = temporary / "cleanup.json"
            cleanup.write_text(json.dumps({
                "schema": "actor-shared-agent-cleanup/v1", "verdict": "passed",
                "runs": [{"runId": "a" * 32, "scheduled": 11000}],
                "objects": {"total": 11000, "deleted": 11000 - cleanup_pending,
                            "pending": cleanup_pending},
            }))
            output = temporary / "receipt.json"
            result = subprocess.run([
                "python3", str(ROOT / "verify.py"), "--trace", str(trace),
                "--load-receipt", str(load), "--cleanup-receipt", str(cleanup),
                "--output", str(output),
            ], capture_output=True, text=True)
            return result.returncode, json.loads(output.read_text())

    def test_passes_complete_cycle(self):
        status, receipt = self.run_verifier()
        self.assertEqual(status, 0)
        self.assertEqual(receipt["verdict"], "passed")
        self.assertTrue(all(receipt["checks"].values()))

    def test_rejects_missing_final_floor(self):
        status, receipt = self.run_verifier(remove_final=True)
        self.assertNotEqual(status, 0)
        self.assertEqual(receipt["verdict"], "failed")
        self.assertFalse(receipt["checks"]["finalLowCapacity"])

    def test_rejects_warmup_backpressure_timeout(self):
        status, receipt = self.run_verifier(warmup_timeouts=1)
        self.assertNotEqual(status, 0)
        self.assertEqual(receipt["verdict"], "failed")
        self.assertFalse(receipt["checks"]["loadReceiptPassed"])

    def test_rejects_fdb_redundancy_loss_and_unhealthy_final_floor(self):
        status, receipt = self.run_verifier(degrade_fdb=True)
        self.assertNotEqual(status, 0)
        self.assertEqual(receipt["verdict"], "failed")
        self.assertFalse(receipt["checks"]["finalLowCapacity"])

    def test_rejects_incomplete_exact_cleanup(self):
        status, receipt = self.run_verifier(cleanup_pending=1)
        self.assertNotEqual(status, 0)
        self.assertEqual(receipt["verdict"], "failed")
        self.assertFalse(receipt["checks"]["exactObjectCleanupPassed"])


if __name__ == "__main__":
    unittest.main()
