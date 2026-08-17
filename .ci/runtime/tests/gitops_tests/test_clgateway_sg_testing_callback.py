from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]


class CloudLadderSGCallbackTests(unittest.TestCase):
    def callback_base_urls(self, filename: str) -> dict[str, str]:
        manifest = yaml.safe_load(
            (
                REPO_ROOT
                / "argocd/services/cloudladdergateway/tkexsg"
                / filename
            ).read_text()
        )
        env = {
            item["name"]: item.get("value")
            for item in manifest["spec"]["template"]["spec"]["containers"][0][
                "env"
            ]
            if item["name"].startswith("CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK")
        }
        self.assertEqual(len(env), 7)
        return env

    def test_sg_prod_callbacks_target_jp_api(self) -> None:
        self.assertEqual(
            set(self.callback_base_urls("statefulsetplus.yaml").values()),
            {"https://api-sandbox-jp-1.lightclaw.tech"},
        )

    def test_sg_testing_callbacks_stay_on_kr_api(self) -> None:
        self.assertEqual(
            set(self.callback_base_urls("statefulsetplus-testing.yaml").values()),
            {"https://api-sandbox-kr-1.lightclaw.tech"},
        )


if __name__ == "__main__":
    unittest.main()
