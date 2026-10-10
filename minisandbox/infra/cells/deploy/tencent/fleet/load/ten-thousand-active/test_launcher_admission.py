"""Execute the prepared launcher's real jq gates; no cloud operations."""

import copy
import hashlib
import json
from pathlib import Path
import re
import subprocess
import unittest


ROOT = Path(__file__).parent
LAUNCHER = ROOT / "evidence/2757-runtime-tools120-launch-prepared-20261004.sh"
OBSERVATION = ROOT / "evidence/2757-launch-nodefs-rejected-20261004.json"


class LauncherAdmissionTests(unittest.TestCase):
    def setUp(self):
        self.source = LAUNCHER.read_text()
        gates = re.findall(r"jq -e '(.*?)'", self.source, re.DOTALL)
        self.assertEqual(len(gates), 3, "tests must exercise actual launcher gates")
        self.nodes_gate, self.hpa_gate, self.fs_gate = gates

    def accepts(self, gate, document):
        return subprocess.run(["jq", "-e", gate], input=json.dumps(document),
                              capture_output=True, text=True).returncode == 0

    def hpa(self):
        return {"spec": {"minReplicas": 3, "maxReplicas": 30}, "status": {
            "conditions": [{"type": "ScalingActive", "status": "True"}],
            "currentMetrics": [{"type": "Pods", "pods": {
                "metric": {"name": name}, "current": {"averageValue": "0"}}}
                for name in ("workers_api_routing_requests_per_second",
                             "workers_api_routing_requests_in_flight")]}}

    def test_observed_ready_node_below_reserve_is_rejected(self):
        observation = json.loads(OBSERVATION.read_bytes())
        self.assertFalse(observation["businessLoadStarted"])
        for node in observation["centralNodeFs"]:
            fs = {key: node[key] for key in ("availableBytes", "capacityBytes", "inodesFree")}
            with self.subTest(node=node["name"]):
                self.assertEqual(self.accepts(self.fs_gate, {"node": {"fs": fs}}), node["passed"])

    def test_reserve_is_strict_and_missing_space_is_not_zero_pressure(self):
        fs = {"capacityBytes": 105620869120, "availableBytes": 17990614017, "inodesFree": 100001}
        self.assertTrue(self.accepts(self.fs_gate, {"node": {"fs": fs}}))
        for key, value in (("availableBytes", 17990614016), ("availableBytes", None),
                           ("capacityBytes", None), ("inodesFree", 100000), ("inodesFree", None)):
            mutated = dict(fs, **{key: value})
            with self.subTest(key=key, value=value):
                self.assertFalse(self.accepts(self.fs_gate, {"node": {"fs": mutated}}))
        self.assertFalse(self.accepts(self.fs_gate, {"node": {}}))

    def test_hpa_requires_both_observed_custom_metrics(self):
        self.assertTrue(self.accepts(self.hpa_gate, self.hpa()))
        for index in (0, 1):
            for missing in (True, False):
                document = self.hpa()
                if missing:
                    document["status"]["currentMetrics"].pop(index)
                else:
                    document["status"]["currentMetrics"][index]["pods"]["current"]["averageValue"] = None
                self.assertFalse(self.accepts(self.hpa_gate, document))
        document = self.hpa()
        document["status"]["conditions"][0]["status"] = "False"
        self.assertFalse(self.accepts(self.hpa_gate, document))
        document = self.hpa()
        document["spec"]["maxReplicas"] = 300
        self.assertFalse(self.accepts(self.hpa_gate, document))

    def test_all_current_nodes_must_be_ready_and_without_disk_pressure(self):
        node = {"metadata": {}, "status": {"conditions": [
            {"type": "Ready", "status": "True"},
            {"type": "DiskPressure", "status": "False"}]}}
        nodes = {"items": [copy.deepcopy(node) for _ in range(3)]}
        self.assertTrue(self.accepts(self.nodes_gate, nodes))
        for count in (0, 2, 4):
            self.assertFalse(self.accepts(self.nodes_gate, {"items": [node] * count}))
        for index in range(3):
            for type_, status in (("Ready", "False"), ("DiskPressure", "True")):
                mutated = copy.deepcopy(nodes)
                conditions = mutated["items"][index]["status"]["conditions"]
                next(condition for condition in conditions if condition["type"] == type_)["status"] = status
                self.assertFalse(self.accepts(self.nodes_gate, mutated))
            mutated = copy.deepcopy(nodes)
            mutated["items"][index]["metadata"]["deletionTimestamp"] = "2026-10-03T19:23:17Z"
            self.assertFalse(self.accepts(self.nodes_gate, mutated))

    def test_launcher_keeps_service_lifetime_and_does_not_own_an_outer_lock(self):
        self.assertEqual(hashlib.sha256(LAUNCHER.read_bytes()).hexdigest(),
                         "3fc4505fb0d75e33d7f806d3e8c7045af1a64cdb71f6cfc7f2549ae7a590a91c")
        self.assertIn("--property=RuntimeMaxSec=172800", self.source)
        self.assertIn("--property=Restart=no", self.source)
        self.assertIn('"/api/v1/nodes/$node_name/proxy/stats/summary"', self.source)
        self.assertNotIn("kubectl scale", self.source)
        self.assertNotIn("flock ", self.source)
        self.assertEqual(subprocess.run(["bash", "-n", str(LAUNCHER)], capture_output=True).returncode, 0)


if __name__ == "__main__":
    unittest.main()
