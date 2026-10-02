#!/usr/bin/env python3

import importlib.util
import unittest
from unittest import mock
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("render_fdb_install", ROOT / "render-install.py")
RENDER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(RENDER)
OPERATOR = "registry.example/fdb-operator@sha256:" + "a" * 64
MONITOR = "registry.example/fdb-monitor@sha256:" + "b" * 64
INVENTORY = "sha256:" + "c" * 64
INSTALLER = (ROOT / "install.sh").read_text()
NETWORK_POLICY = yaml.safe_load((ROOT / "network-policy.yaml").read_text())


def manifest(extra_image=None):
    containers = [{"name": "manager", "image": RENDER.SOURCE_OPERATOR}]
    if extra_image:
        containers.append({"name": "unknown", "image": extra_image})
    return yaml.safe_dump_all([
        {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "actor-fdb-cell-system"}},
        {
            "apiVersion": "apps/v1", "kind": "Deployment", "metadata": {"name": "operator"},
            "spec": {"template": {"metadata": {}, "spec": {
                "initContainers": [{"name": "init", "image": RENDER.SOURCE_MONITOR}],
                "containers": containers,
            }}},
        },
    ])


class RenderFDBInstallTests(unittest.TestCase):
    def test_dump_falls_back_for_old_pyyaml(self):
        documents = [{"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "test"}}]
        current = RENDER.yaml.safe_dump_all

        def old_dump(value, explicit_start=False, **kwargs):
            if "sort_keys" in kwargs:
                raise TypeError("unexpected sort_keys")
            return current(value, explicit_start=explicit_start)

        with mock.patch.object(RENDER.yaml, "safe_dump_all", side_effect=old_dump):
            rendered = RENDER.dump_documents(documents)
        self.assertEqual(list(RENDER.yaml.safe_load_all(rendered)), documents)

    def test_production_installer_uses_complete_inventory_and_private_renderer(self):
        for value in (
            "actor_image_inventory_require",
            "actor_image_inventory_bind FDB_OPERATOR_IMAGE fdb-kubernetes-operator",
            "actor_image_inventory_bind FDB_MONITOR_IMAGE fdb-kubernetes-monitor",
            'get secret actor-fleet-tcr',
            'python3 "$script_dir/render-install.py"',
        ):
            self.assertIn(value, INSTALLER)

    def test_fdb_ingress_allows_same_namespace_and_regional_registry_namespace(self):
        self.assertEqual(NETWORK_POLICY["spec"]["policyTypes"], ["Ingress"])
        self.assertEqual(
            NETWORK_POLICY["spec"]["ingress"],
            [{"from": [
                {"podSelector": {}},
                {"namespaceSelector": {"matchLabels": {
                    "kubernetes.io/metadata.name": "worker-registry-system"
                }}},
            ]}],
        )

    def test_replaces_both_images_and_binds_pull_and_inventory(self):
        documents = RENDER.render(manifest(), OPERATOR, MONITOR, INVENTORY)
        deployment = documents[1]
        pod = deployment["spec"]["template"]["spec"]
        self.assertEqual(pod["containers"][0]["image"], OPERATOR)
        self.assertEqual(pod["initContainers"][0]["image"], MONITOR)
        self.assertEqual(pod["imagePullSecrets"], [{"name": "actor-fleet-tcr"}])
        self.assertEqual(
            deployment["spec"]["template"]["metadata"]["annotations"][
                "fleet.actor.dev/image-inventory-digest"
            ],
            INVENTORY,
        )

    def test_rejects_unreviewed_third_image(self):
        with self.assertRaisesRegex(ValueError, "unreviewed"):
            RENDER.render(manifest("docker.io/example/sidecar:latest"), OPERATOR, MONITOR, INVENTORY)

    def test_rejects_missing_monitor(self):
        documents = list(yaml.safe_load_all(manifest()))
        documents[1]["spec"]["template"]["spec"].pop("initContainers")
        value = yaml.safe_dump_all(documents)
        with self.assertRaisesRegex(ValueError, "absent"):
            RENDER.render(value, OPERATOR, MONITOR, INVENTORY)

    def test_rejects_mutable_private_image(self):
        with self.assertRaisesRegex(ValueError, "pinned"):
            RENDER.render(manifest(), "registry.example/operator:latest", MONITOR, INVENTORY)


if __name__ == "__main__":
    unittest.main()
