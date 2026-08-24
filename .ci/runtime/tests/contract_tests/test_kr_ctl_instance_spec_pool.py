import textwrap
import tomllib
import unittest
from pathlib import Path


REPO_ROOT = next(
    parent
    for parent in Path(__file__).resolve().parents
    if (parent / "ctl").is_dir() and (parent / "argocd").is_dir()
)
KR_CTL_REWRITE = REPO_ROOT / "argocd/services/ctl/sandbox-kr-1/patch-ctl-conf-rewrite.yaml"


class KoreaCtlInstanceSpecPoolContractTests(unittest.TestCase):
    def test_two_core_bundle_has_an_explicit_seoul_pool_mapping(self) -> None:
        manifest = KR_CTL_REWRITE.read_text()
        marker = "  server_conf_rewrite.toml: |\n"
        self.assertIn(marker, manifest)

        toml_payload = textwrap.dedent(manifest.split(marker, 1)[1])
        config = tomllib.loads(toml_payload)
        instance = config["api"]["instance"]

        self.assertEqual(instance["default_template_class_id"], "openclaw-default")
        self.assertEqual(instance["default_sku_id"], "sku-hermes-2c4g")
        self.assertEqual(
            instance["spec_pools"],
            [
                {
                    "spec_id": "spec-2c4g50g",
                    "sku_id": "sku-hermes-2c4g",
                    "default_template_id": "pool-kr-2c4g-01",
                    "candidate_template_ids": ["pool-kr-2c4g-01"],
                }
            ],
        )


if __name__ == "__main__":
    unittest.main()
