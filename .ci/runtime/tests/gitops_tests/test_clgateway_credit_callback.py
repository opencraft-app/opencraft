from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]
CALLBACK_REGIONS = ["BJ", "SH", "GZ", "CD", "NJ", "HK", "JP", "KR", "JKT", "SG", "TH"]
BEIJING_PREPROD_BASE_URL = "https://lightclaw.tech"
SHANGHAI_PRODUCTION_BASE_URL = "https://api.lightvela.com"
TOKYO_SANDBOX_BASE_URL = "https://api-sandbox-jp-1.lightclaw.tech"
SINGAPORE_PRODUCTION_BASE_URL = "https://api.lightvela.ai"


class CloudLadderCreditCallbackTests(unittest.TestCase):
    def assert_credit_callback_targets(
        self, relative_path: str, expected_by_region: dict[str, str]
    ) -> None:
        manifest = yaml.safe_load((REPO_ROOT / relative_path).read_text())
        env = manifest["spec"]["template"]["spec"]["containers"][0]["env"]
        values = {item["name"]: item.get("value") for item in env}

        self.assertEqual(set(expected_by_region), set(CALLBACK_REGIONS))
        for region, expected_base_url in expected_by_region.items():
            key = f"CLOUDLADDERGATEWAY_ROUTE_JIFEI_CREDIT_CALLBACK_{region}_BASE_URL"
            with self.subTest(manifest=relative_path, region=region):
                self.assertEqual(values.get(key), expected_base_url)

    def test_domestic_production_credit_callbacks_target_regional_environments(self) -> None:
        expected = dict.fromkeys(CALLBACK_REGIONS, BEIJING_PREPROD_BASE_URL)
        expected["SH"] = SHANGHAI_PRODUCTION_BASE_URL
        self.assert_credit_callback_targets(
            "argocd/services/cloudladdergateway/tkexgz/statefulsetplus.yaml", expected
        )

    def test_international_production_credit_callbacks_target_regional_environments(self) -> None:
        expected = dict.fromkeys(CALLBACK_REGIONS, TOKYO_SANDBOX_BASE_URL)
        expected["SG"] = SINGAPORE_PRODUCTION_BASE_URL
        self.assert_credit_callback_targets(
            "argocd/services/cloudladdergateway/tkexsg/statefulsetplus.yaml", expected
        )


if __name__ == "__main__":
    unittest.main()
