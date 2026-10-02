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
        {"name": f"{name}-{index}", "uid": f"{name}-node-{index}", "ready": True, "admitted": True,
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
        "hostConfig": {"uid": f"{name}-hosts", "replicas": hosts, "ready": hosts, "currentRevision": "r1",
                       "updateRevision": "r1", "drainState": json.dumps({"phase": phase}),
                       "releaseHold": None},
        "machineSet": {"uid": f"{name}-machines", "desired": machines, "current": machines, "ready": machines,
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
                     cleanup_pending=0, mutate=None):
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
            if mutate is not None:
                mutate(values)
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

    def test_rejects_same_name_replaced_capacity_resources(self):
        for component in ("foundationDB", "hostConfig", "machineSet"):
            with self.subTest(component=component):
                def replace(values):
                    values[2]["cells"][0][component]["uid"] = "replacement-uid"
                status, receipt = self.run_verifier(mutate=replace)
                self.assertNotEqual(status, 0)
                self.assertFalse(receipt["checks"]["capacityIdentityStable"])

    def test_rejects_missing_resource_identity_and_runtime_revision_change(self):
        def missing(values):
            values[0]["cells"][0]["hostConfig"].pop("uid")
        status, receipt = self.run_verifier(mutate=missing)
        self.assertNotEqual(status, 0)
        self.assertFalse(receipt["checks"]["capacityIdentityStable"])
        def rollout(values):
            values[2]["cells"][0]["hostConfig"]["currentRevision"] = "r2"
            values[2]["cells"][0]["hostConfig"]["updateRevision"] = "r2"
        status, receipt = self.run_verifier(mutate=rollout)
        self.assertNotEqual(status, 0)
        self.assertFalse(receipt["checks"]["capacityIdentityStable"])

    def test_ready_machines_without_admitted_nodes_are_not_active_capacity(self):
        for kind in ("not_admitted", "pending", "duplicate"):
            with self.subTest(kind=kind):
                def mutate(values):
                    for value in values[1:4]:
                        for item in value["cells"]:
                            for node in item["nodes"]:
                                if kind == "not_admitted":
                                    node["admitted"] = False
                                elif kind == "pending":
                                    node["taints"].append({"key": "fleet.actor.dev/runtime-admission"})
                                else:
                                    node["uid"] = "same-node-uid"
                status, receipt = self.run_verifier(mutate=mutate)
                self.assertNotEqual(status, 0)
                self.assertFalse(receipt["checks"]["activeCapacityReady"])

    def test_rejects_duplicate_cells_and_replayed_capacity_samples(self):
        for kind in ("duplicate_cell", "duplicate_time", "reordered_time"):
            with self.subTest(kind=kind):
                def mutate(values):
                    if kind == "duplicate_cell":
                        values[2]["cells"].append(values[2]["cells"][0])
                    elif kind == "duplicate_time":
                        values[2]["observedAt"] = values[1]["observedAt"]
                    else:
                        values[2]["observedAt"] = values[0]["observedAt"]
                status, receipt = self.run_verifier(mutate=mutate)
                self.assertNotEqual(status, 0)
                self.assertFalse(receipt["checks"]["capacityTraceValid"])

    def test_rejects_nonfinite_and_negative_active_measurements(self):
        for bad in ("NaN", "Infinity", "-1"):
            with self.subTest(value=bad):
                def mutate(values):
                    for value in values[1:4]:
                        for item in value["cells"]:
                            item["activeActors"] = [bad]
                status, receipt = self.run_verifier(mutate=mutate)
                self.assertNotEqual(status, 0)
                self.assertFalse(receipt["checks"]["tenThousandActiveSustained"])

    def test_capacity_is_not_borrowed_from_the_other_cell(self):
        def mutate(values):
            for value in values[1:4]:
                value["cells"][0]["activeActors"] = ["9900"]
                value["cells"][1]["activeActors"] = ["100"]
        status, receipt = self.run_verifier(mutate=mutate)
        self.assertNotEqual(status, 0)
        self.assertFalse(receipt["checks"]["activeCapacityReady"])

    def test_spare_pending_nodes_and_replaced_node_uids_are_valid_scale_out(self):
        def mutate(values):
            for value in values[1:4]:
                for item in value["cells"]:
                    for node in item["nodes"]:
                        node["uid"] += "-new"
                    item["nodes"].append({
                        "name": "pending-spare", "uid": "pending-spare-uid",
                        "ready": True, "admitted": False,
                        "taints": [{"key": "fleet.actor.dev/runtime-admission"}],
                    })
        status, receipt = self.run_verifier(mutate=mutate)
        self.assertEqual(status, 0)
        self.assertTrue(receipt["checks"]["activeCapacityReady"])

    def test_duplicate_node_identities_cannot_prove_the_final_floor(self):
        def mutate(values):
            for item in values[-1]["cells"]:
                for node in item["nodes"]:
                    node["uid"] = "same-node-uid"
        status, receipt = self.run_verifier(mutate=mutate)
        self.assertNotEqual(status, 0)
        self.assertFalse(receipt["checks"]["finalLowCapacity"])


if __name__ == "__main__":
    unittest.main()
