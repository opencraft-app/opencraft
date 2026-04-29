import re
import sys
import unittest
from pathlib import Path

import yaml


REPO_ROOT = Path(__file__).resolve().parents[3]
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.bundles import load_bundle, load_manifest, require_build_metadata  # noqa: E402


SANDBOX_ENV = "beijing-sandbox-2"
AUTO_RELEASE_WORKFLOWS = {
    "ctl": (".ci/ctl.yml", "beijing-sandbox,shprod"),
    "gateway-dashboard": (".ci/gateway-dashboard.yml", "beijing-sandbox,shprod"),
    "payment": (".ci/payment.yml", "beijing-sandbox,shprod"),
    "sandbox": (".ci/sandbox.yml", "beijing-sandbox"),
    "service-gateway": (".ci/service-gateway.yml", "beijing-sandbox,shprod"),
    "subscription": (".ci/subscription.yml", "beijing-sandbox,shprod"),
    "user-auth": (".ci/lightclaw-auth.yml", "beijing-sandbox,shprod"),
}


class ReleaseBundleContractTests(unittest.TestCase):
    def test_sandbox2_auto_release_workflows_match_build_contracts(self) -> None:
        manifest = load_manifest()

        for bundle_name, (workflow_path, master_build_envs) in AUTO_RELEASE_WORKFLOWS.items():
            with self.subTest(bundle=bundle_name):
                require_build_metadata(load_bundle(manifest, bundle_name, SANDBOX_ENV))
                workflow = (REPO_ROOT / workflow_path).read_text()
                self.assertIn("- playground/sandbox-bj-2", workflow)
                self.assertIn(f"build_and_promote_to_gitops.sh {bundle_name}", workflow)
                self.assert_branch_route(
                    workflow,
                    "master",
                    expected_build_envs=master_build_envs,
                    expected_auto_pin_envs="beijing-sandbox",
                )
                self.assert_branch_route(
                    workflow,
                    "playground/sandbox-bj-2",
                    expected_build_envs=SANDBOX_ENV,
                    expected_auto_pin_envs=SANDBOX_ENV,
                )

    def test_sandbox2_catalogs_are_promotable_or_explicitly_exempt(self) -> None:
        manifest = load_manifest()
        actual_catalogs = {
            path.relative_to(REPO_ROOT).as_posix()
            for path in (REPO_ROOT / "argocd/catalogs/sandbox" / SANDBOX_ENV).glob("*.yaml")
        }
        promotable_catalogs = self.promotable_catalogs(manifest)
        exempt_catalogs = set(
            (manifest.get("catalog_publish_exemptions_by_env") or {}).get(SANDBOX_ENV) or {}
        )

        self.assertEqual(actual_catalogs, promotable_catalogs | exempt_catalogs)
        self.assertFalse(promotable_catalogs & exempt_catalogs)

    def test_sandbox2_exempt_catalogs_do_not_have_build_contracts(self) -> None:
        manifest = load_manifest()
        exemptions = (manifest.get("catalog_publish_exemptions_by_env") or {}).get(SANDBOX_ENV) or {}

        for catalog_path, reason in exemptions.items():
            with self.subTest(catalog=catalog_path):
                catalog = yaml.safe_load((REPO_ROOT / catalog_path).read_text())
                bundle_name = self.bundle_for_catalog_service(str(catalog["service"]))
                with self.assertRaisesRegex(ValueError, "does not define docker build inputs"):
                    require_build_metadata(load_bundle(manifest, bundle_name, SANDBOX_ENV))
                self.assertIn("contract", str(reason))

    def test_sandbox_image_targets_match_platform_env_files(self) -> None:
        manifest = load_manifest()

        for env in ["beijing-sandbox", "beijing-sandbox-2"]:
            with self.subTest(env=env):
                bundle = require_build_metadata(load_bundle(manifest, "sandbox", env))
                image_keys = {target.image_key for target in bundle.image_targets}
                platform_env = (REPO_ROOT / f"argocd/services/sandbox/{env}/sandbox-platform.env").read_text()
                env_keys = {
                    line.split("=", 1)[0]
                    for line in platform_env.splitlines()
                    if line and not line.startswith("#") and "=" in line
                }

                self.assertEqual(len(image_keys), 5)
                self.assertTrue(image_keys <= env_keys)

    def test_service_gateway_shprod_bundle_does_not_project_admin_gateway(self) -> None:
        bundle = load_bundle(load_manifest(), "service-gateway", "shprod")

        self.assertTrue(any(path.startswith("argocd/services/service-gateway/shprod/") for path in bundle.publish_paths))
        self.assertFalse(any("admin-gateway" in path for path in bundle.publish_paths))

    def test_service_gateway_shprod_promote_pins_only_service_gateway(self) -> None:
        workflow = (REPO_ROOT / ".ci/service-gateway.yml").read_text()

        self.assertIn('shprod)\n                  PIN_TARGETS="service-gateway"', workflow)
        self.assertIn('bash .ci/runtime/promote_bundle_image_to_gitops.sh service-gateway "$PIN_TARGETS"', workflow)

    def promotable_catalogs(self, manifest: dict) -> set[str]:
        catalogs: set[str] = set()
        for bundle_name, bundle_data in (manifest.get("bundles") or {}).items():
            try:
                require_build_metadata(load_bundle(manifest, bundle_name, SANDBOX_ENV))
            except ValueError:
                continue
            for path in ((bundle_data.get("publish_paths_by_env") or {}).get(SANDBOX_ENV) or []):
                if path.startswith(f"argocd/catalogs/sandbox/{SANDBOX_ENV}/") and path.endswith(".yaml"):
                    catalogs.add(path)
        return catalogs

    def bundle_for_catalog_service(self, catalog_service: str) -> str:
        if catalog_service == "lightclaw-auth":
            return "user-auth"
        return catalog_service

    def assert_branch_route(
        self,
        workflow: str,
        branch: str,
        *,
        expected_build_envs: str,
        expected_auto_pin_envs: str,
    ) -> None:
        pattern = (
            rf"{re.escape(branch)}\)"
            rf".*?BUILD_ENVS=\"{re.escape(expected_build_envs)}\""
            rf".*?AUTO_PIN_ENVS=\"{re.escape(expected_auto_pin_envs)}\""
        )
        self.assertIsNotNone(re.search(pattern, workflow, re.DOTALL))


if __name__ == "__main__":
    unittest.main()
