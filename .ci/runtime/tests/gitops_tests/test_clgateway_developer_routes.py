from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]
CLGATEWAY = REPO_ROOT / "argocd/services/cloudladdergateway"
AUTH = REPO_ROOT / "argocd/services/lightclaw-auth"
SERVICE_GATEWAY = REPO_ROOT / "argocd/services/service-gateway"
WORKLOAD_NAMESPACE = "ns-prjqt8dd-867795-production"


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
        environments = {
            "tkexgz": (
                "devtunnel",
                "https://api-sandbox-bj-7.lightclaw.tech",
                "9.0.0.0/8,21.0.0.0/8",
            ),
            "tkexsg": (
                "devtunnel",
                "https://api-sandbox-kr-1.lightclaw.tech",
                "9.0.0.0/8,21.0.0.0/8,14.22.11.160/29,14.116.239.32/29",
            ),
        }
        for region, (delivery_mode, registry_base_url, allowed_cidrs) in environments.items():
            with self.subTest(region=region):
                testing = load(CLGATEWAY / region / "statefulsetplus-testing.yaml")
                pod_spec = testing["spec"]["template"]["spec"]
                self.assertNotIn("serviceAccountName", pod_spec)
                env = container_env(testing, "CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_")
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_ENABLED"], "true")
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_STORE"], "http")
                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_REGISTRY_BASE_URL"],
                    registry_base_url,
                )
                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_REGISTRY_SECRET_ENV"],
                    "CLOUDLADDER_SHADOW_HMAC_SECRET",
                )
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_DELIVERY_MODE"], delivery_mode)
                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_TUNNEL_BASE_URL"],
                    f"http://devtunnel-testing.{WORKLOAD_NAMESPACE}.svc.cluster.local:8080",
                )
                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_TUNNEL_HOST_SUFFIX"],
                    "cn.tunnel.internal" if region == "tkexgz" else "sg.tunnel.internal",
                )
                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_TUNNEL_TOKEN_ENV"],
                    "DEVTUNNEL_TOKEN",
                )
                self.assertEqual(env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_ROUTE_ID"], "jifei-callback")
                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_REGISTRATION_ROUTE"],
                    "developer-route-control",
                )
                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_REGISTRATION_CALLER"],
                    "lightclaw-auth",
                )
                self.assertNotIn("CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_LEASE_NAMESPACE", env)
                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_DEVELOPER_ROUTES_ALLOWED_CIDRS"],
                    allowed_cidrs,
                )
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

    def test_http_registry_removes_tkex_rbac_dependency(self) -> None:
        for region in ("tkexgz", "tkexsg"):
            with self.subTest(region=region):
                path = CLGATEWAY / region / "developer-route-rbac-testing.yaml"
                self.assertFalse(path.exists())
                kustomization = load(CLGATEWAY / region / "kustomization.yaml")
                self.assertNotIn(path.name, kustomization["resources"])

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

    def test_testing_hubs_use_the_matching_capability_registry(self) -> None:
        environments = {
            "tkexgz": ("https://api-sandbox-bj-7.lightclaw.tech", "cn.tunnel.internal"),
            "tkexsg": ("https://api-sandbox-kr-1.lightclaw.tech", "sg.tunnel.internal"),
        }
        for region, (registry_base_url, tunnel_suffix) in environments.items():
            with self.subTest(region=region):
                devtunnel = next(
                    doc
                    for doc in load_all(CLGATEWAY / region / "devtunnel-testing.yaml")
                    if doc["kind"] == "StatefulSetPlus"
                )
                pod_spec = devtunnel["spec"]["template"]["spec"]
                self.assertNotIn("serviceAccountName", pod_spec)
                env = container_env(devtunnel, "DEVTUNNEL_CAPABILITY_")
                self.assertEqual(env["DEVTUNNEL_CAPABILITY_REGISTRY_ENABLED"], "true")
                self.assertEqual(env["DEVTUNNEL_CAPABILITY_STORE"], "http")
                self.assertEqual(env["DEVTUNNEL_CAPABILITY_REGISTRY_BASE_URL"], registry_base_url)
                self.assertEqual(
                    env["DEVTUNNEL_CAPABILITY_REGISTRY_SECRET_ENV"],
                    "CLOUDLADDER_SHADOW_HMAC_SECRET",
                )
                self.assertNotIn("DEVTUNNEL_CAPABILITY_LEASE_NAMESPACE", env)
                self.assertEqual(env["DEVTUNNEL_CAPABILITY_TUNNEL_HOST_SUFFIX"], tunnel_suffix)

                all_env = pod_spec["containers"][0]["env"]
                hmac = next(item for item in all_env if item["name"] == "CLOUDLADDER_SHADOW_HMAC_SECRET")
                self.assertEqual(
                    hmac["valueFrom"]["secretKeyRef"],
                    {"key": "CLOUDLADDER_SHADOW_HMAC_SECRET", "name": "cloudladdergateway-runtime-secrets"},
                )

    def test_sandbox_auth_and_gateway_preserve_server_derived_uin(self) -> None:
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
                self.assertEqual(config["PERSONAL_DEV_ACCOUNT_LEASE_ENABLED"], "true")
                self.assertEqual(config["PERSONAL_DEV_ACCOUNT_LEASE_ENVIRONMENT"], environment)
                self.assertRegex(config["PERSONAL_DEV_ACCOUNT_POOL_USER_IDS"], r"^usr_[a-z0-9]+(?:,usr_[a-z0-9]+)*$")
                self.assertEqual(
                    config["PERSONAL_DEV_ACCOUNT_LEASE_SOURCE_CIDRS"],
                    "9.0.0.0/8,21.0.0.0/8,14.22.11.160/27,14.116.239.32/27",
                )
                self.assertEqual(
                    config["PERSONAL_DEV_ROUTE_EXPLICIT_TARGET_IP_ENABLED"],
                    "true",
                )
                self.assertEqual(config["PERSONAL_DEV_ROUTE_CLOUDLADDER_ROUTE_ID"], "developer-route-control")
                self.assertEqual(config["PERSONAL_DEV_ROUTE_CLOUDLADDER_CALLER"], "lightclaw-auth")
                self.assertEqual(
                    config["PERSONAL_DEV_ROUTE_CLOUDLADDER_GATEWAY_BASE_URL"],
                    testing_gateway,
                )

                gateway = load(SERVICE_GATEWAY / environment / "config.yaml")
                self.assertIn("100.64.0.0/10", gateway.get("trusted_proxy_cidrs") or [])
                auth_route = next(route for route in gateway["routes"] if route["name"] == "auth")
                public = {(item["method"], item["path"]) for item in auth_route["public_allow"]}
                self.assertTrue(
                    {
                        ("GET", "/auth/internal/dev-environments/registration/ready"),
                        ("GET", "/auth/internal/dev-environments/registration"),
                        ("PUT", "/auth/internal/dev-environments/registration"),
                        ("DELETE", "/auth/internal/dev-environments/registration"),
                        ("POST", "/auth/dev-environments/account-lease"),
                        ("DELETE", "/auth/dev-environments/account-lease"),
                    }.issubset(public)
                )


if __name__ == "__main__":
    unittest.main()
