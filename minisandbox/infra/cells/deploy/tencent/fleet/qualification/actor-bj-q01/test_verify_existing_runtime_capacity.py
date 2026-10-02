#!/usr/bin/env python3
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "verify_existing_runtime_capacity", ROOT / "verify-existing-runtime-capacity.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def deployment():
    return {
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": "actor-bj-q01-runtime-capacity",
            "namespace": "actor-fdb-cell-system",
        },
        "spec": {"template": {"spec": {"containers": [{
            "name": "controller",
            "image": "registry/controller@sha256:" + "1" * 64,
            "env": [
                {"name": "RUNTIME_ADMISSION_BOOTSTRAP_IMAGE", "value": "registry/runtime@sha256:" + "2" * 64},
                {"name": "RUNTIME_EXACT_SCALE_DOWN_ENABLED", "value": "true"},
                {"name": "RUNTIME_TKE_CLUSTER_ID", "value": "cls-example"},
                {"name": "RUNTIME_CAPACITY_TARGETED_REPAIR_ENABLED", "value": "false"},
            ],
        }]}}},
    }


class VerifyExistingRuntimeCapacityTest(unittest.TestCase):
    def test_accepts_and_preserves_complete_provider_policy(self):
        document = deployment()
        before = repr(document)
        MODULE.verify(
            document,
            "registry/controller@sha256:" + "1" * 64,
            "registry/runtime@sha256:" + "2" * 64,
        )
        self.assertEqual(repr(document), before)

    def test_rejects_image_ordering_drift(self):
        with self.assertRaisesRegex(ValueError, "controller image must converge"):
            MODULE.verify(deployment(), "wrong", "registry/runtime@sha256:" + "2" * 64)

    def test_rejects_missing_provider_policy(self):
        document = deployment()
        document["spec"]["template"]["spec"]["containers"][0]["env"] = document["spec"]["template"]["spec"]["containers"][0]["env"][:-1]
        with self.assertRaisesRegex(ValueError, "provider policy is incomplete"):
            MODULE.verify(
                document,
                "registry/controller@sha256:" + "1" * 64,
                "registry/runtime@sha256:" + "2" * 64,
            )


if __name__ == "__main__":
    unittest.main()
