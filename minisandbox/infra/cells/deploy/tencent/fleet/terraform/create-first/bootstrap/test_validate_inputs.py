#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


VALIDATE = load("create_first_bootstrap_validate", ROOT / "validate-inputs.py")
RENDER_TEST = load("create_first_bootstrap_fixture", ROOT.parent / "test-render-cell-assets.py")


def management():
    return {
        "schemaVersion": 1,
        "managementId": "actor-bj-c01",
        "region": "ap-beijing",
        "availabilityMode": "production-multi-zone",
        "network": {"vpcId": "vpc-management1", "access": "unused"},
        "kubernetes": {"clusterId": "cls-management1"},
        "registry": {
            "id": "tcr-test0001",
            "host": "example.tencentcloudcr.com",
            "namespace": "actor-fleet",
            "accessIp": "10.160.0.11",
        },
        "storage": {
            "codePlaneBackupBucket": "actor-fdb-backup-prod-bj-c01-nv1-1234567890",
            "qualificationEvidenceBucket": "actor-qualification-evidence-prod-bj-c01-nv1-1234567890",
            "workerCodeBucket": "actor-worker-code-prod-bj-c01-nv1-1234567890",
        },
    }


class ValidateBootstrapInputsTests(unittest.TestCase):
    def test_accepts_cell_and_selects_only_cell_namespaces(self):
        result = VALIDATE.validate(RENDER_TEST.inventory(), RENDER_TEST.image_inventory(), "cell")
        self.assertEqual(result["identity"], "actor-bj-k02")
        self.assertEqual(
            result["namespaces"],
            [
                "actor-fdb-cell-system",
                "actor-runtime-admission-system",
                "actor-stateless-system",
                "fdb-operator-actor-fleet-controller-system",
                "observability",
            ],
        )

    def test_accepts_management_and_selects_c_namespaces(self):
        result = VALIDATE.validate(management(), RENDER_TEST.image_inventory(), "management")
        self.assertEqual(result["identity"], "actor-bj-c01")
        self.assertIn("argocd", result["namespaces"])
        self.assertIn("workers-api-system", result["namespaces"])
        self.assertNotIn("actor-fdb-cell-system", result["namespaces"])

    def test_rejects_registry_mismatch(self):
        candidate = management()
        candidate["registry"]["host"] = "different.tencentcloudcr.com"
        with self.assertRaisesRegex(ValueError, "differ"):
            VALIDATE.validate(candidate, RENDER_TEST.image_inventory(), "management")

    def test_rejects_secret_shaped_terraform_output(self):
        candidate = management()
        candidate["kubernetes"]["kubeconfig"] = "secret"
        with self.assertRaisesRegex(ValueError, "forbidden"):
            VALIDATE.validate(candidate, RENDER_TEST.image_inventory(), "management")

    def test_rejects_invalid_management_storage_inventory(self):
        candidate = management()
        candidate["storage"]["qualificationEvidenceBucket"] = "INVALID"
        with self.assertRaisesRegex(ValueError, "COS bucket"):
            VALIDATE.validate(candidate, RENDER_TEST.image_inventory(), "management")

    def test_rejects_using_cell_inventory_as_management(self):
        with self.assertRaisesRegex(ValueError, "schema mismatch"):
            VALIDATE.validate(RENDER_TEST.inventory(), RENDER_TEST.image_inventory(), "management")


if __name__ == "__main__":
    unittest.main()
