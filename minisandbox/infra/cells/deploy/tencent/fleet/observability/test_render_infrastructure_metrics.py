#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "render_infrastructure_metrics", ROOT / "render-infrastructure-metrics.py"
)
RENDER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RENDER)


class RenderInfrastructureMetricsTests(unittest.TestCase):
    def test_renders_one_cell_without_fixture_identity(self):
        monitor = "registry.example/fdb-monitor@sha256:" + "1" * 64
        metrics = "registry.example/metrics@sha256:" + "2" * 64
        rendered = RENDER.render(
            (ROOT / "infrastructure-metrics.yaml").read_text(),
            "actor-bj-a01", "ap-beijing", "actor-backup-a01-1234567890",
            monitor, metrics,
        )
        documents = [item for item in yaml.safe_load_all(rendered) if item]
        deployment = next(item for item in documents if item["kind"] == "Deployment")
        images = [item["image"] for item in deployment["spec"]["template"]["spec"]["containers"]]
        self.assertEqual(images, [monitor, metrics])
        self.assertEqual(deployment["metadata"]["name"], "actor-bj-a01-fdb-backup-metrics")
        self.assertIn("actor-backup-a01-1234567890", rendered)
        self.assertNotIn("actor-bj-k01", rendered)
        self.assertIn("/actor/production/ap-beijing/bj-a01/foundationdb/continuous", rendered)
        self.assertNotIn("/bj-k01/", rendered)

    def test_rejects_mutable_images(self):
        with self.assertRaisesRegex(ValueError, "pinned registry digests"):
            RENDER.render("---\n{}\n", "actor-bj-a01", "ap-beijing", "actor-backup-a01-1234567890", "image:latest", "image:latest")


if __name__ == "__main__":
    unittest.main()
