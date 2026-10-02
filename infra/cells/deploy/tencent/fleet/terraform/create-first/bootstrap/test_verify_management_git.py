#!/usr/bin/env python3

import base64
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


VERIFY = load("verify_management_git", ROOT / "verify-management-git.py")
FIXTURE = load("verify_management_git_fixture", ROOT.parent / "test-render-cell-assets.py")
PLATFORM_DIGEST = "sha256:" + "1" * 64


def plan():
    return {
        "managementId": "actor-bj-c01",
        "clusterId": "cls-management1",
        "clusterUid": "cluster-uid",
        "imageInventoryDigest": FIXTURE.image_inventory()["inventoryDigest"],
        "actorGitNamespaceUid": "namespace-uid",
        "actorGitPullSecretUid": "pull-secret-uid",
    }


def platform():
    return {
        "managementId": "actor-bj-c01",
        "clusterId": "cls-management1",
        "clusterUid": "cluster-uid",
        "imageInventoryDigest": FIXTURE.image_inventory()["inventoryDigest"],
        "platformReceiptDigest": PLATFORM_DIGEST,
    }


def receipt():
    image = next(
        item["ref"] for item in FIXTURE.image_inventory()["images"]
        if item["repository"] == "git-service"
    )
    return {
        "schema": "actor-create-first-management-git/v1",
        "verdict": "passed",
        "managementId": "actor-bj-c01",
        "cluster": {"id": "cls-management1", "uid": "cluster-uid"},
        "managementPlatformReceiptDigest": PLATFORM_DIGEST,
        "imageInventoryDigest": FIXTURE.image_inventory()["inventoryDigest"],
        "image": image,
        "repository": {
            "id": "42", "url": VERIFY.REPOSITORY_URL, "private": True,
            "defaultBranch": "main", "publisherAccess": "owner", "argocdAccess": "read-only",
        },
        "resources": {
            "namespace": {"name": "actor-git-system", "uid": "namespace-uid", "pullSecretUid": "pull-secret-uid"},
            "statefulSet": {"name": "actor-git", "uid": "sts-uid"},
            "pvc": {"name": "actor-git-data", "uid": "pvc-uid"},
            "credentialSecret": {"name": "actor-git-bootstrap-credentials", "uid": "credential-uid"},
            "argocdRepositorySecret": {"name": "actor-fleet-desired-repository", "uid": "repository-secret-uid"},
        },
        "render": {"sourceSha256": "2" * 64, "manifestSha256": "3" * 64, "receiptSha256": "4" * 64},
    }


def encoded(value: str) -> str:
    return base64.b64encode(value.encode()).decode()


class VerifyManagementGitTests(unittest.TestCase):
    def verified(self):
        return VERIFY.validate_receipt(
            receipt(), "sha256:" + "5" * 64, platform(), plan(), FIXTURE.image_inventory()
        )

    def live_fixture(self):
        verified = self.verified()
        annotations = {
            "fleet.actor.dev/management-id": "actor-bj-c01",
            "fleet.actor.dev/management-cluster-uid": "cluster-uid",
            "fleet.actor.dev/management-platform-receipt-digest": PLATFORM_DIGEST,
            "fleet.actor.dev/image-inventory-digest": FIXTURE.image_inventory()["inventoryDigest"],
        }
        return verified, [
            {"metadata": {"uid": "namespace-uid"}},
            {"metadata": {"uid": "pull-secret-uid"}},
            {
                "metadata": {"uid": "sts-uid", "annotations": annotations},
                "spec": {"replicas": 1, "template": {"spec": {"containers": [{"name": "gitea", "image": verified["image"]}]}}},
                "status": {"readyReplicas": 1, "currentRevision": "rev", "updateRevision": "rev"},
            },
            {"metadata": {"uid": "pvc-uid"}, "status": {"phase": "Bound"}},
            {
                "metadata": {"uid": "credential-uid", "annotations": annotations}, "immutable": True,
                "data": {
                    "publisher-username": encoded("release-publisher"), "publisher-password": encoded("a" * 64),
                    "reader-username": encoded("argocd-reader"), "reader-password": encoded("b" * 64),
                },
            },
            {
                "metadata": {"uid": "repository-secret-uid", "labels": {"argocd.argoproj.io/secret-type": "repository"}},
                "immutable": True,
                "data": {"type": encoded("git"), "url": encoded(VERIFY.REPOSITORY_URL),
                         "username": encoded("argocd-reader"), "password": encoded("b" * 64)},
            },
            {"id": 42, "private": True, "default_branch": "main", "permissions": {"pull": True, "push": False}},
        ]

    def test_accepts_bound_receipt(self):
        result = self.verified()
        self.assertEqual(result["repository"]["url"], VERIFY.REPOSITORY_URL)
        self.assertEqual(result["resources"]["statefulSet"]["uid"], "sts-uid")

    def test_rejects_image_outside_inventory(self):
        candidate = receipt()
        candidate["image"] = "example.tencentcloudcr.com/actor-fleet/git-service@sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "image identity"):
            VERIFY.validate_receipt(
                candidate, "sha256:" + "5" * 64, platform(), plan(), FIXTURE.image_inventory()
            )

    def test_live_check_binds_uids_image_and_read_only_repository(self):
        verified, values = self.live_fixture()
        VERIFY.validate_live(verified, *values)

    def test_live_check_rejects_writer_access_for_argocd(self):
        verified, values = self.live_fixture()
        values[-1] = copy.deepcopy(values[-1])
        values[-1]["permissions"]["push"] = True
        with self.assertRaisesRegex(ValueError, "read-only repository"):
            VERIFY.validate_live(verified, *values)


if __name__ == "__main__":
    unittest.main()
