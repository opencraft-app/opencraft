#!/usr/bin/env python3

import copy
import hashlib
import importlib.util
import json
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent


def load(name: str, path: Path):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


VALIDATE = load("create_first_cell_platform_inputs", ROOT / "validate-cell-platform-inputs.py")
FIXTURE = load("create_first_cell_platform_fixture", ROOT.parent / "test-render-cell-assets.py")
STORAGE = load("create_first_cell_platform_storage_fixture", ROOT / "test_validate_storage_inputs.py")
REGIONAL = load("create_first_cell_platform_regional", ROOT / "render-regional-profile.py")
REGIONAL_SOURCE = (ROOT.parents[2] / "beijing-kubernetes-profile.yaml").read_text()
VALIDATOR_SOURCE = (ROOT / "validate-cell-platform-inputs.py").read_text()


def evidence():
    images = FIXTURE.image_inventory()
    profile_documents, profile_receipt = REGIONAL.render(REGIONAL_SOURCE, images)
    profile_source = yaml.safe_dump_all(profile_documents, explicit_start=True, sort_keys=False)
    inventory = FIXTURE.inventory()
    inventory["fleet"]["profileDigest"] = profile_receipt["profileDigest"]
    pull = STORAGE.pull_receipt()
    pull_raw = json.dumps(pull, sort_keys=True).encode()
    pull_sha = hashlib.sha256(pull_raw).hexdigest()
    storage = {
        "schema": "actor-create-first-storage-bootstrap/v1",
        "verdict": "passed",
        "cellId": inventory["cellId"],
        "region": inventory["region"],
        "cluster": {"id": inventory["kubernetes"]["clusterId"], "uid": "cluster-uid-1"},
        "namespace": {"name": "actor-fdb-cell-system", "uid": "namespace-fdb"},
        "imageInventoryDigest": images["inventoryDigest"],
        "pullCredentialReceiptSha256": pull_sha,
        "buckets": {"cold": "cold-bucket", "backup": "backup-bucket"},
        "secrets": [
            {"role": "backup", "name": "actor-bj-k02-backup-credentials", "uid": "backup-secret-uid"},
            {"role": "cold", "name": "actor-bj-k02-runtime-cos", "uid": "cold-secret-uid"},
        ],
    }
    tls = {
        "schema": "actor-fdb-tls-bootstrap/v1",
        "verdict": "passed",
        "cellId": inventory["cellId"],
        "namespace": {"name": "actor-fdb-cell-system", "uid": "namespace-fdb"},
        "secrets": [
            {"purpose": "operator", "name": "fdb-operator-tls", "uid": "operator-tls-uid"},
            {"purpose": "cell", "name": "actor-bj-k02-fdb-tls", "uid": "cell-tls-uid"},
            {"purpose": "backup", "name": "actor-bj-k02-backup-tls", "uid": "backup-tls-uid"},
        ],
    }
    return inventory, images, pull, pull_sha, storage, tls, profile_source, profile_receipt


class CellPlatformInputTests(unittest.TestCase):
    def test_validator_remains_python37_compatible(self):
        self.assertNotIn(".removeprefix(", VALIDATOR_SOURCE)

    def test_complete_evidence_resolves_controller_and_profile(self):
        result = VALIDATE.validate(*evidence())
        self.assertEqual(result["cellId"], "actor-bj-k02")
        self.assertTrue(result["controller"]["image"].endswith("@sha256:" + "d" * 64))
        self.assertEqual(len(result["controller"]["sourceRevision"]), 40)
        self.assertEqual(result["profile"]["digest"], evidence()[0]["fleet"]["profileDigest"])

    def test_rejects_storage_receipt_not_bound_to_pull_bytes(self):
        values = list(evidence())
        values[4] = copy.deepcopy(values[4])
        values[4]["pullCredentialReceiptSha256"] = "0" * 64
        with self.assertRaisesRegex(ValueError, "storage receipt differs"):
            VALIDATE.validate(*values)

    def test_rejects_missing_tls_secret(self):
        values = list(evidence())
        values[5] = copy.deepcopy(values[5])
        values[5]["secrets"].pop()
        with self.assertRaisesRegex(ValueError, "incomplete Secret"):
            VALIDATE.validate(*values)

    def test_rejects_profile_digest_not_bound_by_terraform(self):
        values = list(evidence())
        values[0] = copy.deepcopy(values[0])
        values[0]["fleet"]["profileDigest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "Profile/Class differs"):
            VALIDATE.validate(*values)


if __name__ == "__main__":
    unittest.main()
