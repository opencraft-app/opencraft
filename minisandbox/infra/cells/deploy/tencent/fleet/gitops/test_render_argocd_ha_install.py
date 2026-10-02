#!/usr/bin/env python3

import hashlib
import importlib.util
import pathlib
import unittest

import yaml


PATH = pathlib.Path(__file__).with_name("render_argocd_ha_install.py")
SPEC = importlib.util.spec_from_file_location("render_argocd_ha_install", str(PATH))
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def inventory():
    contract = MODULE.image_contract()
    checksum = "sha256:" + "a" * 64
    images = []
    for repository in sorted(contract.ALL_REPOSITORIES):
        provenance = {"kind": "mirror", "source": f"example.invalid/{repository}@{checksum}"}
        if repository in contract.PRODUCT_REPOSITORIES:
            provenance = {
                "kind": "build", "sourceRevision": "b" * 40,
                "sourceManifestDigest": checksum, "buildReceiptDigest": checksum,
            }
        images.append({
            "repository": repository,
            "ref": f"example.tencentcloudcr.com/actor-fleet/{repository}@{checksum}",
            "provenance": provenance,
        })
    value = {
        "schemaVersion": 1, "registry": "example.tencentcloudcr.com", "namespace": "actor-fleet",
        "platform": "linux/amd64", "sourceLockDigest": checksum,
        "seedReceiptDigest": checksum, "images": images,
    }
    value["inventoryDigest"] = contract.digest(value)
    return value


def manifest():
    documents = [
        {"apiVersion": "apiextensions.k8s.io/v1", "kind": "CustomResourceDefinition",
         "metadata": {"name": "applications.argoproj.io"}},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRole",
         "metadata": {"name": "argocd-test"}},
        {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "ClusterRoleBinding",
         "metadata": {"name": "argocd-test"}},
    ]
    for index, source in enumerate(MODULE.SOURCE_REPOSITORIES):
        name = (
            "argocd-redis-ha-haproxy"
            if source == "public.ecr.aws/docker/library/haproxy:3.0.8-alpine"
            else f"component-{index}"
        )
        documents.append({
            "apiVersion": "apps/v1", "kind": "Deployment",
            "metadata": {"name": name},
            "spec": {"template": {"metadata": {}, "spec": {"containers": [{"name": "main", "image": source}]}}},
        })
    return yaml.safe_dump_all(documents).encode()


class ArgoHAInstallTests(unittest.TestCase):
    def test_complete_install_uses_only_inventory_images(self):
        raw = manifest()
        old_hash = MODULE.INPUT_SHA256
        MODULE.INPUT_SHA256 = hashlib.sha256(raw).hexdigest()
        try:
            documents, receipt = MODULE.render(raw, inventory())
        finally:
            MODULE.INPUT_SHA256 = old_hash
        self.assertEqual(receipt["schema"], "actor-argocd-ha-render/v1")
        self.assertEqual(receipt["resources"], 7)
        for document in documents[:3]:
            self.assertNotIn("namespace", document["metadata"])
        for document in documents[3:]:
            self.assertEqual(document["metadata"]["namespace"], "argocd")
            pod = document["spec"]["template"]
            self.assertEqual(pod["spec"]["imagePullSecrets"], [{"name": "actor-fleet-tcr"}])
            self.assertIn("@sha256:", pod["spec"]["containers"][0]["image"])
            self.assertEqual(
                pod["metadata"]["annotations"]["fleet.actor.dev/image-inventory-digest"],
                inventory()["inventoryDigest"],
            )
        haproxy = next(
            item for item in documents
            if item.get("metadata", {}).get("name") == "argocd-redis-ha-haproxy"
        )
        self.assertEqual(haproxy["spec"]["strategy"], {
            "type": "RollingUpdate",
            "rollingUpdate": {"maxSurge": 0, "maxUnavailable": 1},
        })

    def test_rejects_namespace_only_input(self):
        raw = yaml.safe_dump_all([{
            "apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "argocd-server"},
            "spec": {"template": {"spec": {"containers": [{"image": next(iter(MODULE.SOURCE_REPOSITORIES))}]}}},
        }]).encode()
        old_hash = MODULE.INPUT_SHA256
        MODULE.INPUT_SHA256 = hashlib.sha256(raw).hexdigest()
        try:
            with self.assertRaisesRegex(ValueError, "complete cluster install"):
                MODULE.render(raw, inventory())
        finally:
            MODULE.INPUT_SHA256 = old_hash

    def test_rejects_inventory_from_another_registry_generation(self):
        raw = manifest()
        value = inventory()
        value["inventoryDigest"] = "sha256:" + "f" * 64
        old_hash = MODULE.INPUT_SHA256
        MODULE.INPUT_SHA256 = hashlib.sha256(raw).hexdigest()
        try:
            with self.assertRaisesRegex(ValueError, "inventory digest"):
                MODULE.render(raw, value)
        finally:
            MODULE.INPUT_SHA256 = old_hash

    def test_rejects_unreviewed_input_hash(self):
        with self.assertRaisesRegex(ValueError, "SHA256"):
            MODULE.render(b"---\n", inventory())


if __name__ == "__main__":
    unittest.main()
