#!/usr/bin/env python3

import importlib.util
import json
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("render_cell_assets", ROOT / "render-cell-assets.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)
IMAGE_SPEC = importlib.util.spec_from_file_location(
    "render_cell_assets_images",
    ROOT.parents[1] / "gitops" / "image-seed" / "image_contract.py",
)
IMAGES = importlib.util.module_from_spec(IMAGE_SPEC)
assert IMAGE_SPEC.loader is not None
IMAGE_SPEC.loader.exec_module(IMAGES)


def inventory(cell_id="actor-bj-k02"):
    return {
        "schemaVersion": 1,
        "cellId": cell_id,
        "environment": "prod",
        "region": "ap-beijing",
        "availabilityMode": "production-multi-zone",
        "fleet": {
            "poolName": "actor-beijing-kubernetes",
            "poolUid": "pool-uid-test",
            "claimName": "actor-bj-k02-claim",
            "claimUid": "claim-uid-test",
            "className": "rivet-fdb-cos-kubernetes-v1",
            "datacenterName": "default",
            "scaleOutEpoch": 1,
            "profileDigest": "sha256:" + "a" * 64,
        },
        "network": {
            "ccnId": "ccn-test0001",
            "ccnAttachmentId": "ccn-test0001#VPC#ap-beijing#vpc-test0001",
            "vpcId": "vpc-test0001",
            "vpcCidr": "10.3.0.0/16",
            "nodeSecurityGroup": "sg-test0001",
            "apiSecurityGroup": "sg-test0002",
            "podCidr": "10.203.0.0/16",
            "serviceCidr": "172.23.0.0/16",
            "subnets": {
                "z3": {"id": "subnet-test0003", "zone": "ap-beijing-7", "cidr": "10.3.3.0/24"},
                "z1": {"id": "subnet-test0001", "zone": "ap-beijing-5", "cidr": "10.3.1.0/24"},
                "z2": {"id": "subnet-test0002", "zone": "ap-beijing-6", "cidr": "10.3.2.0/24"},
            },
        },
        "management": {
            "managementId": "actor-bj-c01",
            "clusterId": "cls-management1",
            "vpcId": "vpc-management1",
            "vpcCidr": "10.160.0.0/16",
        },
        "kubernetes": {
            "clusterId": "cls-test0001",
            "clusterName": cell_id,
            "clusterVersion": "1.30.0",
            "privateEndpoint": "https://10.3.0.10",
            "bootstrapInstanceId": "ins-test0001",
            "operatorKeyId": "skey-test0001",
            "statelessNodePoolId": "np-test0001",
        },
        "registry": {
            "id": "tcr-test0001",
            "host": "example.tencentcloudcr.com",
            "namespace": "actor-fleet",
            "accessIp": "10.3.0.11",
        },
        "storage": {
            "cold": "cold-bucket",
            "backup": "backup-bucket",
            "code": "code-bucket",
            "relay": "relay-bucket",
            "evidence": "evidence-bucket",
        },
        "identity": {
            "runtimeScaleDownRole": "runtime-role",
            "releaseHookRole": "release-role",
            "coldStorageUser": f"{cell_id}-cold-storage",
            "backupStorageUser": f"{cell_id}-backup-storage",
        },
    }


def cell_spec(cell_id="actor-bj-k02"):
    return {
        "schemaVersion": 1,
        "cellId": cell_id,
        "className": "rivet-fdb-cos-kubernetes-v1",
        "poolName": "actor-beijing-kubernetes",
        "profileDigest": "sha256:" + "a" * 64,
        "machinePools": {
            "control": {"instanceTypes": ["C1"], "replicas": 3, "minReplicas": 3, "maxReplicas": 3},
            "fdb": {"instanceTypes": ["F1"], "replicas": 9, "minReplicas": 9, "maxReplicas": 30},
            "runtime": {
                "instanceTypes": ["R1"],
                "replicas": 3,
                "minReplicas": 3,
                "maxReplicas": 301,
                "repairSurge": 1,
            },
            "stateless": {
                "instanceTypes": ["S1"],
                "replicas": 3,
                "minReplicas": 3,
                "maxReplicas": 300,
            },
        },
    }


def image_inventory():
    checksum = "sha256:" + "d" * 64
    items = []
    for repository in sorted(IMAGES.ALL_REPOSITORIES):
        provenance = {"kind": "mirror", "source": f"example.invalid/{repository}@{checksum}"}
        if repository in IMAGES.PRODUCT_REPOSITORIES:
            provenance = {
                "kind": "build", "sourceRevision": "e" * 40,
                "sourceManifestDigest": checksum, "buildReceiptDigest": checksum,
            }
        items.append({
            "repository": repository,
            "ref": f"example.tencentcloudcr.com/actor-fleet/{repository}@{checksum}",
            "provenance": provenance,
        })
    value = {
        "schemaVersion": 1, "registry": "example.tencentcloudcr.com",
        "namespace": "actor-fleet", "platform": "linux/amd64",
        "sourceLockDigest": checksum, "seedReceiptDigest": checksum, "images": items,
    }
    value["inventoryDigest"] = IMAGES.digest(value)
    return value


class RenderCellAssetsTests(unittest.TestCase):
    def test_render_is_deterministic_and_credential_free(self):
        inv = MODULE.validate_inventory(inventory())
        spec = MODULE.validate_spec(cell_spec(), inv)
        first = MODULE.render(inv, spec, image_inventory())
        second = MODULE.render(inv, spec, image_inventory())
        self.assertEqual(first, second)
        joined = b"".join(first.values()).decode()
        self.assertNotIn("kubeconfig", joined.lower())
        patch = json.loads(first["machine-pools/runtime/machineset.yaml"])
        self.assertEqual(patch["spec"]["subnetIDs"], ["subnet-test0001", "subnet-test0002", "subnet-test0003"])
        self.assertEqual(patch["spec"]["scaling"]["maxReplicas"], 301)
        self.assertEqual(patch["spec"]["template"]["spec"]["taints"][1]["value"], "pending")
        self.assertNotIn("machine-pools/stateless/machineset.yaml", first)
        for pool_name in MODULE.ARGO_MACHINE_POOL_NAMES:
            machine_set = json.loads(first[f"machine-pools/{pool_name}/machineset.yaml"])
            self.assertEqual(
                machine_set["spec"]["template"]["spec"]["providerSpec"]["value"]["systemDisk"],
                {"diskSize": 100, "diskType": "CloudSSD"},
            )
        self.assertEqual(json.loads(first["cell.json"])["spec"]["managementCluster"], "cls-test0001")
        self.assertEqual(
            json.loads(first["cell.json"])["metadata"]["annotations"]["fleet.actor.dev/image-inventory-digest"],
            image_inventory()["inventoryDigest"],
        )
        self.assertEqual(
            json.loads(first["cell.json"])["metadata"]["annotations"]["fleet.actor.dev/stateless-node-pool-id"],
            "np-test0001",
        )

    def test_rejects_secret_shaped_inventory(self):
        candidate = inventory()
        candidate["kubernetes"]["kubeconfig"] = "secret"
        with self.assertRaisesRegex(ValueError, "forbidden"):
            MODULE.validate_inventory(candidate)

    def test_rejects_cell_name_as_engine_local_datacenter(self):
        candidate = inventory()
        candidate["fleet"]["datacenterName"] = candidate["cellId"]
        with self.assertRaisesRegex(ValueError, "Engine-local datacenter default"):
            MODULE.validate_inventory(candidate)

    def test_rejects_cell_identity_mismatch(self):
        inv = MODULE.validate_inventory(inventory())
        with self.assertRaisesRegex(ValueError, "cellId differ"):
            MODULE.validate_spec(cell_spec("actor-bj-k03"), inv)

    def test_rejects_runtime_without_repair_surge(self):
        inv = MODULE.validate_inventory(inventory())
        spec = cell_spec()
        spec["machinePools"]["runtime"]["maxReplicas"] = 3
        with self.assertRaisesRegex(ValueError, "repairSurge"):
            MODULE.validate_spec(spec, inv)

    def test_rejects_control_pool_too_small_for_nats(self):
        inv = MODULE.validate_inventory(inventory())
        spec = cell_spec()
        spec["machinePools"]["control"] = {
            "instanceTypes": ["C1"], "replicas": 1, "minReplicas": 1, "maxReplicas": 1,
        }
        with self.assertRaisesRegex(ValueError, "control minReplicas must be at least 3"):
            MODULE.validate_spec(spec, inv)

    def test_control_generation_renders_replacement_machineset_identity(self):
        inv = MODULE.validate_inventory(inventory())
        spec_value = cell_spec()
        spec_value["machinePools"]["control"].update(
            {"machineSetName": "np-control1", "generation": "v2"}
        )
        spec = MODULE.validate_spec(spec_value, inv)
        rendered = json.loads(MODULE.render(inv, spec, image_inventory())[
            "machine-pools/control/machineset.yaml"
        ])
        self.assertEqual(rendered["metadata"]["name"], "np-control1")
        self.assertEqual(rendered["spec"]["displayName"], "actor-bj-k02-control-v2-native")
        self.assertEqual(
            rendered["spec"]["template"]["spec"]["metadata"]["labels"][
                "fleet.actor.dev/control-pool-generation"
            ],
            "v2",
        )

    def test_rejects_tke_machineset_suffix_longer_than_eight_characters(self):
        inv = MODULE.validate_inventory(inventory())
        spec_value = cell_spec()
        spec_value["machinePools"]["control"].update(
            {"machineSetName": "np-stateless", "generation": "invalid"}
        )
        with self.assertRaisesRegex(ValueError, "TKE np- plus eight-character contract"):
            MODULE.validate_spec(spec_value, inv)

    def test_control_generation_identity_is_atomic(self):
        inv = MODULE.validate_inventory(inventory())
        for key, value in (("machineSetName", "np-control1"), ("generation", "v2")):
            spec_value = cell_spec()
            spec_value["machinePools"]["control"][key] = value
            with self.assertRaisesRegex(ValueError, "must be supplied together"):
                MODULE.validate_spec(spec_value, inv)

    def test_accepts_explicit_single_zone_qualification_inventory(self):
        candidate = inventory("actor-cd-q01")
        candidate["environment"] = "qual"
        candidate["region"] = "ap-chengdu"
        candidate["availabilityMode"] = "qualification-single-zone"
        candidate["management"]["managementId"] = "actor-cd-c01"
        for subnet in candidate["network"]["subnets"].values():
            subnet["zone"] = "ap-chengdu-1"
        validated = MODULE.validate_inventory(candidate)
        self.assertEqual(validated["availabilityMode"], "qualification-single-zone")

    def test_rejects_single_zone_claiming_production_mode(self):
        candidate = inventory()
        for subnet in candidate["network"]["subnets"].values():
            subnet["zone"] = "ap-beijing-6"
        with self.assertRaisesRegex(ValueError, "exactly 3 zone"):
            MODULE.validate_inventory(candidate)

    def test_writer_refuses_existing_output(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "existing"
            output.mkdir()
            with self.assertRaisesRegex(ValueError, "already exists"):
                MODULE.write_new_tree(output, {"a": b"b"})

    @unittest.skipUnless(shutil.which("kubectl"), "kubectl is needed for Kustomize validation")
    def test_generated_machine_sets_are_self_contained_kustomizations(self):
        inv = MODULE.validate_inventory(inventory())
        spec = MODULE.validate_spec(cell_spec(), inv)
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "rendered"
            MODULE.write_new_tree(output, MODULE.render(inv, spec, image_inventory()))
            for name in MODULE.ARGO_MACHINE_POOL_NAMES:
                rendered = subprocess.run(
                    ["kubectl", "kustomize", str(output / "machine-pools" / name)],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout
                self.assertIn("kind: MachineSet", rendered)
                self.assertIn(f"fleet.actor.dev/cell: {inv['cellId']}", rendered)
            root = subprocess.run(
                ["kubectl", "kustomize", str(output)],
                check=True,
                capture_output=True,
                text=True,
            ).stdout
            self.assertEqual(root.count("kind: MachineSet"), 3)
            self.assertEqual(root.count("kind: RivetCell"), 1)


if __name__ == "__main__":
    unittest.main()
