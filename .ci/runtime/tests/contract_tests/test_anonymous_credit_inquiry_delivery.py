import unittest
from pathlib import Path

import yaml


REPO_ROOT = next(
    parent
    for parent in Path(__file__).resolve().parents
    if (parent / ".ci/runtime").is_dir()
)


def load_env(path: Path) -> dict[str, str]:
    values = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#"):
            key, value = line.split("=", 1)
            values[key] = value
    return values


class AnonymousCreditInquiryDeliveryTest(unittest.TestCase):
    environments = {
        "sandbox-bj-7": "cn",
        "beijing-sandbox": "cn",
        "shprod": "cn",
        "sandbox-jp-1": "intl",
        "sgprod": "intl",
    }

    def test_credit_inquiry_is_the_only_anonymous_business_operation(self) -> None:
        expected = {
            ("POST", "/v1/credit/inquiry"),
            ("POST", "/v1/credit/packages/order-url"),
        }
        for environment in self.environments:
            with self.subTest(environment=environment):
                config = yaml.safe_load(
                    (
                        REPO_ROOT
                        / "argocd/services/service-gateway"
                        / environment
                        / "config.yaml"
                    ).read_text()
                )
                route = next(
                    item for item in config["routes"] if item["name"] == "credit"
                )
                actual = {
                    (item["method"], item["path"])
                    for item in route["optional_auth_allow"]
                }
                self.assertEqual(actual, expected)

    def test_anonymous_inquiry_environments_have_regional_fallback_identity(self) -> None:
        for environment, site_kind in self.environments.items():
            with self.subTest(environment=environment):
                values = load_env(
                    REPO_ROOT
                    / "argocd/services/trade"
                    / environment
                    / "trade-platform.env"
                )
                self.assertEqual(values["TRADE_SITE_KIND"], site_kind)
                self.assertTrue(values["TRADE_INQUIRY_FALLBACK_UIN"])
                self.assertTrue(values["TRADE_INQUIRY_FALLBACK_APP_ID"])


if __name__ == "__main__":
    unittest.main()
