#!/usr/bin/env python3
import importlib.util
import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
PARTITION_SPEC = importlib.util.spec_from_file_location(
    "partition_nats_manifest", ROOT / "partition-nats-manifest.py"
)
PARTITION = importlib.util.module_from_spec(PARTITION_SPEC)
PARTITION_SPEC.loader.exec_module(PARTITION)


class NatsManifestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        documents = list(yaml.safe_load_all((ROOT / "nats.yaml").read_text()))
        cls.config = next(document for document in documents if document.get("kind") == "ConfigMap")
        cls.stateful_set = next(
            document for document in documents if document.get("kind") == "StatefulSet"
        )
        cls.container = cls.stateful_set["spec"]["template"]["spec"]["containers"][0]

    def test_lame_duck_is_bounded_by_pod_grace(self):
        config = self.config["data"]["nats.conf"]
        self.assertIn("lame_duck_duration: 30s", config)
        self.assertIn("lame_duck_grace_period: 5s", config)
        self.assertGreaterEqual(
            self.stateful_set["spec"]["template"]["spec"]["terminationGracePeriodSeconds"],
            45,
        )
        command = self.container["lifecycle"]["preStop"]["exec"]["command"]
        self.assertEqual(command[:2], ["/bin/sh", "-ec"])
        self.assertIn("kill -USR2 1", command[2])
        subprocess.run(["sh", "-n", "-c", command[2]], check=True)

    def test_ready_requires_the_complete_three_member_route_mesh(self):
        command = self.container["readinessProbe"]["exec"]["command"]
        self.assertEqual(command[:2], ["/bin/sh", "-ec"])
        self.assertIn("/routez", command[2])
        self.assertIn('"num_routes"', command[2])
        self.assertIn("[2-9][0-9]*", command[2])
        subprocess.run(["sh", "-n", "-c", command[2]], check=True)

    def test_rollout_waits_for_client_convergence_before_next_member(self):
        self.assertGreaterEqual(self.stateful_set["spec"]["minReadySeconds"], 10)

    def test_bootstrap_config_does_not_require_an_unreleased_nats_option(self):
        documents = list(yaml.safe_load_all((ROOT / "runtime.yaml").read_text()))
        config = next(item for item in documents if item.get("kind") == "ConfigMap")
        payload = config["data"]["config.jsonc"]
        self.assertNotIn('"connection_timeout_ms"', payload)
        validator = (ROOT / "validate-runtime-image.sh").read_text()
        self.assertIn("verify-runtime-pubsub.py", validator)
        self.assertNotIn("config show >/dev/null", validator)

    def test_partitions_exact_base_and_stateful_workload(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory)
            PARTITION.partition((ROOT / "nats.yaml").read_text(), output, "actor-bj-k01")
            base = list(yaml.safe_load_all((output / "nats-base.yaml").read_text()))
            workload = list(
                yaml.safe_load_all((output / "nats-statefulset.yaml").read_text())
            )
        self.assertEqual(
            {(item["kind"], item["metadata"]["name"]) for item in base},
            {
                ("ServiceAccount", "actor-bj-k01-runtime"),
                ("ConfigMap", "actor-bj-k01-nats-config"),
                ("Service", "actor-bj-k01-nats"),
                ("PodDisruptionBudget", "actor-bj-k01-nats"),
            },
        )
        self.assertEqual(
            {(item["kind"], item["metadata"]["name"]) for item in workload},
            {("StatefulSet", "actor-bj-k01-nats")},
        )

    def test_update_converges_engine_before_nats_and_host(self):
        installer = (ROOT / "install.sh").read_text()
        engine = installer.index('rollout status deployment/"${cell_name}-engine"')
        nats_handoff = installer.index(
            '-f "$temporary/runtime-release-fields-nats.json"', engine
        )
        deferred_nats = installer.index(
            '-f "$temporary/nats-statefulset.yaml"', nats_handoff
        )
        nats_mesh = installer.index("wait_for_nats_mesh", deferred_nats)
        pool = installer.index('-f "$temporary/phase-pool.yaml"', nats_mesh)
        host = installer.index('-f "$temporary/phase-runtime.yaml"', pool)
        self.assertLess(engine, nats_handoff)
        self.assertLess(nats_handoff, deferred_nats)
        self.assertLess(deferred_nats, nats_mesh)
        self.assertLess(nats_mesh, pool)
        self.assertLess(pool, host)
        self.assertIn("partial Engine/runtime-hosts/NATS topology", installer)
        self.assertIn("resuming interrupted initial runtime install from the NATS-only prefix", installer)
        self.assertIn('get configmap "${cell_name}-release-ledger"', installer)
        self.assertIn('fleet.actor.dev/component=nats', installer)
        self.assertIn('NATS carries no durable Actor state', installer)
        self.assertIn('label = "nats"', installer)


if __name__ == "__main__":
    unittest.main()
