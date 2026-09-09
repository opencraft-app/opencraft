from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]
CALLBACK_REGIONS = ["BJ", "SH", "GZ", "CD", "NJ", "HK", "JP", "KR", "JKT", "SG", "TH"]
BEIJING_PREPROD_BASE_URL = "https://lightclaw.tech"


class CloudLadderCreditCallbackTests(unittest.TestCase):
    def assert_credit_callbacks_target_beijing(self, relative_path: str) -> None:
        manifest = yaml.safe_load((REPO_ROOT / relative_path).read_text())
        env = manifest["spec"]["template"]["spec"]["containers"][0]["env"]
        values = {item["name"]: item.get("value") for item in env}

        for region in CALLBACK_REGIONS:
            key = f"CLOUDLADDERGATEWAY_ROUTE_JIFEI_CREDIT_CALLBACK_{region}_BASE_URL"
            with self.subTest(manifest=relative_path, region=region):
                self.assertEqual(values.get(key), BEIJING_PREPROD_BASE_URL)

    def test_domestic_production_credit_callbacks_target_beijing(self) -> None:
        self.assert_credit_callbacks_target_beijing(
            "argocd/services/cloudladdergateway/tkexgz/statefulsetplus.yaml"
        )

    def test_international_production_credit_callbacks_target_beijing(self) -> None:
        self.assert_credit_callbacks_target_beijing(
            "argocd/services/cloudladdergateway/tkexsg/statefulsetplus.yaml"
        )


if __name__ == "__main__":
    unittest.main()
