#!/usr/bin/env python3

import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent


class HostAutoscalingManifestTests(unittest.TestCase):
    def render(self):
        raw = (ROOT / "host-autoscaling.yaml").read_text()
        replacements = {
            "__CELL_NAME__": "actor-bj-a01",
            "__NAMESPACE__": "actor-fdb-cell-system",
            "__CONTROLLER_IMAGE__": "registry.example/actor-fleet/actor-fleet-controller@sha256:" + "1" * 64,
            "__MIN_REPLICAS__": "3",
            "__MAX_REPLICAS__": "301",
            "__TARGET_ACTIVE_ACTORS__": "16",
            "__TOPOLOGY_MAX_SKEW__": "2",
            "__TOPOLOGY_REPAIR_ENABLED__": "false",
            "__RUNTIME_MACHINE_SET__": "np-runtime0",
        }
        for source, target in replacements.items():
            raw = raw.replace(source, target)
        self.assertNotRegex(raw, r"__[A-Z0-9_]+__")
        return [document for document in yaml.safe_load_all(raw) if document]

    def test_release_hold_and_single_scale_in_writer(self):
        documents = self.render()
        deployment = next(item for item in documents if item["kind"] == "Deployment")
        hpa = next(item for item in documents if item["kind"] == "HorizontalPodAutoscaler")
        self.assertEqual(deployment["metadata"]["name"], "actor-bj-a01-host-drain")
        self.assertEqual(
            deployment["spec"]["template"]["metadata"]["annotations"]["fleet.actor.dev/runtime-release-hold-protocol"],
            "statefulset-uid-cas-v1",
        )
        self.assertIn("@sha256:", deployment["spec"]["template"]["spec"]["containers"][0]["image"])
        self.assertEqual(hpa["spec"]["minReplicas"], 3)
        self.assertEqual(hpa["spec"]["maxReplicas"], 301)
        self.assertEqual(hpa["spec"]["behavior"]["scaleDown"]["selectPolicy"], "Disabled")
        self.assertEqual(hpa["spec"]["behavior"]["scaleUp"], {
            "stabilizationWindowSeconds": 0,
            "selectPolicy": "Min",
            "policies": [
                {"type": "Pods", "value": 6, "periodSeconds": 60},
                {"type": "Percent", "value": 100, "periodSeconds": 60},
            ],
        })
        self.assertEqual(hpa["spec"]["metrics"][0]["external"]["target"]["averageValue"], "16")

    def test_rbac_is_bounded_to_one_cell(self):
        documents = self.render()
        role = next(item for item in documents if item["kind"] == "Role")
        self.assertEqual(role["rules"][1]["resourceNames"], ["actor-bj-a01-runtime-auth"])
        self.assertEqual(role["rules"][2]["resourceNames"], ["actor-bj-a01-runtime-hosts"])
        self.assertEqual(role["rules"][3]["resourceNames"], ["actor-bj-a01-runtime-hosts-actor-capacity"])
        cluster_role = next(item for item in documents if item["kind"] == "ClusterRole")
        self.assertEqual(cluster_role["rules"], [{
            "apiGroups": [""], "resources": ["nodes"], "verbs": ["get", "list"],
        }, {
            "apiGroups": [""], "resources": ["pods"], "verbs": ["list"],
        }, {
            "apiGroups": ["node.tke.cloud.tencent.com"], "resources": ["machinesets"], "resourceNames": ["np-runtime0"], "verbs": ["get"],
        }, {
            "apiGroups": ["node.tke.cloud.tencent.com"], "resources": ["machines"], "verbs": ["list"],
        }])
        self.assertIn({"apiGroups": [""], "resources": ["pods/eviction"], "verbs": ["create"]}, role["rules"])
        for rule in role["rules"] + cluster_role["rules"]:
            self.assertNotIn("delete", rule["verbs"])
        binding = next(item for item in documents if item["kind"] == "ClusterRoleBinding")
        self.assertEqual(binding["roleRef"]["name"], "actor-bj-a01-host-drain")
        self.assertEqual(binding["subjects"], [{
            "kind": "ServiceAccount", "name": "actor-bj-a01-host-drain", "namespace": "actor-fdb-cell-system",
        }])

    def test_scale_in_uses_the_same_hard_three_zone_contract_as_runtime(self):
        deployment = next(item for item in self.render() if item["kind"] == "Deployment")
        env = {
            item["name"]: item.get("value")
            for item in deployment["spec"]["template"]["spec"]["containers"][0]["env"]
        }
        self.assertEqual(env["HOST_DRAIN_TOPOLOGY_KEY"], "topology.kubernetes.io/zone")
        self.assertEqual(env["HOST_DRAIN_REQUIRED_ZONES"], "3")
        self.assertEqual(env["HOST_DRAIN_TOPOLOGY_MAX_SKEW"], "2")
        self.assertEqual(env["HOST_DRAIN_TOPOLOGY_REPAIR_ENABLED"], "false")
        self.assertEqual(env["HOST_DRAIN_MACHINE_SET"], "np-runtime0")

    def test_production_installer_always_converges_release_hold_controller(self):
        installer = (ROOT / "install.sh").read_text()
        self.assertIn('if [[ $runtime_profile == production ]]; then', installer)
        self.assertIn('"$script_dir/install-host-autoscaling.sh"', installer)

    def test_autoscaling_installer_waits_for_hpa_floor(self):
        installer = (ROOT / "install-host-autoscaling.sh").read_text()
        self.assertIn('((desired >= min_replicas))', installer)
        self.assertIn('$ready == "$desired"', installer)
        self.assertIn('$updated == "$desired"', installer)
        self.assertIn('runtime Host HPA did not converge its minimum Ready floor', installer)


if __name__ == "__main__":
    unittest.main()
