#!/usr/bin/env python3

import hashlib
import importlib.util
import json
import pathlib
import unittest


PATH = pathlib.Path(__file__).resolve().with_name("build-cell-class-qualification.py")
SPEC = importlib.util.spec_from_file_location("cell_class_qualification", PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CellClassQualificationTests(unittest.TestCase):
    def receipt(self):
        profile = "sha256:" + "a" * 64
        inventory = "sha256:" + "b" * 64
        return {
            "schemaVersion": "actor-fdb-autoscaling-qualification-v4",
            "verdict": "passed", "stage": "complete", "exitStatus": 0,
            "completedAt": "2026-09-13T00:00:00Z", "cell": "actor-bj-b01", "runID": "run",
            "sourceRevision": "c" * 40, "sourceManifestSHA256": "d" * 64,
            "loadgenImage": "registry.tencentcloudcr.com/fleet/loadgen@sha256:" + "e" * 64,
            "profileBinding": {
                "className": "rivet-fdb-cos-kubernetes-v1",
                "profileName": "rivet-fdb-operator-cbs-beijing-v1",
                "profileDigest": profile, "driverABI": "rivet-fdb-cos-kubernetes-v1",
                "region": "ap-beijing", "imageInventoryDigest": inventory,
            },
            "rivetCell": {
                "metadata": {"uid": "cell-uid", "annotations": {
                    "fleet.actor.dev/profile-digest": profile,
                    "fleet.actor.dev/image-inventory-digest": inventory,
                }},
                "spec": {"className": "rivet-fdb-cos-kubernetes-v1", "region": "ap-beijing"},
            },
            "foundationDB": {"metadata": {"uid": "fdb-uid"}},
            "scaleOperations": {"items": [
                {"metadata": {"uid": "up-uid"}, "spec": {"direction": "Up"}},
                {"metadata": {"uid": "down-uid"}, "spec": {"direction": "Down"}},
            ]},
        }

    def test_compact_certificate_binds_profile_and_raw_evidence(self):
        raw = (json.dumps(self.receipt(), sort_keys=True) + "\n").encode()
        certificate = MODULE.build(raw)
        self.assertEqual("actor-cell-class-qualification/v1", certificate["schema"])
        self.assertEqual("sha256:" + "a" * 64, certificate["scope"]["profileDigest"])
        self.assertEqual(hashlib.sha256(raw).hexdigest(), certificate["evidence"]["sha256"])
        self.assertEqual(MODULE.canonical_digest(certificate), certificate["evidenceSha256"])

    def test_v5_receipt_is_accepted_without_rewriting_evidence_identity(self):
        receipt = self.receipt()
        receipt["schemaVersion"] = "actor-fdb-autoscaling-qualification-v5"
        raw = (json.dumps(receipt, sort_keys=True) + "\n").encode()
        certificate = MODULE.build(raw)
        self.assertEqual(certificate["evidence"]["schema"], receipt["schemaVersion"])

    def test_mismatched_cell_annotation_is_rejected(self):
        receipt = self.receipt()
        receipt["rivetCell"]["metadata"]["annotations"]["fleet.actor.dev/profile-digest"] = "sha256:" + "f" * 64
        with self.assertRaises(AssertionError):
            MODULE.build(json.dumps(receipt).encode())


if __name__ == "__main__":
    unittest.main()
