import copy
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("bootstrap_engine_prefix", ROOT / "verify-bootstrap-engine-prefix.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class BootstrapPrefixTest(unittest.TestCase):
    def setUp(self):
        self.cell_name = "actor-bj-a01"
        self.image = "registry/runtime@sha256:" + "a" * 64
        self.cell = {"metadata": {"name": self.cell_name}, "spec": {"desiredState": "Provisioning"}}
        self.workloads = [
            {"kind": kind, "metadata": {"name": f"{self.cell_name}-{component}", "labels": {
                "fleet.actor.dev/cell-name": self.cell_name, "fleet.actor.dev/component": component}},
             "spec": {"replicas": 3, "template": {"spec": {"containers": [{"name": component, "image": self.image}]}}}}
            for component, kind in [("engine", "Deployment"), ("nats", "StatefulSet")]
        ]

    def verify(self):
        MODULE.verify(self.cell_name, self.image, self.image, self.cell, *self.workloads)

    def test_exact_pre_host_boundary_is_resumable(self):
        self.verify()

    def test_ready_or_different_cell_is_not_resumable(self):
        for state in ("Ready", "Draining", "Retired"):
            self.cell["spec"]["desiredState"] = state
            with self.assertRaises(ValueError):
                self.verify()

    def test_workload_replacement_or_unreviewed_image_is_rejected(self):
        original = copy.deepcopy(self.workloads)
        for index in (0, 1):
            for field, value in [("name", "foreign"), ("deletionTimestamp", "now")]:
                self.workloads = copy.deepcopy(original)
                self.workloads[index]["metadata"][field] = value
                with self.assertRaises(ValueError):
                    self.verify()
            self.workloads = copy.deepcopy(original)
            self.workloads[index]["spec"]["template"]["spec"]["containers"][0]["image"] = "registry/runtime:latest"
            with self.assertRaises(ValueError):
                self.verify()

    def test_resume_branch_never_deletes_nats_with_engine_alive(self):
        source = (ROOT / "install.sh").read_text()
        branch = source.split("verify-bootstrap-engine-prefix.py", 1)[1].split("else\n", 1)[0]
        self.assertIn("update_release_fields=false", branch)
        self.assertNotIn("resume_initial_nats=true", branch)
        self.assertNotIn("delete pod", branch)


if __name__ == "__main__":
    unittest.main()
