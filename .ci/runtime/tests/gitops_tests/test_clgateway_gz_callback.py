from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]
CALLBACK_BASE_URL_ENV = "CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_BASE_URL"


class CloudLadderGZCallbackTests(unittest.TestCase):
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


if __name__ == "__main__":
    unittest.main()
