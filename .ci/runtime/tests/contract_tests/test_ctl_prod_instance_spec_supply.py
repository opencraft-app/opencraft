from pathlib import Path
import tomllib
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]


class CtlProductionInstanceSpecSupplyTests(unittest.TestCase):
    def test_shprod_and_sgprod_route_historical_specs_to_upgraded_supply(self) -> None:
        expected = {
            "spec-2c4g50g": ("openclaw-2c8g50g", "sku-hermes-2c8g50g"),
            "spec-4c8g80g": ("openclaw-4c16g80g", "sku-hermes-4c16g80g"),
        }

        for env in ("shprod", "sgprod"):
            with self.subTest(env=env):
                manifest = yaml.safe_load(
                    (
                        REPO_ROOT
                        / "argocd/services/ctl"
                        / env
                        / "ctl-conf-rewrite.yaml"
                    ).read_text()
                )
                config = tomllib.loads(manifest["data"]["server_conf_rewrite.toml"])
                mappings = {
                    item["spec_id"]: (
                        item.get("template_class_id", ""),
                        item.get("sku_id", ""),
                    )
                    for item in config["api"]["instance"]["spec_pools"]
                }

                for spec_id, target in expected.items():
                    self.assertEqual(mappings.get(spec_id), target)


if __name__ == "__main__":
    unittest.main()
