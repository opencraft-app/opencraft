#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


MODULE = load("validate_management_platform", ROOT / "validate-management-platform-inputs.py")
INPUTS = load("management_platform_base", ROOT / "test_validate_inputs.py")
RENDER = load("management_platform_images", ROOT.parent / "test-render-cell-assets.py")


def pull():
    namespaces = MODULE.load_inputs().NAMESPACES["management"]
    return {
        "schema": "actor-create-first-pull-bootstrap/v1", "verdict": "passed",
        "role": "management", "identity": "actor-bj-c01",
        "cluster": {"id": "cls-management1", "uid": "cluster-uid", "vpcId": "vpc-management1"},
        "imageInventoryDigest": RENDER.image_inventory()["inventoryDigest"],
        "namespaces": [
            {"name": name, "namespaceUid": name + "-uid", "secretUid": name + "-pull-uid"}
            for name in namespaces
        ],
    }


class ManagementPlatformInputTests(unittest.TestCase):
    def test_exact_management_identity_passes(self):
        result = MODULE.validate(INPUTS.management(), RENDER.image_inventory(), pull(), "a" * 64)
        self.assertEqual(result["clusterUid"], "cluster-uid")
        self.assertEqual(result["argocdPullSecretUid"], "argocd-pull-uid")

    def test_cell_scoped_pull_receipt_is_rejected(self):
        value = pull()
        value["role"] = "cell"
        with self.assertRaisesRegex(ValueError, "differs"):
            MODULE.validate(INPUTS.management(), RENDER.image_inventory(), value, "a" * 64)

    def test_incomplete_namespace_inventory_is_rejected(self):
        value = pull()
        value["namespaces"].pop()
        with self.assertRaisesRegex(ValueError, "namespace inventory"):
            MODULE.validate(INPUTS.management(), RENDER.image_inventory(), value, "a" * 64)


if __name__ == "__main__":
    unittest.main()
