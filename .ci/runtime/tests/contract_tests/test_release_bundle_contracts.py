import json
import re
import subprocess
import sys
import unittest
from pathlib import Path

import yaml


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.bundles import load_bundle, load_manifest, require_build_metadata  # noqa: E402
from contracts.release_bundle_manifest import dump_manifest, merge_bundle_sources  # noqa: E402


SANDBOX_ENV = "beijing-sandbox-2"
PLAYGROUND_ENV = "sandbox-bj-7"
AUTO_RELEASE_WORKFLOWS = {
    "admin-gateway": (".ci/admin-gateway.yml", "beijing-sandbox,shprod,sgprod", "admin-gateway"),
    "ai-gateway": (".ci/ai-gateway.yml", "beijing-sandbox,shprod,sgprod", "ai-gateway"),
    "ctl": (".ci/ctl.yml", "beijing-sandbox,shprod,sgprod", "ctl"),
    "gateway-dashboard": (".ci/gateway-dashboard.yml", "beijing-sandbox,shprod,sgprod", "gateway-dashboard"),
    "nextgen-dashboard": (".ci/nextgen-dashboard.yml", "beijing-sandbox,shprod,sgprod", "nextgen-dashboard"),
    "payment": (".ci/payment.yml", "beijing-sandbox,shprod,sgprod", "payment"),
    "sandbox": (".ci/sandbox.yml", "beijing-sandbox,sgprod", "sandbox"),
    "service-gateway": (".ci/service-gateway.yml", "beijing-sandbox,shprod,sgprod", "service-gateway"),
    "subscription": (".ci/subscription.yml", "beijing-sandbox,shprod,sgprod", "subscription"),
    "user-auth": (".ci/lightclaw-auth.yml", "beijing-sandbox,shprod,sgprod", "lightclaw-auth"),
}

BUSINESS_WORKFLOWS = {
    ".ci/admin-gateway.yml",
    ".ci/ai-gateway.yml",
    ".ci/cloudladdergateway.yml",
    ".ci/ctl.yml",
    ".ci/frontend.yml",
    ".ci/gateway-dashboard.yml",
    ".ci/lightclaw-auth.yml",
    ".ci/nextgen-dashboard.yml",
    ".ci/payment.yml",
    ".ci/sandbox.yml",
    ".ci/service-gateway.yml",
    ".ci/staticpages.yml",
    ".ci/subscription.yml",
    ".ci/trade.yml",
}


