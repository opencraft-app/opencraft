from pathlib import Path
import unittest

import yaml


REPO_ROOT = Path(__file__).resolve().parents[4]


class TradeMigrationHookTests(unittest.TestCase):
    def test_bj7_trade_migration_is_managed_by_release_pipeline(self) -> None:
        service_dir = REPO_ROOT / "argocd/services/trade/sandbox-bj-7"
        kustomization = yaml.safe_load((service_dir / "kustomization.yaml").read_text())

        self.assertNotIn("trade-migration-job.yaml", kustomization.get("resources", []))
        self.assertFalse((service_dir / "trade-migration-job.yaml").exists())

    def test_kr_trade_migration_is_recreated_for_each_sync(self) -> None:
        manifest_path = REPO_ROOT / "argocd/services/trade/sandbox-kr-1/trade-migration-job.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())
        annotations = manifest["metadata"].get("annotations", {})

        self.assertEqual(annotations.get("argocd.argoproj.io/hook"), "PreSync")
        self.assertEqual(
            annotations.get("argocd.argoproj.io/hook-delete-policy"),
            "BeforeHookCreation,HookSucceeded",
        )


if __name__ == "__main__":
    unittest.main()
