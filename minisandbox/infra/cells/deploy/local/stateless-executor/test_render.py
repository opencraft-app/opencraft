import subprocess
import tempfile
import unittest
from pathlib import Path

import yaml


ROOT = Path(__file__).resolve().parent
MANIFEST = ROOT.parents[1] / "tencent" / "fleet" / "runtime" / "stateless-executor.yaml"


class RenderTest(unittest.TestCase):
    def test_local_topology_preserves_runtime_abi(self):
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "rendered.yaml"
            subprocess.run([
                "python3", str(ROOT / "render.py"), str(MANIFEST), str(output),
                "--cell", "local-runtime-a",
                "--image", "rivet/local-real-runtime:test",
                "--runtime-digest", "sha256:" + "a" * 64,
                "--registry-url", "http://registry.local:30081/",
                "--object-router-address", "router.local:30083",
            ], check=True)
            encoded = output.read_text()
            documents = [item for item in yaml.safe_load_all(encoded) if item]

        self.assertNotIn("HorizontalPodAutoscaler", {item["kind"] for item in documents})
        deployment = next(item for item in documents if item["kind"] == "Deployment")
        service = next(item for item in documents if item["kind"] == "Service")
        monitor = next(item for item in documents if item["kind"] == "ServiceMonitor")
        pod = deployment["spec"]["template"]["spec"]
        containers = {item["name"]: item for item in pod["containers"]}
        self.assertEqual(deployment["spec"]["replicas"], 1)
        expressions = pod["affinity"]["nodeAffinity"][
            "requiredDuringSchedulingIgnoredDuringExecution"
        ]["nodeSelectorTerms"][0]["matchExpressions"]
        self.assertEqual(
            expressions,
            [
                {"key": "rivet.dev/stateless", "operator": "In", "values": ["true"]},
                {
                    "key": "fleet.actor.dev/stateless-admitted",
                    "operator": "In",
                    "values": ["true"],
                },
            ],
        )
        self.assertNotIn("nodeSelector", pod)
        self.assertEqual(
            pod["tolerations"],
            [{
                "key": "rivet.dev/stateless", "operator": "Equal", "value": "true",
                "effect": "NoSchedule",
            }],
        )
        self.assertEqual(set(containers), {"workerd", "executor"})
        self.assertEqual(
            containers["executor"]["command"],
            ["/opt/actor/bin/rivet-workerd-host", "--mode=stateless"],
        )
        self.assertEqual(service["spec"]["ports"][0]["nodePort"], 30484)
        self.assertEqual(monitor["metadata"]["namespace"], "observability")
        self.assertEqual(
            monitor["spec"]["selector"]["matchLabels"],
            {
                "fleet.actor.dev/cell-name": "local-runtime-a",
                "fleet.actor.dev/component": "stateless-executor",
            },
        )
        self.assertEqual(
            {item["targetLabel"] for item in monitor["spec"]["endpoints"][0]["relabelings"]},
            {"cell", "pod", "node"},
        )
        self.assertNotRegex(encoded, r"__[A-Z0-9_]+__")

    def test_local_node_is_admitted_only_after_exact_image_import(self):
        installer = (ROOT / "up.sh").read_text()
        taint = "startup-taint.cluster-autoscaler.kubernetes.io/stateless-admission"
        self.assertIn("local.fleet.actor.dev/stateless-base", installer)
        self.assertIn("local.fleet.actor.dev/stateless-runtime-image-id", installer)
        self.assertIn(f"{taint}=pending:NoSchedule", installer)
        self.assertLess(installer.index('k3d image import "${runtime_image}"'), installer.index(
            'fleet.actor.dev/stateless-admitted=true'
        ))
        self.assertLess(installer.index('fleet.actor.dev/stateless-admitted=true'), installer.index(
            f'{taint}-'
        ))


if __name__ == "__main__":
    unittest.main()
