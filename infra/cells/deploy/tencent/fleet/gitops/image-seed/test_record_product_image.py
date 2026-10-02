#!/usr/bin/env python3

import importlib.util
import json
import subprocess
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("record_product_image", ROOT / "record-product-image.py")
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


REVISION = "a" * 40
MANIFEST = "sha256:" + "b" * 64


def inspect(labels):
    return subprocess.CompletedProcess(
        args=[], returncode=0, stdout=json.dumps({"Docker": {"config": {"Labels": labels}}}), stderr="",
    )


class ProductImagePullTests(unittest.TestCase):
    def labels(self):
        return {
            "org.opencontainers.image.revision": REVISION,
            "fleet.actor.dev/source-manifest-sha256": MANIFEST.removeprefix("sha256:"),
        }

    def test_cold_pulls_exact_digest_and_checks_labels(self):
        ref = "example.tencentcloudcr.com/actor-fleet/workers-api@sha256:" + "c" * 64
        with mock.patch.object(
            MODULE.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 0, stdout="isolated-image-id\n", stderr=""),
                inspect(self.labels()),
            ],
        ) as run:
            MODULE.cold_pull(ref, Path("/protected/auth.json"), REVISION, MANIFEST)
        self.assertEqual(run.call_args_list[0].args[0][-1], "docker://" + ref)
        self.assertEqual(run.call_args_list[1].args[0][-1], "isolated-image-id")
        for call in run.call_args_list:
            command = call.args[0]
            self.assertIn("--root", command)
            self.assertIn("--runroot", command)
            self.assertIn("--storage-driver", command)
            self.assertIn("/data/tmp/actor-product-cold-pull.", command[command.index("--root") + 1])

    def test_rejects_source_identity_drift_after_pull(self):
        labels = self.labels()
        labels["fleet.actor.dev/source-manifest-sha256"] = "d" * 64
        with mock.patch.object(
            MODULE.subprocess, "run", side_effect=[
                subprocess.CompletedProcess([], 0, stdout="isolated-image-id\n", stderr=""),
                inspect(labels),
            ],
        ):
            with self.assertRaisesRegex(ValueError, "manifest label"):
                MODULE.cold_pull("registry/image@sha256:" + "e" * 64, Path("auth"), REVISION, MANIFEST)

    def test_rejects_pull_without_image_identity(self):
        with mock.patch.object(
            MODULE.subprocess, "run",
            return_value=subprocess.CompletedProcess([], 0, stdout="", stderr=""),
        ):
            with self.assertRaisesRegex(ValueError, "no image identity"):
                MODULE.cold_pull("registry/image@sha256:" + "e" * 64, Path("auth"), REVISION, MANIFEST)

    def test_accepts_equivalent_fleet_revision_label(self):
        labels = self.labels()
        labels["fleet.actor.dev/source-revision"] = labels.pop("org.opencontainers.image.revision")
        MODULE.verify_labels(labels, REVISION, MANIFEST)

    def test_rejects_conflicting_revision_labels(self):
        labels = self.labels()
        labels["fleet.actor.dev/source-revision"] = "f" * 40
        with self.assertRaisesRegex(ValueError, "revision label"):
            MODULE.verify_labels(labels, REVISION, MANIFEST)


if __name__ == "__main__":
    unittest.main()
