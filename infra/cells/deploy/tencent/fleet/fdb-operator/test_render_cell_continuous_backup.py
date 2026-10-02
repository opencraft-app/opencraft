#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
CREATE_FIRST = ROOT.parent / "terraform" / "create-first"


def load(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


BACKUP = load("cell_continuous_backup", ROOT / "render-cell-continuous-backup.py")
FIXTURE = load("cell_continuous_backup_fixture", CREATE_FIRST / "test-render-cell-assets.py")
RENDERER = load("cell_continuous_backup_inventory", CREATE_FIRST / "render-cell-assets.py")


def convergence(inventory, images):
    return {
        "schema": "actor-cell-argo-convergence/v1",
        "verdict": "passed",
        "cell": {"id": inventory["cellId"], "uid": "cell-uid", "profileDigest": inventory["fleet"]["profileDigest"]},
        "fleetBinding": inventory["fleet"],
        "terraformInventoryDigest": RENDERER.digest(inventory),
        "imageInventoryDigest": images["inventoryDigest"],
        "platformClusterUid": "cluster-uid",
    }


class RenderCellContinuousBackupTests(unittest.TestCase):
    def test_render_binds_cell_bucket_private_image_and_control_nodes(self):
        inventory, images = FIXTURE.inventory(), FIXTURE.image_inventory()
        manifest, receipt = BACKUP.render(inventory, images, convergence(inventory, images))
        resource = yaml.safe_load(manifest)
        self.assertEqual(resource["metadata"]["name"], "actor-bj-k02-continuous")
        self.assertEqual(resource["spec"]["clusterName"], "actor-bj-k02")
        self.assertEqual(resource["spec"]["agentCount"], 3)
        self.assertEqual(resource["spec"]["blobStoreConfiguration"]["bucket"], "backup-bucket")
        self.assertEqual(resource["spec"]["podTemplateSpec"]["spec"]["nodeSelector"], {"fleet.actor.dev/control-pool": "true"})
        self.assertEqual(resource["spec"]["podTemplateSpec"]["spec"]["volumes"][0]["secret"]["secretName"], "actor-bj-k02-backup-credentials")
        self.assertIn("example.tencentcloudcr.com/actor-fleet/fdb-kubernetes-monitor", manifest.decode())
        self.assertEqual(receipt["cellUid"], "cell-uid")
        self.assertEqual(receipt["backup"]["agentCount"], 3)
        self.assertNotIn("AKID", manifest.decode())

    def test_single_zone_qualification_uses_one_backup_agent(self):
        inventory, images = FIXTURE.inventory("actor-cd-q01"), FIXTURE.image_inventory()
        inventory["environment"] = "qual"
        inventory["region"] = "ap-chengdu"
        inventory["availabilityMode"] = "qualification-single-zone"
        for subnet in inventory["network"]["subnets"].values():
            subnet["zone"] = "ap-chengdu-1"
        manifest, receipt = BACKUP.render(inventory, images, convergence(inventory, images))
        resource = yaml.safe_load(manifest)
        self.assertEqual(resource["spec"]["agentCount"], 1)
        self.assertEqual(receipt["backup"]["agentCount"], 1)

    def test_rejects_another_convergence_inventory(self):
        inventory, images = FIXTURE.inventory(), FIXTURE.image_inventory()
        evidence = convergence(inventory, images)
        evidence["terraformInventoryDigest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "inventory digest differs"):
            BACKUP.render(inventory, images, evidence)


if __name__ == "__main__":
    unittest.main()
