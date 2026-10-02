#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location(
    "adapt_single_zone_topology", ROOT / "adapt-single-zone-topology.py"
)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class SingleZoneTopologyTests(unittest.TestCase):
    def assert_adapted(self, path: str):
        documents = list(yaml.safe_load_all(MODULE.adapt((ROOT / path).read_text())))
        workloads = [item for item in documents if item and item.get("kind") in {"Deployment", "StatefulSet"}]
        self.assertTrue(workloads)
        for workload in workloads:
            template = workload["spec"]["template"]
            self.assertEqual(
                template["metadata"]["annotations"]["fleet.actor.dev/availability-mode"],
                "qualification-single-zone",
            )
            pod = template["spec"]
            required = pod.get("affinity", {}).get("podAntiAffinity", {}).get(
                "requiredDuringSchedulingIgnoredDuringExecution", []
            )
            self.assertNotIn(MODULE.ZONE_KEY, [item.get("topologyKey") for item in required])
            strict_spread = [
                item
                for item in pod.get("topologySpreadConstraints", [])
                if item.get("whenUnsatisfiable") == "DoNotSchedule"
            ]
            self.assertNotIn(MODULE.ZONE_KEY, [item.get("topologyKey") for item in strict_spread])
        return workloads

    def test_nats_keeps_required_host_separation(self):
        workloads = self.assert_adapted("nats.yaml")
        nats = next(item for item in workloads if item["kind"] == "StatefulSet")
        required = nats["spec"]["template"]["spec"]["affinity"]["podAntiAffinity"][
            "requiredDuringSchedulingIgnoredDuringExecution"
        ]
        self.assertEqual([item["topologyKey"] for item in required], ["kubernetes.io/hostname"])

    def test_runtime_keeps_required_host_separation(self):
        workloads = self.assert_adapted("runtime.yaml")
        hosts = next(item for item in workloads if item.get("metadata", {}).get("name") == "actor-bj-k01-runtime-hosts")
        required = hosts["spec"]["template"]["spec"]["affinity"]["podAntiAffinity"][
            "requiredDuringSchedulingIgnoredDuringExecution"
        ]
        self.assertEqual([item["topologyKey"] for item in required], ["kubernetes.io/hostname"])

    def test_installer_adapts_runtime_after_release_field_handoff(self):
        installer = (ROOT / "install.sh").read_text()
        runtime_render = installer.index('"$script_dir/runtime.yaml" >"$temporary/runtime.yaml"')
        strip = installer.index('"$script_dir/strip-update-owned-fields.py"', runtime_render)
        adapt = installer.index('"$script_dir/adapt-single-zone-topology.py"', strip)
        partition = installer.index('"$script_dir/partition-runtime-manifest.py"', adapt)
        self.assertLess(runtime_render, strip)
        self.assertLess(strip, adapt)
        self.assertLess(adapt, partition)


if __name__ == "__main__":
    unittest.main()
