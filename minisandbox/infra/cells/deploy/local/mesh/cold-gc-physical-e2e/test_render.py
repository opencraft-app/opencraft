#!/usr/bin/env python3
import importlib.util
import json
import pathlib
import subprocess
import sys
import tempfile
import unittest

import yaml


MODULE_PATH = pathlib.Path(__file__).with_name("render.py")
SPEC = importlib.util.spec_from_file_location("cold_gc_render", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RenderTest(unittest.TestCase):
    def test_replace_tree_does_not_mutate_non_strings(self):
        value = {"name": "local-runtime-a-engine", "replicas": 1, "ready": True}
        self.assertEqual(
            MODULE.replace_tree(value, "local-runtime-a", "qualification"),
            {"name": "qualification-engine", "replicas": 1, "ready": True},
        )

    def test_renders_only_isolated_engine_resources(self):
        source_cell = "local-runtime-a"
        documents = [
            {
                "apiVersion": "v1",
                "kind": "ServiceAccount",
                "metadata": {"name": f"{source_cell}-runtime"},
            },
            {
                "apiVersion": "v1",
                "kind": "ConfigMap",
                "metadata": {"name": f"{source_cell}-runtime-config"},
                "data": {
                    "config.jsonc": json.dumps(
                        {"runtime": {}, "nats": {}, "topology": {}}
                    )
                },
            },
            {
                "apiVersion": "v1",
                "kind": "Service",
                "metadata": {"name": f"{source_cell}-engine"},
                "spec": {"type": "ClusterIP"},
            },
            {
                "apiVersion": "apps/v1",
                "kind": "Deployment",
                "metadata": {"name": f"{source_cell}-engine"},
                "spec": {
                    "template": {
                        "metadata": {},
                        "spec": {
                            "volumes": [
                                {
                                    "name": "fdb-config",
                                    "configMap": {"name": f"{source_cell}-fdb-config"},
                                }
                            ]
                        },
                    }
                },
            },
            {
                "apiVersion": "v1",
                "kind": "Secret",
                "metadata": {"name": "must-not-leak"},
            },
        ]
        with tempfile.TemporaryDirectory() as temporary:
            source = pathlib.Path(temporary, "source.yaml")
            output = pathlib.Path(temporary, "rendered.yaml")
            source.write_text(yaml.safe_dump_all(documents, sort_keys=False))
            subprocess.run(
                [
                    sys.executable,
                    MODULE_PATH,
                    source,
                    "lcgq-123456",
                    "isolated-fdb",
                    output,
                ],
                check=True,
            )
            rendered = list(yaml.safe_load_all(output.read_text()))

        self.assertEqual(len(rendered), 4)
        self.assertNotIn("must-not-leak", [item["metadata"]["name"] for item in rendered])
        deployment = next(item for item in rendered if item["kind"] == "Deployment")
        self.assertEqual(
            deployment["spec"]["template"]["spec"]["volumes"][0]["configMap"][
                "name"
            ],
            "isolated-fdb-config",
        )
        config_map = next(item for item in rendered if item["kind"] == "ConfigMap")
        config = json.loads(config_map["data"]["config.jsonc"])
        self.assertEqual(config["runtime"]["gasoline_cell_namespace"], "lcgq-123456")
        self.assertEqual(len(config["topology"]["datacenters"]), 1)
        self.assertEqual(
            config["nats"]["addresses"],
            [
                "local-runtime-a-nats-0.local-runtime-a-nats.actor-fdb-cell-system.svc.cluster.local:4222"
            ],
        )


if __name__ == "__main__":
    unittest.main()
