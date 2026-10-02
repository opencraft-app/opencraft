#!/usr/bin/env python3

import unittest
import os
import subprocess
import tempfile
from pathlib import Path


INSTALLER = (Path(__file__).resolve().parent / "install.sh").read_text()
ADAPTER_INSTALLER = (
    Path(__file__).resolve().parent / "install-prometheus-adapter.sh"
).read_text()


class InstallImagePinningTests(unittest.TestCase):
    def test_every_enabled_chart_image_sets_inventory_digest(self):
        expected = {
            "prometheusOperator.admissionWebhooks.patch.image.sha": "observability-webhook-certgen",
            "prometheusOperator.image.sha": "observability-prometheus-operator",
            "prometheusOperator.prometheusConfigReloader.image.sha": "observability-prometheus-config-reloader",
            "prometheus.prometheusSpec.image.sha": "observability-prometheus",
            "grafana.image.sha": "observability-grafana",
            "grafana.initChownData.image.sha": "observability-busybox",
            "grafana.sidecar.image.sha": "observability-k8s-sidecar",
        }
        for value, repository in expected.items():
            needle = '--set-string "{}=$(image_digest {})"'.format(value, repository)
            self.assertIn(needle, INSTALLER)

        self.assertIn(
            '--set-string "kube-state-metrics.image.sha=sha256:$(image_digest observability-kube-state-metrics)"',
            INSTALLER,
        )
        self.assertIn(
            '--set-string "crds.upgradeJob.image.sha=$(image_digest observability-busybox)"',
            INSTALLER,
        )
        self.assertIn(
            '--set-string "crds.upgradeJob.image.busybox.sha=$(image_digest observability-busybox)"',
            INSTALLER,
        )
        self.assertIn(
            '--set-string "crds.upgradeJob.image.kubectl.sha=$(image_digest observability-kubectl)"',
            INSTALLER,
        )

    def test_inventory_is_the_collector_image_authority(self):
        self.assertIn("fdb_monitor_image=$(resolve_image fdb-kubernetes-monitor)", INSTALLER)
        self.assertIn("metrics_image=$(resolve_image observability-busybox)", INSTALLER)
        self.assertNotIn("ACTOR_FDB_MONITOR_IMAGE", INSTALLER)
        self.assertNotIn("ACTOR_OBSERVABILITY_BUSYBOX_IMAGE", INSTALLER)

    def test_adapter_uses_inventory_digest_and_pinned_chart(self):
        self.assertIn('chart_version=5.3.0', ADAPTER_INSTALLER)
        self.assertIn(
            'chart_sha256=aa6752b6207ed788522714c3ef7f67f27d423eb4d9512fecb52dc641b6434f31',
            ADAPTER_INSTALLER,
        )
        self.assertIn(
            'select(.repository == "observability-prometheus-adapter")',
            ADAPTER_INSTALLER,
        )
        self.assertIn('--set-string "image.tag=$image_tag@$image_digest"', ADAPTER_INSTALLER)
        self.assertNotIn("lightclaw-bj82", ADAPTER_INSTALLER)

    def test_adapter_adopts_only_the_exact_tke_custom_metrics_service(self):
        self.assertIn("ACTOR_PROMETHEUS_ADAPTER_ADOPT_TKE_APISERVICE", ADAPTER_INSTALLER)
        self.assertIn('spec.service.namespace == "kube-system"', ADAPTER_INSTALLER)
        self.assertIn('spec.service.name == "hpa-metrics-service"', ADAPTER_INSTALLER)
        self.assertIn('fleet.actor.dev/adopted-uid="$adopted_uid"', ADAPTER_INSTALLER)
        self.assertIn('{op:"test",path:"/spec/service/name",value:"hpa-metrics-service"}', ADAPTER_INSTALLER)
        self.assertIn('stableObservationSeconds:60', ADAPTER_INSTALLER)
        self.assertIn('uidPreserved:true', ADAPTER_INSTALLER)
        self.assertIn('actor-prometheus-adapter-apiservice-adoption/v1', ADAPTER_INSTALLER)

    def test_observability_install_converges_adapter_after_prometheus(self):
        prometheus_ready = INSTALLER.index('pod -l app.kubernetes.io/name=prometheus')
        adapter_install = INSTALLER.index('"$script_dir/install-prometheus-adapter.sh"')
        self.assertLess(prometheus_ready, adapter_install)

    def test_offline_adapter_digest_matches_its_installer(self):
        checksum = "aa6752b6207ed788522714c3ef7f67f27d423eb4d9512fecb52dc641b6434f31"
        self.assertIn(checksum, INSTALLER)
        self.assertIn(checksum, ADAPTER_INSTALLER)
        self.assertLess(INSTALLER.index("adapter_sha="), INSTALLER.index('apply -f "$script_dir/namespace-storage.yaml"'))

    def test_incomplete_offline_inputs_fail_before_cluster_or_helm_mutation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            binaries = root / "bin"
            binaries.mkdir()
            for command in ("helm", "kubectl", "jq"):
                executable = binaries / command
                executable.write_text(f'#!/bin/sh\ntouch "{root}/mutated"\nexit 42\n')
                executable.chmod(0o755)
            archive = root / "main.tgz"
            archive.write_bytes(b"fixture")
            inventory = root / "images.json"
            inventory.write_text("{}")
            environment = {
                **os.environ,
                "PATH": f"{binaries}:{os.environ['PATH']}",
                "ACTOR_REGION": "ap-beijing",
                "ACTOR_CLUSTER_NAME": "actor-bj-a01",
                "ACTOR_IMAGE_INVENTORY": str(inventory),
                "ACTOR_OBSERVABILITY_CHART_ARCHIVE": str(archive),
            }
            cases = [
                ("", "requires ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE"),
                (str(root / "missing"), "absolute regular non-symlink file"),
                (str(archive), "archive SHA-256 mismatch"),
            ]
            for adapter, message in cases:
                with self.subTest(adapter=adapter):
                    environment["ACTOR_PROMETHEUS_ADAPTER_CHART_ARCHIVE"] = adapter
                    result = subprocess.run(
                        ["bash", str(Path(__file__).with_name("install.sh"))],
                        env=environment, capture_output=True, text=True,
                    )
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn(message, result.stderr)
                    self.assertFalse((root / "mutated").exists())


if __name__ == "__main__":
    unittest.main()
