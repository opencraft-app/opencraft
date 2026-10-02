#!/usr/bin/env python3

import unittest
from pathlib import Path

import yaml


SCRIPT = Path(__file__).with_name("install-qualification-workers-api.sh").read_text()
MANIFEST = list(yaml.safe_load_all(
    Path(__file__).with_name("qualification-workers-api.yaml").read_text()
))


class QualificationWorkersAPIInstallTests(unittest.TestCase):
    def test_installer_owns_declared_server_side_apply_fields(self):
        applies = [
            line for line in SCRIPT.splitlines()
            if line.startswith('kubectl "${kubeconfig_args[@]}" apply')
        ]
        self.assertEqual(len(applies), 2)
        for line in applies:
            self.assertIn("--server-side", line)
            self.assertIn("--force-conflicts", line)
        self.assertIn("--field-manager=runtime-qualification-code-plane", SCRIPT)

    def test_three_replica_rolling_strategy_migrates_previous_singleton(self):
        deployment = next(item for item in MANIFEST if item.get("kind") == "Deployment")
        self.assertEqual(deployment["spec"]["replicas"], 3)
        self.assertEqual(deployment["spec"]["strategy"], {
            "type": "RollingUpdate",
            "rollingUpdate": {"maxUnavailable": 1, "maxSurge": 1},
        })
        self.assertIn('.spec.strategy.type == "Recreate"', SCRIPT)
        self.assertIn('"type":"RollingUpdate"', SCRIPT)
        self.assertIn('--type=merge --patch "$patch" --dry-run=server', SCRIPT)
        self.assertIn('--qualification-cell=', SCRIPT)
        self.assertIn('--max-concurrent-prepares', SCRIPT)
        self.assertIn('serviceAccountName', SCRIPT)
        self.assertIn('fleet.actor.dev/component', SCRIPT)
        self.assertIn('refusing to migrate a Workers API Deployment outside', SCRIPT)

    def test_qualification_api_has_ha_placement_and_disruption_budget(self):
        deployment = next(item for item in MANIFEST if item.get("kind") == "Deployment")
        pod_spec = deployment["spec"]["template"]["spec"]
        self.assertIn("podAntiAffinity", pod_spec["affinity"])
        self.assertEqual(pod_spec["topologySpreadConstraints"][0]["topologyKey"], "topology.kubernetes.io/zone")
        pdb = next(item for item in MANIFEST if item.get("kind") == "PodDisruptionBudget")
        self.assertEqual(pdb["spec"]["minAvailable"], 2)
        args = deployment["spec"]["template"]["spec"]["containers"][0]["args"]
        self.assertIn("--max-concurrent-prepares=4", args)


if __name__ == "__main__":
    unittest.main()
