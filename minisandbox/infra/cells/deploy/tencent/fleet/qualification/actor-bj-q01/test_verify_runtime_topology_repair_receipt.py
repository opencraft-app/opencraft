import hashlib
import json
import unittest

from importlib.machinery import SourceFileLoader
from pathlib import Path


module = SourceFileLoader(
    "verify_runtime_topology_repair_receipt",
    str(Path(__file__).with_name("verify-runtime-topology-repair-receipt.py")),
).load_module()


def fixture():
    payload = {
        "schema": "rivet-runtime-topology-repair/v1",
        "verdict": "passed",
        "cell": "actor-bj-q01",
        "machine_set": "np-runtime0",
        "cluster_uid": "cluster-1",
        "machine_set_uid": "set-1",
        "policy": {"required_zones": 3, "max_repair_surge": 1, "create_policy": "ZoneEquality", "delete_policy": "Newest"},
        "baseline_zones": ["zone-a", "zone-b", "zone-b"],
        "final_zones": ["zone-a", "zone-b", "zone-c"],
        "target": {"name": "machine-old", "uid": "machine-old-uid", "node": "node-old", "node_uid": "node-old-uid", "zone": "zone-b"},
        "replacement": {"name": "machine-new", "uid": "machine-new-uid", "node": "node-new", "node_uid": "node-new-uid", "zone": "zone-c"},
        "exact_target_removed": True,
        "ready_admitted_capacity_restored": True,
    }
    canonical = json.dumps(payload, separators=(",", ":"), sort_keys=True).encode()
    payload["evidence_sha256"] = hashlib.sha256(canonical).hexdigest()
    return payload


class VerifyTopologyRepairReceiptTest(unittest.TestCase):
    def test_accepts_exact_repair(self):
        module.verify(fixture(), "cluster-1", "set-1")

    def test_rejects_same_zone_replacement(self):
        payload = fixture()
        payload["replacement"]["zone"] = "zone-b"
        with self.assertRaisesRegex(ValueError, "zones"):
            module.verify(payload)

    def test_rejects_mutated_evidence(self):
        payload = fixture()
        payload["replacement"]["name"] = "substituted"
        with self.assertRaisesRegex(ValueError, "digest"):
            module.verify(payload)


if __name__ == "__main__":
    unittest.main()
