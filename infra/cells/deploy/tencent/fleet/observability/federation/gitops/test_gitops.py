#!/usr/bin/env python3

import importlib.util, json, pathlib, tempfile, unittest
import yaml

ROOT = pathlib.Path(__file__).resolve().parent


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


RENDER = module("observability_render", ROOT / "render-desired-state.py")
APPLICATION = module("observability_application", ROOT / "render-application.py")


class GitOpsTest(unittest.TestCase):
    def test_project_is_exact_and_cannot_write_secrets(self):
        project, application = APPLICATION.render(
            "http://actor-git.actor-git-system.svc.cluster.local:3000/release-publisher/fleet-desired.git",
            "a" * 40,
        )
        self.assertNotIn({"group": "*", "kind": "*"}, project["spec"]["clusterResourceWhitelist"])
        self.assertTrue(all(item["kind"] != "Secret" for item in project["spec"]["namespaceResourceWhitelist"]))
        self.assertTrue(application["spec"]["syncPolicy"]["automated"]["selfHeal"])

    def test_renderer_excludes_scrape_secret_and_rejects_unknown_kind(self):
        documents = [
            {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "mesh-observability"}},
            {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "dashboard", "namespace": "mesh-observability"}},
            {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "actor-mesh-observability-prometheus-scrape-confg", "namespace": "mesh-observability"}},
        ]
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = pathlib.Path(temporary); source = root / "source.yaml"
            source.write_text(yaml.safe_dump_all(documents))
            value = RENDER.render([source], root / "desired", root / "receipt.json")
            self.assertEqual(2, value["resourceCount"])
            rendered = list(yaml.safe_load_all((root / "desired" / "hub.yaml").read_text()))
            self.assertTrue(all(item["kind"] != "Secret" for item in rendered))
            documents[1]["kind"] = "DaemonSet"; source.write_text(yaml.safe_dump_all(documents))
            with self.assertRaisesRegex(ValueError, "unexpected namespaced"):
                RENDER.render([source], root / "bad", root / "bad.json")

    def test_renderer_accepts_only_the_exact_adapter_delegation(self):
        documents = [
            {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "actor-mesh-observability-prometheus-scrape-confg", "namespace": "mesh-observability"}},
            {"apiVersion": "apiregistration.k8s.io/v1beta1", "kind": "APIService", "metadata": {"name": "v1beta1.custom.metrics.k8s.io"}},
            {"apiVersion": "rbac.authorization.k8s.io/v1", "kind": "RoleBinding", "metadata": {"name": "prometheus-adapter-auth-reader", "namespace": "kube-system"}},
        ]
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = pathlib.Path(temporary); source = root / "source.yaml"
            source.write_text(yaml.safe_dump_all(documents))
            value = RENDER.render([source], root / "desired", root / "receipt.json")
            self.assertEqual(value["resourceCount"], 2)
            documents[-1]["metadata"]["name"] = "rogue-binding"
            source.write_text(yaml.safe_dump_all(documents))
            with self.assertRaisesRegex(ValueError, "unexpected namespaced"):
                RENDER.render([source], root / "bad", root / "bad.json")

    def test_renderer_updates_secret_free_desired_state_through_prior_receipt(self):
        documents = [
            {"apiVersion": "v1", "kind": "Namespace", "metadata": {"name": "mesh-observability"}},
            {"apiVersion": "v1", "kind": "ConfigMap", "metadata": {"name": "dashboard", "namespace": "mesh-observability"}},
            {"apiVersion": "v1", "kind": "Secret", "metadata": {"name": "actor-mesh-observability-prometheus-scrape-confg", "namespace": "mesh-observability"}},
        ]
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = pathlib.Path(temporary); source = root / "source.yaml"
            source.write_text(yaml.safe_dump_all(documents))
            first = RENDER.render([source], root / "first", root / "first.json")
            extension = root / "extension.yaml"
            extension.write_text(yaml.safe_dump({
                "apiVersion": "monitoring.coreos.com/v1", "kind": "ServiceMonitor",
                "metadata": {"name": "workers-api", "namespace": "mesh-observability"},
            }))
            second = RENDER.render(
                [root / "first" / "hub.yaml", extension], root / "second", root / "second.json",
                root / "first.json",
            )
            self.assertEqual(first["resourceCount"] + 1, second["resourceCount"])
            self.assertEqual(
                second["priorRenderReceiptSha256"],
                RENDER.digest((root / "first.json").read_bytes()),
            )
            self.assertIn("actor-mesh-observability-prometheus-scrape-confg", second["excludedSecrets"])

            (root / "first" / "hub.yaml").write_text("---\napiVersion: v1\nkind: Namespace\nmetadata:\n  name: tampered\n")
            with self.assertRaisesRegex(ValueError, "not bound by its render receipt"):
                RENDER.render(
                    [root / "first" / "hub.yaml", extension], root / "bad", root / "bad.json",
                    root / "first.json",
                )


if __name__ == "__main__": unittest.main()
