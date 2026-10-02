#!/usr/bin/env python3

import importlib.util
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("fdb_network_outage", ROOT / "qualify.py")
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class QualificationTests(unittest.TestCase):
    def production(self):
        return {
            "spec": {
                "template": {
                    "metadata": {"labels": {"app.kubernetes.io/name": "worker-registry"}},
                    "spec": {
                        "serviceAccountName": "worker-registry",
                        "containers": [{"name": "worker-registry", "image": "registry/r@sha256:" + "a" * 64}],
                        "topologySpreadConstraints": [{"labelSelector": {"matchLabels": {"app.kubernetes.io/name": "worker-registry"}}}],
                        "affinity": {"podAntiAffinity": {"requiredDuringSchedulingIgnoredDuringExecution": [
                            {"labelSelector": {"matchLabels": {"app.kubernetes.io/name": "worker-registry"}}}
                        ]}},
                    },
                }
            }
        }

    def test_canary_preserves_runtime_but_isolates_all_selectors(self):
        deployment, policy = MODULE.build_canary(self.production(), "1234abcd")
        self.assertEqual(deployment["spec"]["replicas"], 1)
        self.assertEqual(deployment["spec"]["template"]["spec"]["serviceAccountName"], "worker-registry")
        self.assertEqual(
            deployment["spec"]["template"]["spec"]["containers"][0]["image"],
            "registry/r@sha256:" + "a" * 64,
        )
        encoded = str(deployment)
        self.assertNotIn("'app.kubernetes.io/name': 'worker-registry'", encoded)
        self.assertEqual(policy["spec"]["policyTypes"], ["Egress"])
        self.assertEqual(policy["spec"]["egress"], [])
        self.assertEqual(policy["spec"]["podSelector"], deployment["spec"]["selector"])
        self.assertTrue(MODULE.exact_egress_deny({"spec": {**policy["spec"], "egress": []}}, policy))
        api_defaulted = {"spec": {name: value for name, value in policy["spec"].items() if name != "egress"}}
        self.assertTrue(MODULE.exact_egress_deny(api_defaulted, policy))
        self.assertFalse(MODULE.exact_egress_deny({"spec": {**policy["spec"], "egress": [{}]}}, policy))

    def test_ready_requires_pod_and_every_container(self):
        pod = {
            "status": {
                "phase": "Running", "conditions": [{"type": "Ready", "status": "True"}],
                "containerStatuses": [{"ready": True}],
            }
        }
        self.assertTrue(MODULE.ready(pod))
        pod["status"]["containerStatuses"][0]["ready"] = False
        self.assertFalse(MODULE.ready(pod))

    def test_label_rewrite_does_not_mutate_unrelated_values(self):
        value = {"matchLabels": {"app.kubernetes.io/name": "other"}, "nested": ["worker-registry"]}
        self.assertEqual(MODULE.rewrite_label_selectors(value, "canary"), value)

    def test_network_policy_controller_requires_every_node_ready(self):
        daemonset = {
            "metadata": {
                "name": "networkpolicy", "namespace": "kube-system",
                "uid": "uid-1", "generation": 4,
            },
            "spec": {"template": {"spec": {"containers": [{"image": "registry/networkpolicy:v1"}]}}},
            "status": {
                "observedGeneration": 4, "desiredNumberScheduled": 3,
                "currentNumberScheduled": 3, "updatedNumberScheduled": 3,
                "numberReady": 3, "numberAvailable": 3,
            },
        }
        result = MODULE.network_policy_controller(daemonset)
        self.assertEqual(result["uid"], "uid-1")
        self.assertEqual(result["ready"], 3)
        daemonset["status"]["numberReady"] = 2
        with self.assertRaisesRegex(ValueError, "not fully ready"):
            MODULE.network_policy_controller(daemonset)


if __name__ == "__main__":
    unittest.main()
