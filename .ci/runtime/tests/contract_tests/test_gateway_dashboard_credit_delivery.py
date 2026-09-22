import unittest
from pathlib import Path

import yaml


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


def load_platform_env(environment: str) -> dict[str, str]:
    path = (
        REPO_ROOT
        / "argocd"
        / "services"
        / "gateway-dashboard"
        / environment
        / "gateway-dashboard-platform.env"
    )
    values = {}
    for line in path.read_text().splitlines():
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    return values


class GatewayDashboardCreditDeliveryTest(unittest.TestCase):
    def test_base_maps_required_credit_token(self) -> None:
        documents = list(
            yaml.safe_load_all(
                (REPO_ROOT / "gateway-dashboard/k8s/base/manifests.yaml").read_text()
            )
        )
        deployment = next(
            document
            for document in documents
            if document and document.get("kind") == "Deployment"
        )
        container = next(
            item
            for item in deployment["spec"]["template"]["spec"]["containers"]
            if item["name"] == "dashboard"
        )
        environment = {item["name"]: item for item in container["env"]}
        self.assertEqual(
            environment["CREDIT_INTERNAL_TOKEN"]["valueFrom"]["secretKeyRef"],
            {
                "name": "gateway-dashboard-runtime-secrets",
                "key": "CTL_INTERNAL_TOKEN",
                "optional": False,
            },
        )

    def test_all_credit_environments_define_regional_service_url(self) -> None:
        expected_urls = {
            "beijing-sandbox": "http://credit.credit.svc.cluster.local",
            "shprod": "http://credit.credit.svc.cluster.local",
            "sgprod": "http://credit.credit.svc.cluster.local",
            "sandbox-jp-1": (
                "http://credit.lightvela-playground-sandbox-jp-1.svc.cluster.local"
            ),
        }
        for environment, expected_url in expected_urls.items():
            with self.subTest(environment=environment):
                values = load_platform_env(environment)
                self.assertEqual(
                    values["GATEWAY_DASHBOARD_CREDIT_API_URL"], expected_url
                )

    def test_tokyo_dashboard_ssm_requires_shared_credit_token(self) -> None:
        manifest = yaml.safe_load(
            (REPO_ROOT / "scripts/ssm_manifest.runtime.sandbox-jp-1.yaml").read_text()
        )
        item = next(
            entry
            for entry in manifest["items"]
            if entry["id"] == "gateway-dashboard-runtime-secrets"
        )
        self.assertIn("CTL_INTERNAL_TOKEN", item["required_keys"])
        self.assertEqual(
            item["output_path"],
            "argocd/secrets/sandbox-jp-1/gateway-dashboard-runtime-secrets.sops.yaml",
        )

    def test_gateway_dashboard_bundle_publishes_shared_base_and_tokyo_overlay(self) -> None:
        bundle = yaml.safe_load(
            (REPO_ROOT / ".ci/runtime/bundles/gateway-dashboard.bundle").read_text()
        )["bundles"]["gateway-dashboard"]
        self.assertIn("gateway-dashboard/k8s/base/**", bundle["publish_paths"])
        self.assertIn(
            "argocd/services/gateway-dashboard/{env}/**", bundle["publish_paths"]
        )
        self.assertIn(
            "argocd/secrets/{env}/gateway-dashboard-runtime-secrets.sops.yaml",
            bundle["publish_paths"],
        )


if __name__ == "__main__":
    unittest.main()
