from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]


class CtlSgprodTradeContractTests(unittest.TestCase):
    def test_sgprod_ctl_declares_trade_adapter_and_dedicated_token(self) -> None:
        rewrite = yaml.safe_load(
            (REPO_ROOT / "argocd/services/ctl/sgprod/ctl-conf-rewrite.yaml").read_text()
        )
        rewrite_toml = rewrite["data"]["server_conf_rewrite.toml"]
        self.assertIn("[adapter.trade]", rewrite_toml)
        self.assertIn('base_url = "http://trade.trade.svc.cluster.local"', rewrite_toml)
        self.assertIn("timeout = 55", rewrite_toml)

        manifest = yaml.safe_load(
            (REPO_ROOT / "scripts/ssm_manifest.ctl.sgprod.yaml").read_text()
        )
        runtime_items = [
            item for item in manifest["items"] if item["id"] == "ctl-runtime-secrets"
        ]
        self.assertEqual(len(runtime_items), 1)
        runtime_item = runtime_items[0]
        self.assertEqual(runtime_item.get("version_id"), "v5")
        self.assertIn("CTL_TRADE_TOKEN", runtime_item.get("required_keys", []))
        self.assertIn(
            "LIGHTCLAW_INTERNAL_SERVICE_TOKEN",
            runtime_item.get("required_keys", []),
        )

        runtime_secret = yaml.safe_load(
            (
                REPO_ROOT
                / "argocd/secrets/sgprod/ctl-runtime-secrets.sops.yaml"
            ).read_text()
        )
        self.assertRegex(
            runtime_secret.get("stringData", {}).get("CTL_TRADE_TOKEN", ""),
            r"^ENC\[AES256_GCM,",
        )
        self.assertRegex(
            runtime_secret.get("stringData", {}).get(
                "LIGHTCLAW_INTERNAL_SERVICE_TOKEN", ""
            ),
            r"^ENC\[AES256_GCM,",
        )


if __name__ == "__main__":
    unittest.main()
