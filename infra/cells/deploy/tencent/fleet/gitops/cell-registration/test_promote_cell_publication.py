#!/usr/bin/env python3

import copy
import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("promote_cell_publication", ROOT / "promote-cell-publication.py")
PROMOTE = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(PROMOTE)


OLD = "1" * 40
NEW = "2" * 40
RECEIPT = "sha256:" + "8" * 64


def publication():
    return {
        "schema": "actor-cell-desired-state-publication/v1",
        "verdict": "passed",
        "cellId": "actor-bj-a01",
        "gitRevision": NEW,
        "terraformInventoryDigest": "sha256:" + "3" * 64,
        "handoffReceiptDigest": "sha256:" + "4" * 64,
        "publicationReceiptDigest": "sha256:" + "5" * 64,
        "imageInventoryDigest": "sha256:" + "6" * 64,
        "profileDigest": "sha256:" + "7" * 64,
    }


def secret():
    return {
        "apiVersion": "v1",
        "kind": "Secret",
        "metadata": {
            "name": "actor-cell-actor-bj-a01",
            "namespace": "argocd",
            "uid": "secret-uid",
            "resourceVersion": "41",
            "managedFields": [{"manager": "old"}],
            "labels": {
                "argocd.argoproj.io/secret-type": "cluster",
                "fleet.actor.dev/managed-cell": "true",
                "fleet.actor.dev/desired-state": "published",
                "fleet.actor.dev/cell-id": "actor-bj-a01",
            },
            "annotations": {
                "fleet.actor.dev/git-revision": OLD,
                "fleet.actor.dev/cluster-id": "cls-stable",
            },
        },
        "data": {"config": "credential-material", "server": "endpoint"},
    }


def platform():
    return {
        "schema": "actor-create-first-cell-platform/v1",
        "verdict": "passed",
        "cellId": "actor-bj-a01",
        "imageInventoryDigest": "sha256:" + "6" * 64,
        "profile": {"digest": "sha256:" + "7" * 64},
    }


class PromotionTests(unittest.TestCase):
    def test_bootstrap_tool_avoids_post_python36_syntax(self):
        source = (ROOT / "promote-cell-publication.py").read_text()
        self.assertNotIn("from __future__ import annotations", source)
        self.assertNotIn("capture_output=", source)
        self.assertNotRegex(source, r"\b(?:dict|list|tuple|set)\[")

    def test_promotes_only_release_annotations_and_preserves_credentials(self):
        before = secret()
        result = PROMOTE.plan(before, publication(), OLD, RECEIPT)
        self.assertEqual(result["data"], before["data"])
        self.assertEqual(result["metadata"]["uid"], "secret-uid")
        self.assertEqual(result["metadata"]["resourceVersion"], "41")
        self.assertNotIn("managedFields", result["metadata"])
        self.assertEqual(result["metadata"]["annotations"]["fleet.actor.dev/git-revision"], NEW)
        self.assertEqual(result["metadata"]["annotations"]["fleet.actor.dev/profile-digest"], "sha256:" + "7" * 64)
        self.assertEqual(before, secret())

    def test_rejects_stale_expected_revision(self):
        with self.assertRaisesRegex(ValueError, "moved since review"):
            PROMOTE.plan(secret(), publication(), "9" * 40, RECEIPT)

    def test_rejects_cell_identity_change(self):
        changed = publication()
        changed["cellId"] = "actor-bj-b01"
        with self.assertRaisesRegex(ValueError, "identity"):
            PROMOTE.plan(secret(), changed, OLD, RECEIPT)

    def test_rejects_unverified_publication(self):
        changed = copy.deepcopy(publication())
        changed["verdict"] = "failed"
        with self.assertRaisesRegex(ValueError, "did not pass"):
            PROMOTE.plan(secret(), changed, OLD, RECEIPT)

    def test_platform_receipt_is_bound_and_promoted(self):
        PROMOTE.validate_platform(platform(), publication())
        result = PROMOTE.plan(secret(), publication(), OLD, RECEIPT, "sha256:" + "a" * 64)
        self.assertEqual(
            result["metadata"]["annotations"]["fleet.actor.dev/platform-receipt-digest"],
            "sha256:" + "a" * 64,
        )

    def test_rejects_platform_from_another_release(self):
        changed = platform()
        changed["imageInventoryDigest"] = "sha256:" + "b" * 64
        with self.assertRaisesRegex(ValueError, "inventory differs"):
            PROMOTE.validate_platform(changed, publication())


if __name__ == "__main__":
    unittest.main()
