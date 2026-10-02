#!/usr/bin/env python3

import copy
import importlib.util
import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("verify_cell_platform", ROOT / "verify-platform.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


IMAGE = "sha256:" + "1" * 64
RECEIPT_DIGEST = "sha256:" + "2" * 64
PROFILE_SPEC = {"foundationDB": {"version": "7.3.69"}}
PROFILE_DIGEST = MODULE.spec_digest(PROFILE_SPEC)
CONTROLLER_IMAGE = "registry.invalid/actor-fleet/actor-fleet-controller@sha256:" + "3" * 64


def fixtures(test_fixture=False):
    publication = {
        "cellId": "actor-bj-k02", "clusterId": "cls-test0001",
        "imageInventoryDigest": IMAGE, "profileDigest": PROFILE_DIGEST,
        "fleetBinding": {"className": "class-a"},
    }
    receipt = {
        "schema": "actor-create-first-cell-platform/v1", "verdict": "passed",
        "cellId": "actor-bj-k02", "cluster": {"id": "cls-test0001", "uid": "cluster-uid"},
        "imageInventoryDigest": IMAGE,
        "inputs": {
            "pullCredentialReceiptSha256": "4" * 64,
            "storageCredentialReceiptSha256": "5" * 64,
            "fdbTlsReceiptSha256": "6" * 64,
            "regionalProfileReceiptSha256": "7" * 64,
        },
        "profile": {
            "name": "profile-a", "uid": "profile-uid", "digest": PROFILE_DIGEST,
            "className": "class-a", "classUid": "class-uid",
        },
        "workloads": {
            "fdbOperatorUid": "fdb-uid",
            "fdbOperatorImages": ["fdb.invalid/operator@sha256:" + "8" * 64],
            "cellControllerUid": "controller-uid",
            "cellControllerImage": CONTROLLER_IMAGE,
        },
    }
    if test_fixture:
        receipt["testFixture"] = True
    deployment = lambda uid, image=None: {
        "metadata": {"uid": uid, "generation": 2},
        "spec": {
            "replicas": 1,
            "template": {
                "metadata": {"annotations": {"fleet.actor.dev/image-inventory-digest": IMAGE}},
                "spec": {"containers": ([{"image": image}] if image else [{"image": "fdb.invalid/operator@sha256:" + "8" * 64}])},
            },
        },
        "status": {"observedGeneration": 2, "updatedReplicas": 1, "availableReplicas": 1},
    }
    live = (
        {"metadata": {"uid": "cluster-uid"}},
        deployment("fdb-uid"),
        deployment("controller-uid", CONTROLLER_IMAGE),
        {"metadata": {"name": "profile-a", "uid": "profile-uid"}, "spec": PROFILE_SPEC},
        {"metadata": {"name": "class-a", "uid": "class-uid"},
         "spec": {"profileRef": {"name": "profile-a", "digest": PROFILE_DIGEST}}},
    )
    return publication, receipt, live


class PlatformVerificationTests(unittest.TestCase):
    def test_exact_receipt_and_live_floor_pass(self):
        publication, receipt, live = fixtures()
        verified = MODULE.validate_receipt(receipt, RECEIPT_DIGEST, publication)
        MODULE.validate_live(verified, *live)
        self.assertEqual(verified["clusterUid"], "cluster-uid")
        self.assertEqual(verified["platformReceiptDigest"], RECEIPT_DIGEST)

    def test_replaced_controller_uid_fails(self):
        publication, receipt, live = fixtures()
        live = list(copy.deepcopy(live))
        live[2]["metadata"]["uid"] = "replacement-uid"
        with self.assertRaisesRegex(ValueError, "controller UID"):
            MODULE.validate_live(MODULE.validate_receipt(receipt, RECEIPT_DIGEST, publication), *live)

    def test_unavailable_fdb_operator_fails(self):
        publication, receipt, live = fixtures()
        live = list(copy.deepcopy(live))
        live[1]["status"]["availableReplicas"] = 0
        with self.assertRaisesRegex(ValueError, "not fully available"):
            MODULE.validate_live(MODULE.validate_receipt(receipt, RECEIPT_DIGEST, publication), *live)

    def test_mutated_fdb_operator_image_fails(self):
        publication, receipt, live = fixtures()
        live = list(copy.deepcopy(live))
        live[1]["spec"]["template"]["spec"]["containers"][0]["image"] = (
            "fdb.invalid/other@sha256:" + "9" * 64
        )
        with self.assertRaisesRegex(ValueError, "FDB Operator images"):
            MODULE.validate_live(MODULE.validate_receipt(receipt, RECEIPT_DIGEST, publication), *live)

    def test_changed_profile_spec_fails(self):
        publication, receipt, live = fixtures()
        live = list(copy.deepcopy(live))
        live[3]["spec"]["foundationDB"]["version"] = "7.1.0"
        with self.assertRaisesRegex(ValueError, "Profile spec"):
            MODULE.validate_live(MODULE.validate_receipt(receipt, RECEIPT_DIGEST, publication), *live)

    def test_test_fixture_is_explicitly_forbidden_by_default(self):
        publication, receipt, _ = fixtures(test_fixture=True)
        with self.assertRaisesRegex(ValueError, "test-only"):
            MODULE.validate_receipt(receipt, RECEIPT_DIGEST, publication)
        verified = MODULE.validate_receipt(
            receipt, RECEIPT_DIGEST, publication, allow_test_fixture=True,
        )
        self.assertTrue(verified["testFixture"])


if __name__ == "__main__":
    unittest.main()
