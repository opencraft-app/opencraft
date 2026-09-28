from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]
CALLBACK_BASE_URL_ENV = "CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_BASE_URL"
DIANSHI_ORDER_BASE_URL_ENV = (
    "CLOUDLADDERGATEWAY_BACKEND_DIANSHI_ORDER_BASE_URL"
)


class CloudLadderGZCallbackTests(unittest.TestCase):
    def workload_env(self, filename: str) -> dict[str, str | None]:
        manifest = yaml.safe_load(
            (
                REPO_ROOT
                / "argocd/services/cloudladdergateway/tkexgz"
                / filename
            ).read_text()
        )
        return {
            item["name"]: item.get("value")
            for item in manifest["spec"]["template"]["spec"]["containers"][0][
                "env"
            ]
        }

    def test_only_gz_prod_enables_required_cloudladder_auth(self) -> None:
        prod = self.workload_env("statefulsetplus.yaml")
        staging = self.workload_env("statefulsetplus-staging.yaml")
        testing = self.workload_env("statefulsetplus-testing.yaml")

        self.assertEqual(prod["CLOUDLADDERGATEWAY_AUTH_MODE"], "required")
        self.assertNotIn(
            "CLOUDLADDERGATEWAY_AUTH_ALLOW_UNAUTHENTICATED_APPEND", prod
        )
        self.assertNotIn("CLOUDLADDERGATEWAY_AUTH_MODE", staging)
        self.assertNotIn("CLOUDLADDERGATEWAY_AUTH_MODE", testing)

    def callback_base_url(self, filename: str) -> str:
        manifest = yaml.safe_load(
            (
                REPO_ROOT
                / "argocd/services/cloudladdergateway/tkexgz"
                / filename
            ).read_text()
        )
        env = manifest["spec"]["template"]["spec"]["containers"][0]["env"]
        return next(
            item["value"]
            for item in env
            if item["name"] == CALLBACK_BASE_URL_ENV
        )

    def test_prod_callback_targets_beijing(self) -> None:
        self.assertEqual(
            self.callback_base_url("statefulsetplus.yaml"),
            "https://lightclaw.tech",
        )

    def test_staging_callback_targets_beijing(self) -> None:
        self.assertEqual(
            self.callback_base_url("statefulsetplus-staging.yaml"),
            "https://lightclaw.tech",
        )

    def test_testing_callback_targets_beijing7(self) -> None:
        self.assertEqual(
            self.callback_base_url("statefulsetplus-testing.yaml"),
            "https://api-sandbox-bj-7.lightclaw.tech",
        )

    def test_only_staging_routes_dianshi_order_to_pre_release(self) -> None:
        prod = self.workload_env("statefulsetplus.yaml")
        staging = self.workload_env("statefulsetplus-staging.yaml")
        testing = self.workload_env("statefulsetplus-testing.yaml")

        self.assertEqual(
            staging[DIANSHI_ORDER_BASE_URL_ENV],
            "http://opc-dianshi-activity.pre-release.polaris:80",
        )
        self.assertNotIn(DIANSHI_ORDER_BASE_URL_ENV, prod)
        self.assertNotIn(DIANSHI_ORDER_BASE_URL_ENV, testing)


if __name__ == "__main__":
    unittest.main()
