import copy
import importlib.util
import pathlib
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("verify-runtime-machine-repair-receipt.py")
SPEC = importlib.util.spec_from_file_location("verify_runtime_machine_repair_receipt", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def valid_receipt():
	return {
		"schema": "rivet-runtime-machine-repair-qualification/v2",
		"verdict": "passed",
		"started_at": "2026-09-04T12:00:00Z",
		"finished_at": "2026-09-04T12:10:00Z",
		"cell": "actor-bj-q01",
		"machine_set": "np-runtime0",
		"machine_set_uid": "machineset-q01",
		"cluster_uid": "cluster-q01",
		"delete_policy": "Newest",
		"baseline_replicas": 3,
		"baseline_machine_uids": ["machine-a", "machine-b", "machine-c"],
		"target": {"name": "np-runtime0-surge", "uid": "machine-surge", "node": "node-surge"},
		"final_machine_uids": ["machine-a", "machine-b", "machine-c"],
		"exact_baseline_restored": True,
	}


class VerifyRuntimeMachineRepairReceiptTests(unittest.TestCase):
	def test_accepts_exact_restoration(self):
		MODULE.verify(valid_receipt(), "actor-bj-q01", "np-runtime0")

	def test_rejects_replacement_of_a_baseline_machine(self):
		payload = copy.deepcopy(valid_receipt())
		payload["final_machine_uids"][-1] = "unexpected-replacement"
		with self.assertRaisesRegex(ValueError, "exact baseline"):
			MODULE.verify(payload, "actor-bj-q01", "np-runtime0")

	def test_rejects_target_from_baseline(self):
		payload = copy.deepcopy(valid_receipt())
		payload["target"]["uid"] = "machine-a"
		with self.assertRaisesRegex(ValueError, "isolated surge"):
			MODULE.verify(payload, "actor-bj-q01", "np-runtime0")

	def test_rejects_receipt_from_recreated_cluster(self):
		with self.assertRaisesRegex(ValueError, "cluster UID mismatch"):
			MODULE.verify(valid_receipt(), "actor-bj-q01", "np-runtime0", "replacement-cluster", "machineset-q01")

	def test_rejects_receipt_from_recreated_machineset(self):
		with self.assertRaisesRegex(ValueError, "MachineSet UID mismatch"):
			MODULE.verify(valid_receipt(), "actor-bj-q01", "np-runtime0", "cluster-q01", "replacement-machineset")

	def test_rejects_receipt_from_another_cell(self):
		with self.assertRaisesRegex(ValueError, "expected runtime MachineSet"):
			MODULE.verify(valid_receipt(), "actor-bj-a01", "np-runtime0")


if __name__ == "__main__":
	unittest.main()
