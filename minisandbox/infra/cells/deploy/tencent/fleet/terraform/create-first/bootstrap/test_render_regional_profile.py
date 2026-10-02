#!/usr/bin/env python3

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


RENDER = load("create_first_regional_profile", ROOT / "render-regional-profile.py")
FIXTURE = load("create_first_regional_profile_fixture", ROOT.parent / "test-render-cell-assets.py")
SOURCE = (ROOT.parents[2] / "beijing-kubernetes-profile.yaml").read_text()


class RegionalProfileRendererTests(unittest.TestCase):
    def test_binds_private_monitor_and_recomputes_class_digest(self):
        documents, receipt = RENDER.render(SOURCE, FIXTURE.image_inventory())
        profile, shard_class = documents
        kubernetes = profile["spec"]["foundationDB"]["kubernetes"]
        self.assertEqual(kubernetes["imageRepository"], "example.tencentcloudcr.com/actor-fleet/fdb-kubernetes-monitor")
        self.assertEqual(kubernetes["imageTagDigest"], "7.3.79@sha256:" + "d" * 64)
        self.assertEqual(shard_class["spec"]["profileRef"]["digest"], RENDER.spec_digest(profile))
        self.assertEqual(receipt["profileDigest"], RENDER.spec_digest(profile))
        self.assertEqual(
            profile["metadata"]["annotations"]["fleet.actor.dev/image-inventory-digest"],
            FIXTURE.image_inventory()["inventoryDigest"],
        )

    def test_rejects_inventory_without_monitor(self):
        inventory = FIXTURE.image_inventory()
        inventory["images"] = [item for item in inventory["images"] if item["repository"] != "fdb-kubernetes-monitor"]
        with self.assertRaises(ValueError):
            RENDER.render(SOURCE, inventory)

    def test_rejects_malformed_source_shape(self):
        with self.assertRaisesRegex(ValueError, "exactly one"):
            RENDER.render("apiVersion: v1\nkind: ConfigMap\nmetadata: {name: bad}\n", FIXTURE.image_inventory())


if __name__ == "__main__":
    unittest.main()
