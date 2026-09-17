from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]
CLGATEWAY = REPO_ROOT / "argocd/services/cloudladdergateway"
AUTH = REPO_ROOT / "argocd/services/lightclaw-auth"
SERVICE_GATEWAY = REPO_ROOT / "argocd/services/service-gateway"
WORKLOAD_NAMESPACE = "ns-prjqt8dd-867795-production"
LEASE_NAMESPACE = WORKLOAD_NAMESPACE


def load(path: Path) -> dict:
    return yaml.safe_load(path.read_text())


def load_all(path: Path) -> list[dict]:
    return list(yaml.safe_load_all(path.read_text()))


def container_env(manifest: dict, prefix: str = "") -> dict[str, object]:
    items = manifest["spec"]["template"]["spec"]["containers"][0]["env"]
    return {
        item["name"]: item.get("value")
        for item in items
        if not prefix or item["name"].startswith(prefix)
    }


class CloudLadderDeveloperRouteTests(unittest.TestCase):
    def test_only_testing_workloads_enable_dynamic_registration(self) -> None:
        delivery_modes = {"tkexgz": "direct", "tkexsg": "devtunnel"}
        for region, delivery_mode in delivery_modes.items():
            with self.subTest(region=region):
                testing = load(CLGATEWAY / region / "statefulsetplus-testing.yaml")
                pod_spec = testing["spec"]["template"]["spec"]
                self.assertEqual(
                    pod_spec["serviceAccountName"],
                    "cloudladdergateway-devroute-testing",
                )
                env = container_env(testing, "CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_")
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_ENABLED"], "true")
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_STORE"], "kubernetes_lease")
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_DELIVERY_MODE"], delivery_mode)
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_ROUTE_ID"], "jifei-callback")
                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_REGISTRATION_ROUTE"],
                    "developer-route-control",
                )
                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_REGISTRATION_CALLER"],
                    "lightclaw-auth",
                )
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_LEASE_NAMESPACE"], LEASE_NAMESPACE)
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_ALLOWED_CIDRS"], "9.0.0.0/8")
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_ALLOWED_PORTS"], "18084")

                production = load(CLGATEWAY / region / "statefulsetplus.yaml")
                self.assertEqual(
                    container_env(production, "CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_"),
                    {},
                )
                self.assertNotEqual(
                    production["spec"]["template"]["spec"].get("serviceAccountName"),
                    "cloudladdergateway-devroute-testing",
                )
                staging_path = CLGATEWAY / region / "statefulsetplus-staging.yaml"
                if staging_path.exists():
                    staging = load(staging_path)
                    self.assertEqual(
                        container_env(staging, "CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_"),
                        {},
                    )

    def test_lease_rbac_stays_in_namespaced_argo_scope_and_cannot_read_secrets(self) -> None:
        for region in ("tkexgz", "tkexsg"):
            with self.subTest(region=region):
                path = CLGATEWAY / region / "developer-route-rbac-testing.yaml"
                docs = {doc["kind"]: doc for doc in load_all(path)}
                self.assertNotIn("Namespace", docs)
                self.assertEqual(docs["ServiceAccount"]["metadata"]["namespace"], WORKLOAD_NAMESPACE)
                self.assertEqual(docs["Role"]["metadata"]["namespace"], WORKLOAD_NAMESPACE)
                self.assertEqual(docs["RoleBinding"]["metadata"]["namespace"], WORKLOAD_NAMESPACE)
                rules = docs["Role"]["rules"]
                self.assertEqual(len(rules), 1)
                self.assertEqual(rules[0]["resources"], ["leases"])
                self.assertEqual(set(rules[0]["verbs"]), {"get", "create", "update"})
                self.assertNotIn("secrets", rules[0]["resources"])
                self.assertEqual(docs["RoleBinding"]["subjects"][0]["namespace"], WORKLOAD_NAMESPACE)
                kustomization = load(CLGATEWAY / region / "kustomization.yaml")
                self.assertIn(path.name, kustomization["resources"])

    def test_static_routes_and_shared_fallbacks_are_preserved(self) -> None:
        expected = {
            "tkexgz": {
                "base": "https://api-sandbox-bj-7.lightclaw.tech",
                "routes": "700003135209=jifei-callback-dev-1",
                "target": "http://9.134.214.121:18084",
            },
            "tkexsg": {
                "base": "https://api-sandbox-kr-1.lightclaw.tech",
                "routes": "450860000013=jifei-callback-dev-1",
                "target": "http://devtunnel-testing.ns-prjqt8dd-867795-production.svc.cluster.local:8080",
            },
        }
        for region, want in expected.items():
            with self.subTest(region=region):
                env = container_env(load(CLGATEWAY / region / "statefulsetplus-testing.yaml"))
                self.assertEqual(env["CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_BASE_URL"], want["base"])
                self.assertEqual(env["CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_UIN_ROUTES"], want["routes"])
                self.assertEqual(env["CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_DEV_1_BASE_URL"], want["target"])

    def test_international_hub_uses_the_same_capability_registry(self) -> None:
        devtunnel = next(
            doc
            for doc in load_all(CLGATEWAY / "tkexsg" / "devtunnel-testing.yaml")
            if doc["kind"] == "StatefulSetPlus"
        )
        pod_spec = devtunnel["spec"]["template"]["spec"]
        self.assertEqual(pod_spec["serviceAccountName"], "cloudladdergateway-devroute-testing")
        env = container_env(devtunnel, "DEVTUNNEL_CAPABILITY_")
        self.assertEqual(env["DEVTUNNEL_CAPABILITY_REGISTRY_ENABLED"], "true")
        self.assertEqual(env["DEVTUNNEL_CAPABILITY_LEASE_NAMESPACE"], LEASE_NAMESPACE)
        self.assertEqual(env["DEVTUNNEL_CAPABILITY_TUNNEL_HOST_SUFFIX"], "sg.tunnel.internal")

    def test_sandbox_auth_and_gateway_preserve_the_server_derived_identity(self) -> None:
        environments = {
            "sandbox-bj-7": ("patch-shadowbinding.yaml", "http://1.12.212.56"),
            "sandbox-kr-1": ("patch-shadow-routing.yaml", "http://43.153.246.14"),
        }
        for environment, (patch_name, testing_gateway) in environments.items():
            with self.subTest(environment=environment):
                auth_docs = load_all(AUTH / environment / patch_name)
                config = next(doc for doc in auth_docs if doc["kind"] == "ConfigMap")["data"]
                self.assertEqual(config["PERSONAL_DEV_ROUTE_CONTROL_ENABLED"], "true")
                self.assertEqual(config["PERSONAL_DEV_ROUTE_CONTROL_ENVIRONMENT"], environment)
                self.assertEqual(config["PERSONAL_DEV_ROUTE_CLOUDLADDER_ROUTE_ID"], "developer-route-control")
                self.assertEqual(config["PERSONAL_DEV_ROUTE_CLOUDLADDER_CALLER"], "lightclaw-auth")
                self.assertEqual(
                    config["PERSONAL_DEV_ROUTE_CLOUDLADDER_GATEWAY_BASE_URL"],
                    testing_gateway,
                )

                gateway = load(SERVICE_GATEWAY / environment / "config.yaml")
                self.assertIn("100.64.0.0/10", gateway.get("trusted_proxy_cidrs") or [])


if __name__ == "__main__":
    unittest.main()
