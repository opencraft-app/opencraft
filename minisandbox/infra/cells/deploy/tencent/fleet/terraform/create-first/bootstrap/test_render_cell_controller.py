#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("render_create_first_cell_controller", ROOT / "render-cell-controller.py")
RENDER = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(RENDER)
IMAGE = "example.tencentcloudcr.com/actor-fleet/actor-fleet-controller@sha256:" + "a" * 64
INVENTORY = "sha256:" + "b" * 64
REVISION = "c" * 40
MANIFEST = "d" * 64


def source(image=RENDER.SOURCE_IMAGE):
    return yaml.safe_dump_all([{
        "apiVersion": "apps/v1",
        "kind": "Deployment",
        "metadata": {
            "name": "fdb-operator-actor-fleet-controller",
            "namespace": "fdb-operator-actor-fleet-controller-system",
        },
        "spec": {"template": {"metadata": {}, "spec": {
            "imagePullSecrets": [{"name": "actor-fleet-tcr"}],
            "containers": [{"name": "manager", "image": image}],
        }}},
    }])


class CellControllerRendererTests(unittest.TestCase):
    def test_binds_private_image_and_source_identity(self):
        deployment = RENDER.render(source(), IMAGE, INVENTORY, REVISION, MANIFEST)[0]
        template = deployment["spec"]["template"]
        self.assertEqual(template["spec"]["containers"][0]["image"], IMAGE)
        self.assertEqual(template["metadata"]["annotations"], {
            "fleet.actor.dev/image-inventory-digest": INVENTORY,
            "fleet.actor.dev/source-commit": REVISION,
            "fleet.actor.dev/source-manifest-sha256": MANIFEST,
        })

    def test_rejects_changed_source_image(self):
        with self.assertRaisesRegex(ValueError, "source image contract changed"):
            RENDER.render(source("other.invalid/image:latest"), IMAGE, INVENTORY, REVISION, MANIFEST)

    def test_rejects_mutable_private_image(self):
        with self.assertRaisesRegex(ValueError, "registry digest"):
            RENDER.render(source(), "example.invalid/controller:latest", INVENTORY, REVISION, MANIFEST)


if __name__ == "__main__":
    unittest.main()
