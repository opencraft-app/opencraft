import hashlib
import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


MODULE = Path(__file__).with_name("plan-qualification-activation.py")
SPEC = importlib.util.spec_from_file_location("qualification_activation", MODULE)
assert SPEC and SPEC.loader
activation = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(activation)


DIGEST = "sha256:" + "a" * 64
IMAGE = "registry.invalid/runtime@" + DIGEST
MANIFEST = "b" * 64


def workload(kind, replicas, primary):
    return {
        "metadata": {"generation": 3},
        "spec": {"replicas": replicas, "template": {"metadata": {"annotations": {
            "fleet.actor.dev/manifest-sha256": MANIFEST,
        }}, "spec": {"containers": [{"name": primary, "image": IMAGE}]}}},
        "status": {"observedGeneration": 3, "readyReplicas": replicas},
    }


def pod(component, index, primary):
    return {
        "metadata": {"uid": "{}-{}".format(component, index), "labels": {
            "fleet.actor.dev/component": component,
        }},
        "spec": {"containers": [{"name": primary, "image": IMAGE}]},
        "status": {"containerStatuses": [{"name": primary, "ready": True, "imageID": IMAGE}]},
    }


class QualificationActivationTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.root = Path(self.temporary.name)
        self.binding = {
            "runtime_image": IMAGE, "runtime_digest": DIGEST, "manifest_sha256": MANIFEST,
        }
        self.audit = self.root / "audit.json"
        audit = {
            "schemaVersion": "actor-fdb-autonomy-audit-v1", "verdict": "passed",
            "cell": "actor-bj-q01", "namespace": "actor-fdb-cell-system",
            "warnings": [], "failures": [], "sourceIdentity": {"revision": "c" * 40},
            "evidence": {"current_release_binding": self.binding},
        }
        self.audit.write_text(json.dumps(audit, sort_keys=True))
        audit_sha = hashlib.sha256(self.audit.read_bytes()).hexdigest()
        self.control = self.root / "control.json"
        control = {
            "schemaVersion": "actor-fdb-autonomy-control-v1", "control": "allow",
            "verdict": "passed", "cell": audit["cell"], "namespace": audit["namespace"],
            "warnings": [], "failures": [], "sourceIdentity": audit["sourceIdentity"],
            "source_receipt": str(self.audit), "source_receipt_sha256": audit_sha,
        }
        self.control.write_text(json.dumps(control, sort_keys=True))
        self.deployment = workload("Deployment", 6, "engine")
        self.statefulset = workload("StatefulSet", 4, "workerd-host")
        self.pods = {"items": [pod("engine", i, "engine") for i in range(6)] + [
            pod("workerd-host", i, "workerd-host") for i in range(4)
        ]}

    def tearDown(self):
        self.temporary.cleanup()

    def test_exact_allow_builds_release_bound_plan(self):
        result = activation.plan(self.control, self.deployment, self.statefulset, self.pods)
        self.assertEqual(DIGEST, result["qualification"]["release_digest"])
        self.assertTrue(result["qualification"]["receipt_ref"].endswith(
            "sha256=" + result["control_receipt_sha256"]
        ))

    def test_mutated_source_is_rejected(self):
        self.audit.write_text("{}")
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            activation.plan(self.control, self.deployment, self.statefulset, self.pods)

    def test_release_change_is_rejected(self):
        for workload_document in (self.deployment, self.statefulset):
            workload_document["spec"]["template"]["metadata"]["annotations"][
                "fleet.actor.dev/manifest-sha256"
            ] = "d" * 64
        with self.assertRaisesRegex(ValueError, "no longer matches"):
            activation.plan(self.control, self.deployment, self.statefulset, self.pods)


if __name__ == "__main__":
    unittest.main()
