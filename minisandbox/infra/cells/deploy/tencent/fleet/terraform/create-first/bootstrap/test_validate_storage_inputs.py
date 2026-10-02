#!/usr/bin/env python3

import copy
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


VALIDATE = load("create_first_storage_inputs", ROOT / "validate-storage-inputs.py")
FIXTURE = load("create_first_storage_fixture", ROOT.parent / "test-render-cell-assets.py")
KUBECONFIG = "apiVersion: v1\nclusters:\n- cluster: {server: https://10.3.0.10}\n  name: cell\n"


def sensitive():
    return {
        "kubeconfig": KUBECONFIG,
        "storageCredentialMode": "dedicated-users",
        "storageCredentials": {
            "cold": {
                "userName": "actor-bj-k02-cold-storage",
                "bucket": "cold-bucket",
                "accessKeyId": "AKID-cold-example-0001",
                "secretAccessKey": "cold-secret-example-0001",
            },
            "backup": {
                "userName": "actor-bj-k02-backup-storage",
                "bucket": "backup-bucket",
                "accessKeyId": "AKID-backup-example-01",
                "secretAccessKey": "backup-secret-example-01",
            },
        },
    }


def pull_receipt():
    inventory = FIXTURE.inventory()
    images = FIXTURE.image_inventory()
    return {
        "schema": "actor-create-first-pull-bootstrap/v1",
        "verdict": "passed",
        "role": "cell",
        "identity": inventory["cellId"],
        "cluster": {"id": inventory["kubernetes"]["clusterId"], "uid": "cluster-uid-1", "vpcId": inventory["network"]["vpcId"]},
        "imageInventoryDigest": images["inventoryDigest"],
        "namespaces": [{
            "name": "actor-fdb-cell-system",
            "namespaceUid": "namespace-fdb",
            "secretUid": "pull-secret-uid",
        }, {
            "name": "fdb-operator-actor-fleet-controller-system",
            "namespaceUid": "namespace-controller",
            "secretUid": "controller-pull-secret-uid",
        }],
    }


class StorageInputTests(unittest.TestCase):
    def test_joins_distinct_scoped_credentials(self):
        result = VALIDATE.validate(
            FIXTURE.inventory(), FIXTURE.image_inventory(), sensitive(), KUBECONFIG, pull_receipt(),
        )
        self.assertEqual(result["cellId"], "actor-bj-k02")
        self.assertEqual(result["credentials"]["cold"]["bucket"], "cold-bucket")
        self.assertNotEqual(
            result["credentials"]["cold"]["accessKeyId"],
            result["credentials"]["backup"]["accessKeyId"],
        )

    def test_rejects_credential_for_another_bucket(self):
        value = sensitive()
        value["storageCredentials"]["cold"]["bucket"] = "other-cell"
        with self.assertRaisesRegex(ValueError, "differs from Terraform inventory"):
            VALIDATE.validate(
                FIXTURE.inventory(), FIXTURE.image_inventory(), value, KUBECONFIG, pull_receipt(),
            )

    def test_rejects_shared_cold_and_backup_identity(self):
        value = sensitive()
        value["storageCredentials"]["backup"]["accessKeyId"] = value["storageCredentials"]["cold"]["accessKeyId"]
        with self.assertRaisesRegex(ValueError, "different identities"):
            VALIDATE.validate(
                FIXTURE.inventory(), FIXTURE.image_inventory(), value, KUBECONFIG, pull_receipt(),
            )

    def test_accepts_explicit_shared_root_identity(self):
        inventory = FIXTURE.inventory()
        inventory["identity"]["coldStorageUser"] = "root-account-shared"
        inventory["identity"]["backupStorageUser"] = "root-account-shared"
        value = sensitive()
        value["storageCredentialMode"] = "shared-root"
        value["storageCredentials"]["cold"]["userName"] = "root-account-shared"
        value["storageCredentials"]["backup"]["userName"] = "root-account-shared"
        value["storageCredentials"]["backup"]["accessKeyId"] = value["storageCredentials"]["cold"]["accessKeyId"]
        value["storageCredentials"]["backup"]["secretAccessKey"] = value["storageCredentials"]["cold"]["secretAccessKey"]
        receipt = pull_receipt()
        result = VALIDATE.validate(
            inventory, FIXTURE.image_inventory(), value, KUBECONFIG, receipt,
        )
        self.assertEqual(result["storageCredentialMode"], "shared-root")

    def test_rejects_different_kubeconfig(self):
        with self.assertRaisesRegex(ValueError, "differs"):
            VALIDATE.validate(
                FIXTURE.inventory(), FIXTURE.image_inventory(), sensitive(),
                KUBECONFIG.replace("10.3.0.10", "10.3.0.99"), pull_receipt(),
            )

    def test_rejects_pull_receipt_for_other_cluster(self):
        receipt = copy.deepcopy(pull_receipt())
        receipt["cluster"]["id"] = "cls-other0001"
        with self.assertRaisesRegex(ValueError, "differs"):
            VALIDATE.validate(
                FIXTURE.inventory(), FIXTURE.image_inventory(), sensitive(), KUBECONFIG, receipt,
            )


if __name__ == "__main__":
    unittest.main()
