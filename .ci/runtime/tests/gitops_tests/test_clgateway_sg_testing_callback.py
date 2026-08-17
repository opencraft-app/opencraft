from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]


class CloudLadderSGCallbackTests(unittest.TestCase):
    def test_jp_callback_targets_jp_staging_api(self) -> None:
        for filename in ("statefulsetplus.yaml", "statefulsetplus-testing.yaml"):
            with self.subTest(filename=filename):
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
                }

                self.assertEqual(
                    env["CLOUDLADDERGATEWAY_ROUTE_JIFEI_CALLBACK_JP_BASE_URL"],
                    "https://api-sandbox-jp-1.lightclaw.tech",
                )


if __name__ == "__main__":
    unittest.main()
