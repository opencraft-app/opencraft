#!/usr/bin/env python3

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


RENDER = load("render_management_git", ROOT / "render-management-git.py")
FIXTURE = load("management_git_fixture", ROOT.parent / "test-render-cell-assets.py")
PLATFORM = "sha256:" + "1" * 64


class RenderManagementGitTests(unittest.TestCase):
    def render(self, images=None):
        return RENDER.render(
            RENDER.DEFAULT_SOURCE,
            images or FIXTURE.image_inventory(),
            "actor-bj-c01",
            PLATFORM,
            "management-cluster-uid",
        )

    def test_resolves_git_service_from_complete_inventory(self):
        documents, receipt = self.render()
        statefulset = next(item for item in documents if item["kind"] == "StatefulSet")
        image = statefulset["spec"]["template"]["spec"]["containers"][0]["image"]
        expected = next(
            item["ref"] for item in FIXTURE.image_inventory()["images"]
            if item["repository"] == "git-service"
        )
        self.assertEqual(image, expected)
        self.assertEqual(receipt["image"], expected)
        self.assertEqual(receipt["sourceSha256"], RENDER.SOURCE_SHA256)
        self.assertEqual(receipt["managementPlatformReceiptDigest"], PLATFORM)

    def test_marks_every_resource_with_management_identity(self):
        documents, _ = self.render()
        for document in documents:
            annotations = document["metadata"]["annotations"]
            self.assertEqual(annotations["fleet.actor.dev/management-id"], "actor-bj-c01")
            self.assertEqual(
                annotations["fleet.actor.dev/management-cluster-uid"], "management-cluster-uid"
            )
        statefulset = next(item for item in documents if item["kind"] == "StatefulSet")
        self.assertEqual(
            statefulset["spec"]["template"]["metadata"]["annotations"]
            ["fleet.actor.dev/image-inventory-digest"],
            FIXTURE.image_inventory()["inventoryDigest"],
        )
        self.assertNotIn("actor-qualification-git", str(documents))
        environment = statefulset["spec"]["template"]["spec"]["containers"][0]["env"]
        self.assertIn(
            {"name": "GITEA__repository__DEFAULT_BRANCH", "value": "main"}, environment
        )

    def test_rejects_tampered_inventory(self):
        images = copy.deepcopy(FIXTURE.image_inventory())
        images["inventoryDigest"] = "sha256:" + "0" * 64
        with self.assertRaisesRegex(ValueError, "digest mismatch"):
            self.render(images)

    def test_rejects_changed_source_bytes(self):
        with self.assertRaisesRegex(ValueError, "reviewed bytes"):
            RENDER.render(
                ROOT / "test_render_management_git.py",
                FIXTURE.image_inventory(),
                "actor-bj-c01",
                PLATFORM,
                "management-cluster-uid",
            )


if __name__ == "__main__":
    unittest.main()