class ReleaseBundleContractTests(unittest.TestCase):
    def test_release_bundle_manifest_is_generated_from_split_sources(self) -> None:
        rendered = dump_manifest(merge_bundle_sources(RUNTIME_DIR / "bundles"))

        manifest = yaml.safe_load(rendered) or {}
        self.assertIn("bundles", manifest)
        self.assertIn("payment", manifest["bundles"])

        result = subprocess.run(
            ["git", "ls-files", "--error-unmatch", ".ci/runtime/release-bundles.manifest"],
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0, "release-bundles.manifest must not be tracked")

    def test_each_bundle_source_defines_one_bundle(self) -> None:
        for path in sorted((RUNTIME_DIR / "bundles").glob("*.bundle")):
            with self.subTest(path=path.name):
                document = yaml.safe_load(path.read_text()) or {}
                bundles = document.get("bundles") or {}
                if path.name.startswith("_"):
                    self.assertFalse(bundles)
                else:
                    self.assertEqual(list(bundles), [path.stem])

    def test_playground_auto_release_workflows_match_build_contracts(self) -> None:
        manifest = load_manifest()

        for bundle_name, (workflow_path, master_build_envs, pin_targets) in AUTO_RELEASE_WORKFLOWS.items():
            with self.subTest(bundle=bundle_name):
                require_build_metadata(load_bundle(manifest, bundle_name, PLAYGROUND_ENV))
                workflow = self.load_effective_workflow(workflow_path)
                workflow_entry = yaml.safe_load((REPO_ROOT / workflow_path).read_text())
                self.assertIn("playground/sandbox-bj-*", (REPO_ROOT / workflow_path).read_text())
                self.assert_release_entry_targets(
                    workflow_entry,
                    expected_service=bundle_name,
                    expected_pin_targets=pin_targets,
                    expected_master_build_envs=master_build_envs,
                    expected_master_auto_pin_envs="beijing-sandbox",
                    expected_playground_build_envs="auto",
                    expected_playground_auto_pin_envs="auto",
                    workflow_text=(REPO_ROOT / workflow_path).read_text(),
                )
                self.assertIn("build_and_promote_to_gitops.sh", workflow)

    def test_playground_env_reuses_beijing_registry_and_rewrites_gitops_paths(self) -> None:
        manifest = load_manifest()

        bundle = require_build_metadata(load_bundle(manifest, "ai-gateway", PLAYGROUND_ENV))

        self.assertEqual(bundle.image_repo, "lightclaw-bj8.tencentcloudcr.com/lightclaw/ai-gateway")
        self.assertIn(f"argocd/services/ai-gateway/{PLAYGROUND_ENV}/**", bundle.publish_paths)
        self.assertIn(
            f"argocd/catalogs/playground/beijing-playground/{PLAYGROUND_ENV}/ai-gateway.yaml",
            bundle.publish_paths,
        )
        self.assertIn(f"argocd/secrets/{PLAYGROUND_ENV}/ai-gateway-runtime-secrets.sops.yaml", bundle.publish_paths)
        self.assertNotIn("argocd/catalogs/sandbox/beijing-sandbox-2/ai-gateway.yaml", bundle.publish_paths)

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

        for env in ["beijing-sandbox", "beijing-sandbox-2", "sgprod"]:
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

    def test_gateway_release_bundles_are_independent(self) -> None:
        manifest = load_manifest()
        service_bundle = require_build_metadata(load_bundle(manifest, "service-gateway", "shprod"))
        admin_bundle = require_build_metadata(load_bundle(manifest, "admin-gateway", "shprod"))

        self.assertTrue(any(path.startswith("argocd/services/service-gateway/shprod/") for path in service_bundle.publish_paths))
        self.assertFalse(any("admin-gateway" in path for path in service_bundle.publish_paths))
        self.assertTrue(any(path.startswith("argocd/services/admin-gateway/shprod/") for path in admin_bundle.publish_paths))
        self.assertEqual(admin_bundle.image_repo, "lightclaw-shprod.tencentcloudcr.com/lightclaw/admin-gateway")

    def test_frontend_playground_release_uses_beijing_registry(self) -> None:
        manifest = load_manifest()
        bundle = require_build_metadata(load_bundle(manifest, "frontend", PLAYGROUND_ENV))

        self.assertEqual(bundle.image_repo, "lightclaw-bj8.tencentcloudcr.com/lightclaw/frontend")
        self.assertIn(f"argocd/services/frontend/{PLAYGROUND_ENV}/**", bundle.publish_paths)

    def test_frontend_workflow_supports_playground_branch_release(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/frontend.yml").read_text()
        workflow = yaml.safe_load(workflow_text)

        self.assertIn("playground/sandbox-bj-*", workflow_text)
        self.assertIn('PLAYGROUND_ENV="${{ ci.branch }}"', workflow_text)
        self.assertIn('PLAYGROUND_ENV="${PLAYGROUND_ENV#playground/}"', workflow_text)
        self.assertIn('BUILD_ENVS="$(resolve_playground_envs "auto" "$PLAYGROUND_ENV")"', workflow_text)
        self.assertIn('AUTO_PIN_ENVS="$(resolve_playground_envs "auto" "$PLAYGROUND_ENV")"', workflow_text)
        self.assert_release_entry_targets(
            workflow,
            expected_service="frontend",
            expected_pin_targets="frontend",
            workflow_text=workflow_text,
        )

    def test_frontend_preview_uses_master_runtime(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/frontend-preview.yml").read_text()

        self.assertIn('FRONTEND_PREVIEW_RUNTIME_REF="${FRONTEND_PREVIEW_RUNTIME_REF:-origin/master}"', workflow_text)
        self.assertIn("git fetch --no-tags --depth=1 origin master:refs/remotes/origin/master", workflow_text)
        self.assertIn('git archive --format=tar "$FRONTEND_PREVIEW_RUNTIME_REF" .ci', workflow_text)
        self.assertIn('source "$FRONTEND_PREVIEW_RUNTIME_CI_DIR/init.sh"', workflow_text)
        self.assertIn(
            'python3 "$FRONTEND_PREVIEW_RUNTIME_CI_DIR/runtime/commands/upload_staticpages_preview.py"',
            workflow_text,
        )

    def test_frontend_preview_builds_cn_and_intl_with_separate_api_bases(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/frontend-preview.yml").read_text()

        self.assertIn('PREVIEW_CN_AUTH_API_BASE_URL="$(resolve_preview_auth_api_base_url "${{ ci.branch }}" cn)"', workflow_text)
        self.assertIn('PREVIEW_INTL_AUTH_API_BASE_URL="$(resolve_preview_auth_api_base_url "${{ ci.branch }}" intl)"', workflow_text)
        self.assertIn('printf \'https://api.lightvela.ai\'', workflow_text)
        self.assertIn('printf \'https://lightclaw.tech\'', workflow_text)
        self.assertIn('export VITE_AUTH_API_BASE_URL="$PREVIEW_CN_AUTH_API_BASE_URL"', workflow_text)
        self.assertIn('export VITE_AUTH_API_BASE_URL="$PREVIEW_INTL_AUTH_API_BASE_URL"', workflow_text)
        self.assertLess(
            workflow_text.index('export VITE_AUTH_API_BASE_URL="$PREVIEW_CN_AUTH_API_BASE_URL"'),
            workflow_text.index('"$PNPM_BIN" exec vite build --mode cn --outDir dist-cn'),
        )
        self.assertLess(
            workflow_text.index('export VITE_AUTH_API_BASE_URL="$PREVIEW_INTL_AUTH_API_BASE_URL"'),
            workflow_text.index('"$PNPM_BIN" exec vite build --mode global --outDir dist-global'),
        )

    def test_frontend_mr_guard_runs_build_mode_typecheck(self) -> None:
        package_json = json.loads((REPO_ROOT / "frontend/package.json").read_text())
        guard_text = (REPO_ROOT / "frontend/checks/guard.sh").read_text()

        self.assertEqual(package_json["scripts"]["check"], "tsc -b")
        self.assertIn('"$PNPM_BIN" check', guard_text)

    def test_prod_release_bundles_project_exactly_one_direct_app(self) -> None:
        manifest = load_manifest()

        for env in ["shprod", "sgprod"]:
            for bundle_name in sorted((manifest.get("bundles") or {})):
                with self.subTest(env=env, bundle=bundle_name):
                    bundle = load_bundle(manifest, bundle_name, env)
                    direct_services = {
                        parts[2]
                        for path in bundle.publish_paths
                        if (parts := path.split("/"))
                        and len(parts) >= 4
                        and parts[0:2] == ["argocd", "services"]
                        and parts[3] == env
                    }
                    if direct_services:
                        self.assertEqual(
                            len(direct_services),
                            1,
                            f"{bundle_name} {env} bundle must not project unrelated direct apps: {sorted(direct_services)}",
                        )

    def test_gateway_workflows_pin_only_their_own_targets(self) -> None:
        service_workflow = yaml.safe_load((REPO_ROOT / ".ci/service-gateway.yml").read_text())
        admin_workflow = yaml.safe_load((REPO_ROOT / ".ci/admin-gateway.yml").read_text())

        self.assert_release_entry_targets(
            service_workflow,
            expected_service="service-gateway",
            expected_pin_targets="service-gateway",
            expected_master_build_envs="beijing-sandbox,shprod,sgprod",
            expected_master_auto_pin_envs="beijing-sandbox",
            expected_playground_build_envs="auto",
            expected_playground_auto_pin_envs="auto",
        )
        self.assert_release_entry_targets(
            admin_workflow,
            expected_service="admin-gateway",
            expected_pin_targets="admin-gateway",
            expected_master_build_envs="beijing-sandbox,shprod,sgprod",
            expected_master_auto_pin_envs="beijing-sandbox",
            expected_playground_build_envs="auto",
            expected_playground_auto_pin_envs="auto",
        )

    def test_trade_workflow_builds_beijing_and_playground(self) -> None:
        manifest = load_manifest()
        bundle = require_build_metadata(load_bundle(manifest, "trade", "beijing-sandbox"))
        playground_bundle = require_build_metadata(load_bundle(manifest, "trade", PLAYGROUND_ENV))
        workflow = yaml.safe_load((REPO_ROOT / ".ci/trade.yml").read_text())

        self.assertEqual(bundle.image_repo, "lightclaw-bj8.tencentcloudcr.com/lightclaw/trade")
        self.assertEqual(bundle.publish_paths, [])
        self.assertEqual(playground_bundle.image_repo, "lightclaw-bj8.tencentcloudcr.com/lightclaw/trade")
        self.assertIn(f"argocd/services/trade/{PLAYGROUND_ENV}/**", playground_bundle.publish_paths)
        self.assertIn(
            f"argocd/catalogs/playground/beijing-playground/{PLAYGROUND_ENV}/trade.yaml",
            playground_bundle.publish_paths,
        )
        self.assert_release_entry_targets(
            workflow,
            expected_service="trade",
            expected_pin_targets="trade",
            expected_master_build_envs="beijing-sandbox",
            expected_master_auto_pin_envs="none",
            expected_playground_build_envs="auto",
            expected_playground_auto_pin_envs="auto",
        )

    def test_standard_service_extends_stays_on_v2_local_template_contract(self) -> None:
        for workflow_path in sorted(BUSINESS_WORKFLOWS - {".ci/frontend.yml"}):
            workflow = yaml.safe_load((REPO_ROOT / workflow_path).read_text())
            if "extends" not in workflow:
                continue
            with self.subTest(workflow=workflow_path):
                self.assertEqual(workflow.get("version"), "v2.0")
                expected_group = f"mono2-service-release-{Path(workflow_path).stem}"
                self.assertEqual((workflow.get("concurrency") or {}).get("group"), expected_group)
                self.assertIsInstance((workflow.get("extends") or {}).get("template"), str)
                self.assert_release_entry_targets(
                    workflow,
                    expected_service=(workflow.get("extends") or {}).get("parameters", {}).get("SERVICE"),
                    expected_pin_targets=(workflow.get("extends") or {}).get("parameters", {}).get("BUNDLE"),
                )

    def test_local_templates_do_not_use_unsupported_top_level_concurrency(self) -> None:
        for template_path in sorted((REPO_ROOT / ".ci/templates").glob("*.yml")):
            with self.subTest(template=template_path.name):
                template = yaml.safe_load(template_path.read_text()) or {}
                self.assertNotIn("concurrency", template)

    def test_service_release_target_env_default_uses_parameter_directly(self) -> None:
        template_path = REPO_ROOT / ".ci/templates/service-release.yml"
        template_text = template_path.read_text()
        template = yaml.safe_load(template_text) or {}
        target_env = ((template.get("variables") or {}).get("TARGET_ENV") or {}).get("value")

        self.assertEqual(target_env, "${{ parameters.DEFAULT_TARGET_ENV }}")
        self.assertNotRegex(
            template_text,
            r"\$\{\{\s*variables\.(SERVICE|BUNDLE|DISPLAY_NAME|DEFAULT_TARGET_ENV|MASTER_BUILD_ENVS|MASTER_AUTO_PIN_ENVS|PLAYGROUND_BUILD_ENVS|PLAYGROUND_AUTO_PIN_ENVS)\s*\}\}",
        )

    def test_only_ci_runtime_listens_to_ci_file_changes(self) -> None:
        for workflow_path in sorted(REPO_ROOT.glob(".ci/*.yml")):
            workflow = yaml.safe_load(workflow_path.read_text())
            paths = self.push_paths(workflow)
            ci_paths = [path for path in paths if path == ".ci/**" or path.startswith(".ci/")]
            if workflow_path.name == "ci-runtime.yml":
                self.assertIn(".ci/**", ci_paths)
            else:
                self.assertFalse(
                    ci_paths,
                    f"{workflow_path.relative_to(REPO_ROOT)} must not let CI changes trigger a business pipeline: {ci_paths}",
                )

    def test_business_workflows_ignore_owners_only_changes(self) -> None:
        for workflow_path in sorted(BUSINESS_WORKFLOWS):
            with self.subTest(workflow=workflow_path):
                workflow = yaml.safe_load((REPO_ROOT / workflow_path).read_text())
                paths_ignore = self.push_paths_ignore(workflow)
                self.assertIn("OWNERS", paths_ignore)
                self.assertIn("**/OWNERS", paths_ignore)

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

    def push_config(self, workflow_data: dict) -> dict:
        on_config = workflow_data.get(True) or workflow_data.get("on") or {}
        push_config = on_config.get("push") or {}
        return push_config if isinstance(push_config, dict) else {}

    def push_paths(self, workflow_data: dict) -> list[str]:
        paths = self.push_config(workflow_data).get("paths") or []
        return [path for path in paths if isinstance(path, str)]

    def push_paths_ignore(self, workflow_data: dict) -> list[str]:
        paths_ignore = self.push_config(workflow_data).get("paths-ignore") or []
        return [path for path in paths_ignore if isinstance(path, str)]

    def load_effective_workflow(self, workflow_path: str) -> str:
        workflow_file = REPO_ROOT / workflow_path
        workflow_data = yaml.safe_load(workflow_file.read_text())
        template_path = self.extends_template_path(workflow_data)
        if not template_path:
            return workflow_file.read_text()
        return workflow_file.read_text() + "\n" + (REPO_ROOT / template_path).read_text()

    def extends_template_path(self, workflow_data: dict) -> str:
        template = (workflow_data.get("extends") or {}).get("template")
        if isinstance(template, str):
            if "/" not in template:
                return f".ci/templates/{template}"
            return template
        if isinstance(template, dict):
            return str(template.get("path") or "")
        return ""

    def extends_variables(self, workflow_data: dict) -> dict:
        extends = workflow_data.get("extends") or {}
        template = extends.get("template")
        if isinstance(template, dict):
            return template.get("variables") or {}
        return extends.get("parameters") or {}

    def assert_release_entry_targets(
        self,
        workflow_data: dict,
        *,
        expected_service: str,
        expected_pin_targets: str,
        expected_master_build_envs: str | None = None,
        expected_master_auto_pin_envs: str | None = None,
        expected_playground_build_envs: str | None = None,
        expected_playground_auto_pin_envs: str | None = None,
        workflow_text: str | None = None,
    ) -> None:
        variables = self.extends_variables(workflow_data)
        if not variables:
            workflow = workflow_text or yaml.safe_dump(workflow_data, allow_unicode=True, sort_keys=False, width=1000000)
            self.assertIn(
                f"build_and_promote_to_gitops.sh {expected_service} {expected_pin_targets}",
                workflow,
            )
            self.assertIn(
                f"promote_bundle_image_to_gitops.sh {expected_service} {expected_pin_targets}",
                workflow,
            )
            return

        self.assertEqual((workflow_data.get("extends") or {}).get("template"), "service-release.yml")
        self.assertEqual(variables.get("SERVICE"), expected_service)
        self.assertEqual(variables.get("BUNDLE"), expected_pin_targets)
        if expected_master_build_envs is not None:
            self.assertEqual(variables.get("MASTER_BUILD_ENVS"), expected_master_build_envs)
        if expected_master_auto_pin_envs is not None:
            self.assertEqual(variables.get("MASTER_AUTO_PIN_ENVS"), expected_master_auto_pin_envs)
        if expected_playground_build_envs is not None:
            self.assertEqual(variables.get("PLAYGROUND_BUILD_ENVS"), expected_playground_build_envs)
        if expected_playground_auto_pin_envs is not None:
            self.assertEqual(variables.get("PLAYGROUND_AUTO_PIN_ENVS"), expected_playground_auto_pin_envs)

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
