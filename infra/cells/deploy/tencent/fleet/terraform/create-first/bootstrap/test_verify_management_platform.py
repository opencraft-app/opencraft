#!/usr/bin/env python3

import copy
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


MODULE = load("verify_management_platform", ROOT / "verify-management-platform.py")
LIVE_TEST = load("management_platform_live_fixtures", ROOT / "test_verify_management_platform_live.py")
IMAGE_DIGEST = "sha256:" + "a" * 64


def fixtures():
    _, _, live = LIVE_TEST.fixtures()
    cluster = {"metadata": {"uid": "cluster-uid"}}
    namespace = {"metadata": {"uid": "argocd-uid"}}
    secret = {"metadata": {"uid": "pull-uid"}}
    crds = [{"name": item["metadata"]["name"], "uid": item["metadata"]["uid"]}
            for item in live if item["kind"] == "CustomResourceDefinition"]
    workloads = [{"kind": item["kind"], "name": item["metadata"]["name"],
                  "uid": item["metadata"]["uid"], "images": MODULE.live_contract().images(item)}
                 for item in live if item["kind"] in MODULE.live_contract().WORKLOAD_KINDS]
    receipt = {
        "schema": "actor-create-first-management-platform/v1", "verdict": "passed",
        "managementId": "actor-bj-c01", "cluster": {"id": "cls-management1", "uid": "cluster-uid"},
        "imageInventoryDigest": IMAGE_DIGEST,
        "inputs": {"pullCredentialReceiptSha256": "1" * 64,
                   "argocdSourceSha256": "2" * 64, "argocdRenderReceiptSha256": "3" * 64},
        "namespace": {"name": "argocd", "uid": "argocd-uid", "pullSecretUid": "pull-uid"},
        "argocd": {"crds": crds, "workloads": workloads},
    }
    plan = {
        "managementId": "actor-bj-c01", "clusterId": "cls-management1", "clusterUid": "cluster-uid",
        "imageInventoryDigest": IMAGE_DIGEST, "pullCredentialReceiptSha256": "1" * 64,
        "argocdNamespaceUid": "argocd-uid", "argocdPullSecretUid": "pull-uid",
    }
    # The live fixture uses its generated image-inventory digest.
    receipt["imageInventoryDigest"] = live[3]["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/image-inventory-digest"]
    plan["imageInventoryDigest"] = receipt["imageInventoryDigest"]
    return receipt, plan, cluster, namespace, secret, live


class ManagementPlatformReceiptTests(unittest.TestCase):
    def test_exact_receipt_and_live_resources_pass(self):
        receipt, plan, cluster, namespace, secret, live = fixtures()
        verified = MODULE.validate_receipt(receipt, "sha256:" + "4" * 64, plan)
        MODULE.validate_live(verified, cluster, namespace, secret, live)
        self.assertEqual(verified["clusterUid"], "cluster-uid")

    def test_replaced_cluster_fails(self):
        receipt, plan, cluster, namespace, secret, live = fixtures()
        cluster["metadata"]["uid"] = "replacement"
        with self.assertRaisesRegex(ValueError, "cluster UID"):
            MODULE.validate_live(
                MODULE.validate_receipt(receipt, "sha256:" + "4" * 64, plan),
                cluster, namespace, secret, live,
            )

    def test_mutated_platform_workload_fails(self):
        receipt, plan, cluster, namespace, secret, live = fixtures()
        live = copy.deepcopy(live)
        target = next(item for item in live if item["kind"] == "Deployment")
        target["metadata"]["uid"] = "replacement"
        with self.assertRaisesRegex(ValueError, "identity differs"):
            MODULE.validate_live(
                MODULE.validate_receipt(receipt, "sha256:" + "4" * 64, plan),
                cluster, namespace, secret, live,
            )


if __name__ == "__main__":
    unittest.main()
