import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SCRIPT = ROOT / "render-desired-state.py"


def load_module():
    spec = importlib.util.spec_from_file_location("code_plane_render", SCRIPT)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class CodePlaneRenderTest(unittest.TestCase):
    def inventory(self):
        return {
            "schemaVersion": 1,
            "managementId": "actor-bj-c01",
            "region": "ap-beijing",
            "availabilityMode": "production-multi-zone",
            "network": {
                "regionalVpcAggregate": "10.160.0.0/12",
                "vpcCidr": "10.160.0.0/16",
                "workerRegistrySecurityGroup": "sg-test0001",
                "subnets": {
                    "z1": {"id": "subnet-test0001", "zone": "ap-beijing-6", "cidr": "10.160.0.0/20"},
                    "z2": {"id": "subnet-test0002", "zone": "ap-beijing-7", "cidr": "10.160.16.0/20"},
                    "z3": {"id": "subnet-test0003", "zone": "ap-beijing-8", "cidr": "10.160.32.0/20"},
                },
            },
            "kubernetes": {"clusterId": "cls-test0001", "clusterName": "actor-bj-c01"},
            "storage": {
                "codePlaneBackupBucket": "actor-fdb-backup-prod-bj-c01-nv1-1234567890",
                "workerCodeBucket": "actor-worker-code-prod-bj-c01-nv1-1234567890",
            },
        }

    def images(self):
        return {
            "schemaVersion": 1,
            "inventoryDigest": "sha256:" + "a" * 64,
            "images": [
                {"repository": "fdb-kubernetes-monitor", "ref": "registry.example/fdb-kubernetes-monitor@sha256:" + "b" * 64},
                {"repository": "worker-registry", "ref": "registry.example/worker-registry@sha256:" + "c" * 64},
            ],
        }

    def test_renders_inventory_bound_secret_free_state(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = Path(temporary)
            inventory, images = root / "inventory.json", root / "images.json"
            output, receipt = root / "output", root / "receipt.json"
            inventory.write_text(json.dumps(self.inventory()))
            images.write_text(json.dumps(self.images()))
            output.mkdir()
            subprocess.run([
                sys.executable, str(SCRIPT), "--inventory", str(inventory), "--images", str(images),
                "--output-dir", str(output), "--receipt", str(receipt),
            ], check=True, stdout=subprocess.PIPE, text=True)

            rendered = json.loads(receipt.read_text())
            self.assertEqual(rendered["verdict"], "passed")
            self.assertEqual(rendered["network"]["sourceCidrs"], ["10.160.0.0/12"])
            self.assertEqual(set(rendered["files"]), {
                "fdb-cluster.yaml", "fdb-backup.yaml", "worker-registry.yaml", "worker-registry-private.yaml",
            })
            all_text = "".join(path.read_text() for path in output.iterdir())
            self.assertNotIn("SecretKey", all_text)
            self.assertNotIn("AKID", all_text)
            self.assertNotIn("__WORKER_REGISTRY_IMAGE_DIGEST__", all_text)

            fdb = list(yaml.safe_load_all((output / "fdb-cluster.yaml").read_text()))[0]
            self.assertEqual(fdb["metadata"]["name"], "actor-bj-c01")
            self.assertEqual(fdb["spec"]["processes"]["general"]["podTemplate"]["spec"]["nodeSelector"], {"fleet.actor.dev/control-pool": "true"})
            backup = list(yaml.safe_load_all((output / "fdb-backup.yaml").read_text()))[0]
            self.assertEqual(backup["spec"]["blobStoreConfiguration"]["bucket"], "actor-fdb-backup-prod-bj-c01-nv1-1234567890")
            endpoint = list(yaml.safe_load_all((output / "worker-registry-private.yaml").read_text()))[0]
            self.assertEqual(endpoint["metadata"]["annotations"]["service.cloud.tencent.com/security-groups"], "sg-test0001")
            self.assertEqual(endpoint["spec"]["loadBalancerSourceRanges"], ["10.160.0.0/12"])

    def test_rejects_cell_inventory(self):
        module = load_module()
        inventory = self.inventory()
        inventory["managementId"] = "actor-bj-a01"
        with self.assertRaisesRegex(ValueError, "regional C plane"):
            module.validate(inventory, self.images())

    def test_rejects_mutable_image(self):
        module = load_module()
        images = self.images()
        images["images"][1]["ref"] = "registry.example/worker-registry:latest"
        with self.assertRaisesRegex(ValueError, "digest pinned"):
            module.validate(self.inventory(), images)

    def test_rejects_public_registry_source_range(self):
        module = load_module()
        inventory = self.inventory()
        inventory["network"]["regionalVpcAggregate"] = "8.0.0.0/12"
        with self.assertRaisesRegex(ValueError, "private"):
            module.validate(inventory, self.images())

    def test_accepts_single_zone_qualification_inventory(self):
        module = load_module()
        inventory = self.inventory()
        inventory["availabilityMode"] = "qualification-single-zone"
        for subnet in inventory["network"]["subnets"].values():
            subnet["zone"] = "ap-chengdu-1"
        plan = module.validate(inventory, self.images())
        self.assertEqual(plan["availabilityMode"], "qualification-single-zone")

    def test_production_still_requires_three_zones(self):
        module = load_module()
        inventory = self.inventory()
        for subnet in inventory["network"]["subnets"].values():
            subnet["zone"] = "ap-beijing-6"
        with self.assertRaisesRegex(ValueError, "production management subnets"):
            module.validate(inventory, self.images())

    def test_qualification_rejects_mixed_zone_inventory(self):
        module = load_module()
        inventory = self.inventory()
        inventory["availabilityMode"] = "qualification-single-zone"
        with self.assertRaisesRegex(ValueError, "qualification management subnets"):
            module.validate(inventory, self.images())


if __name__ == "__main__":
    unittest.main()
