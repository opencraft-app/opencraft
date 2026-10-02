import copy
import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("verify-runtime-automatic-repair-receipt.py")
SPEC = importlib.util.spec_from_file_location("verify_runtime_automatic_repair_receipt", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def valid_receipt():
	return {
		"schema": "rivet-runtime-automatic-repair-qualification/v2",
		"verdict": "passed",
		"started_at": "2026-09-04T12:00:00Z",
		"finished_at": "2026-09-04T12:10:00Z",
		"cell": "actor-bj-q01",
		"machine_set": "np-runtime0",
		"cluster_uid": "cluster-q01",
		"machine_set_uid": "machineset-q01",
		"delete_policy": "Newest",
		"baseline_replicas": 3,
		"provider_receipt_sha256": "a" * 64,
		"fault_injected": True,
		"target": {"name": "machine-old", "uid": "uid-old", "node": "node-old", "node_uid": "node-uid-old", "zone": "zone-a"},
		"replacement": {"name": "machine-new", "uid": "uid-new", "node": "node-new", "node_uid": "node-uid-new", "zone": "zone-a"},
		"topology": {"required_zones": 3, "baseline_zones": ["zone-a", "zone-b", "zone-c"], "final_zones": ["zone-a", "zone-b", "zone-c"]},
		"exact_target_removed": True,
		"ready_capacity_restored": True,
	}


class VerifyRuntimeAutomaticRepairReceiptTests(unittest.TestCase):
	def test_accepts_exact_replacement(self):
		MODULE.verify(valid_receipt(), "actor-bj-q01", "np-runtime0", "cluster-q01", "machineset-q01", "a" * 64)

	def test_rejects_recreated_cluster(self):
		with self.assertRaisesRegex(ValueError, "cluster UID mismatch"):
			MODULE.verify(valid_receipt(), "actor-bj-q01", "np-runtime0", "replacement-cluster", "machineset-q01")

	def test_rejects_provider_receipt_substitution(self):
		with self.assertRaisesRegex(ValueError, "digest mismatch"):
			MODULE.verify(valid_receipt(), "actor-bj-q01", "np-runtime0", provider_receipt_sha256="b" * 64)

	def test_rejects_reused_machine_identity(self):
		payload = copy.deepcopy(valid_receipt())
		payload["replacement"]["uid"] = payload["target"]["uid"]
		with self.assertRaisesRegex(ValueError, "reused"):
			MODULE.verify(payload, "actor-bj-q01", "np-runtime0")

	def test_rejects_missing_ready_capacity_proof(self):
		payload = copy.deepcopy(valid_receipt())
		payload["ready_capacity_restored"] = False
		with self.assertRaisesRegex(ValueError, "not restored"):
			MODULE.verify(payload, "actor-bj-q01", "np-runtime0")

	def test_rejects_skewed_final_topology(self):
		payload = copy.deepcopy(valid_receipt())
		payload["topology"]["final_zones"] = ["zone-a", "zone-b", "zone-b"]
		with self.assertRaisesRegex(ValueError, "exact three-zone"):
			MODULE.verify(payload, "actor-bj-q01", "np-runtime0")

	def test_rejects_receipt_from_another_cell(self):
		with self.assertRaisesRegex(ValueError, "expected runtime MachineSet"):
			MODULE.verify(valid_receipt(), "actor-bj-a01", "np-runtime0")


if __name__ == "__main__":
	unittest.main()
