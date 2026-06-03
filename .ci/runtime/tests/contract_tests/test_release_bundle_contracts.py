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
KOREA_PLAYGROUND_ENV = "sandbox-kr-1"
AUTO_RELEASE_WORKFLOWS = {
    "admin-gateway": (".ci/admin-gateway.yml", "beijing-sandbox,shprod,sgprod", "admin-gateway"),
    "ai-gateway": (".ci/ai-gateway.yml", "beijing-sandbox,shprod,sgprod", "ai-gateway"),
    "ctl": (".ci/ctl.yml", "beijing-sandbox,shprod,sgprod", "ctl"),
    "gateway-dashboard": (".ci/gateway-dashboard.yml", "beijing-sandbox,shprod,sgprod", "gateway-dashboard"),
    "nextgen-dashboard": (".ci/nextgen-dashboard.yml", "beijing-sandbox,shprod,sgprod", "nextgen-dashboard"),
    "payment": (".ci/payment.yml", "beijing-sandbox,shprod,sgprod", "payment"),
    "sandbox": (".ci/sandbox.yml", "beijing-sandbox,shprod,sgprod", "sandbox"),
    "service-gateway": (".ci/service-gateway.yml", "beijing-sandbox,shprod,sgprod", "service-gateway"),
    "subscription": (".ci/subscription.yml", "beijing-sandbox,shprod,sgprod", "subscription"),
    "user-auth": (".ci/lightclaw-auth.yml", "beijing-sandbox,shprod,sgprod", "lightclaw-auth"),
}

BUSINESS_WORKFLOWS = {
    ".ci/admin-gateway.yml",
    ".ci/ai-gateway.yml",
    ".ci/channelgateway.yml",
    ".ci/cloudagent-gateway.yml",
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

PROD_DB_MIGRATION_WORKFLOWS = {
    ".ci/ai-gateway.yml",
    ".ci/ctl.yml",
    ".ci/lightclaw-auth.yml",
    ".ci/payment.yml",
    ".ci/sandbox.yml",
    ".ci/subscription.yml",
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
                self.assertEqual((workflow_entry.get("extends") or {}).get("template"), "service-release.yml")
                self.assertIn("playground/sandbox-bj-*", (REPO_ROOT / workflow_path).read_text())
                self.assertIn("playground/sandbox-kr-*", (REPO_ROOT / workflow_path).read_text())
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
                self.assert_registry_credentials_cover_build_envs(workflow, master_build_envs)
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

    def test_korea_playground_env_uses_kr_registry_and_seoul_catalog_root(self) -> None:
        manifest = load_manifest()

        bundle = require_build_metadata(load_bundle(manifest, "ai-gateway", KOREA_PLAYGROUND_ENV))

        self.assertEqual(bundle.image_repo, "lightclaw-kr1.tencentcloudcr.com/lightclaw/ai-gateway")
        self.assertIn(f"argocd/services/ai-gateway/{KOREA_PLAYGROUND_ENV}/**", bundle.publish_paths)
        self.assertIn(
            f"argocd/catalogs/playground/seoul-playground/{KOREA_PLAYGROUND_ENV}/ai-gateway.yaml",
            bundle.publish_paths,
        )
        self.assertIn(f"argocd/secrets/{KOREA_PLAYGROUND_ENV}/ai-gateway-runtime-secrets.sops.yaml", bundle.publish_paths)

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

        for env in ["beijing-sandbox", "beijing-sandbox-2", "shprod", "sgprod"]:
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

    def test_auto_release_master_envs_have_build_contracts(self) -> None:
        manifest = load_manifest()

        for bundle_name, (_, master_build_envs, _) in AUTO_RELEASE_WORKFLOWS.items():
            for env in master_build_envs.split(","):
                with self.subTest(bundle=bundle_name, env=env):
                    require_build_metadata(load_bundle(manifest, bundle_name, env))

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

        korea_bundle = require_build_metadata(load_bundle(manifest, "frontend", KOREA_PLAYGROUND_ENV))
        self.assertEqual(korea_bundle.image_repo, "lightclaw-kr1.tencentcloudcr.com/lightclaw/frontend")

    def test_frontend_workflow_supports_playground_branch_release(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/frontend.yml").read_text()
        workflow = yaml.safe_load(workflow_text)

        self.assertIn("playground/sandbox-bj-*", workflow_text)
        self.assertIn("playground/sandbox-kr-*", workflow_text)
        self.assertIn('PLAYGROUND_ENV="${{ ci.branch }}"', workflow_text)
        self.assertIn('PLAYGROUND_ENV="${PLAYGROUND_ENV#playground/}"', workflow_text)
        self.assertIn('BUILD_ENVS="$(resolve_playground_envs "auto" "$PLAYGROUND_ENV")"', workflow_text)
        self.assertIn('AUTO_PIN_ENVS="$(resolve_playground_envs "auto" "$PLAYGROUND_ENV")"', workflow_text)
        self.assertIn("SHORT_SHA='${{ ci.sha }}'", workflow_text)
        self.assertIn('SHORT_SHA="${BK_CI_GIT_HEAD_COMMITS%%,*}"', workflow_text)
        self.assertNotIn('SHORT_SHA="${{ ci.sha }}"', workflow_text)
        self.assertNotIn('SHORT_SHA="${SHORT_SHA:0:12}"', workflow_text)
        self.assert_release_entry_targets(
            workflow,
            expected_service="frontend",
            expected_pin_targets="frontend",
            workflow_text=workflow_text,
        )

    def test_frontend_workflow_uses_native_edgeone_subpipeline_fanout(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/frontend.yml").read_text()
        workflow = yaml.safe_load(workflow_text) or {}
        stages = workflow.get("stages") or []
        stage_by_name = {stage.get("name"): stage for stage in stages}
        approval_stage = stage_by_name["确认发起 frontend EdgeOne 正式站发布候选"]
        fanout_stage = stage_by_name["自动发起 frontend EdgeOne 正式站发布候选"]
        prod_edgeone_if = "${{ variables.PIPELINE_MODE }} == build && ${{ ci.branch }} == master"
        approval_reviews = (((approval_stage.get("check-in") or {}).get("reviews") or {}).get("flows") or [])[0]

        self.assertNotIn("FRONTEND_EDGEONE_RELEASE_ENABLED", workflow_text)
        self.assertNotIn("FRONTEND_EDGEONE_RELEASE_MATRIX", workflow_text)
        self.assertNotIn("确认发布 frontend EdgeOne 正式站", workflow_text)
        self.assertNotIn("发布 frontend EdgeOne 正式站", workflow_text)
        self.assertNotIn("ci_load_edgeone_credentials", workflow_text)
        self.assertNotIn("trigger_frontend_edgeone_releases.py", workflow_text)
        self.assertNotIn("--target orchestrator", workflow_text)
        self.assertNotIn("BK_CI_ACCESS_TOKEN", workflow_text)
        self.assertEqual(approval_stage.get("if"), prod_edgeone_if)
        self.assertEqual(fanout_stage.get("if"), prod_edgeone_if)
        self.assertEqual(approval_reviews.get("name"), "确认发起 frontend EdgeOne 正式站发布候选")
        self.assertEqual(
            approval_reviews.get("reviewers"),
            ["skipzhang", "pablozhong", "erichuyuehu", "sarahzzhang"],
        )
        self.assertIn("本阶段确认是否允许本次 frontend 构建发起 EdgeOne 正式站发布候选", workflow_text)
        self.assertIn("本阶段只控制是否允许从本次构建发起生产发布候选", workflow_text)
        self.assertIn("自动发起 frontend EdgeOne 正式站发布候选", workflow_text)
        self.assertIn("SubPipelineExecStream@1.*", workflow_text)
        self.assertIn('if: "${{ variables.PIPELINE_MODE }} == build && ${{ ci.branch }} == master"', workflow_text)
        self.assertIn('targetPathFromUrl: ".ci/frontend-edgeone-lightvela.yml"', workflow_text)
        self.assertIn('targetPathFromUrl: ".ci/frontend-edgeone-lightvela-intl.yml"', workflow_text)
        self.assertIn('key: "FRONTEND_EDGEONE_ARTIFACT_SOURCE_SHA"', workflow_text)
        self.assertIn('value: "${{ ci.sha }}"', workflow_text)
        self.assertLess(
            workflow_text.index('"$PNPM_BIN" build:release-artifacts'),
            workflow_text.index("确认发起 frontend EdgeOne 正式站发布候选"),
        )
        self.assertLess(
            workflow_text.index("确认发起 frontend EdgeOne 正式站发布候选"),
            workflow_text.index("SubPipelineExecStream@1.*"),
        )

    def test_frontend_edgeone_release_uses_dedicated_manual_workflows(self) -> None:
        cn_workflow = yaml.safe_load((REPO_ROOT / ".ci/frontend-edgeone-lightvela.yml").read_text()) or {}
        intl_workflow = yaml.safe_load((REPO_ROOT / ".ci/frontend-edgeone-lightvela-intl.yml").read_text()) or {}
        template_text = (REPO_ROOT / ".ci/templates/frontend-edgeone-release.yml").read_text()
        template = yaml.safe_load(template_text) or {}
        stages = template.get("stages") or []

        self.assertEqual((cn_workflow.get(True) or cn_workflow.get("on") or {}).get("manual"), "enabled")
        self.assertEqual((intl_workflow.get(True) or intl_workflow.get("on") or {}).get("manual"), "enabled")
        self.assertEqual((cn_workflow.get("extends") or {}).get("parameters", {}).get("COMBO"), "eo:cn-lightvela-prod")
        self.assertEqual(
            (intl_workflow.get("extends") or {}).get("parameters", {}).get("COMBO"),
            "eo:global-lightvela-intl-prod",
        )
        self.assertIn("FRONTEND_EDGEONE_ARTIFACT_SOURCE_SHA", template.get("variables") or {})
        self.assertIn("FRONTEND_EDGEONE_ARTIFACT_REF", template.get("variables") or {})
        self.assertIn("check-in", stages[0])
        self.assertNotIn("if:", template_text)
        self.assertIn("release_frontend_edgeone_artifact.sh", template_text)
        self.assertNotIn('"$PNPM_BIN" install --frozen-lockfile', template_text)

        command_text = (REPO_ROOT / ".ci/runtime/commands/release_frontend_edgeone_artifact.sh").read_text()
        self.assertIn("/etc/lightclaw-ci/edgeone_lightvela_prod_token", command_text)
        self.assertIn("/etc/lightclaw-ci/edgeone_lightvela_intl_prod_token", command_text)
        self.assertIn("ci_load_edgeone_credentials", command_text)
        self.assertIn('ARTIFACT_SOURCE_SHA="$FRONTEND_EDGEONE_CI_SHA"', command_text)
        self.assertIn("FRONTEND_EDGEONE_ARTIFACT_SOURCE_SHA is empty and ci.sha is unavailable", command_text)

        frontend_text = (REPO_ROOT / ".ci/frontend.yml").read_text()
        self.assertIn("SubPipelineExecStream@1.*", frontend_text)

        self.assertFalse((REPO_ROOT / ".ci/subpipeline-call-probe.yml").exists())
        self.assertFalse((REPO_ROOT / ".ci/frontend-edgeone-orchestrator-probe.yml").exists())
        self.assertFalse((REPO_ROOT / ".ci/frontend-edgeone-subpipeline-child-probe.yml").exists())

    def test_hermes_image_workflow_refreshes_pools_and_upgrades_existing_vms_after_approval(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/hermes-image.yml").read_text()
        workflow = yaml.safe_load(workflow_text) or {}
        stages = workflow.get("stages") or []
        stage_by_name = {stage.get("name"): stage for stage in stages}

        build_stage = stage_by_name["构建 Hermes CVM 镜像"]
        refresh_approval_stage = stage_by_name["确认刷新 Hermes sandbox pools"]
        refresh_stage = stage_by_name["刷新 Hermes sandbox pools"]
        upgrade_approval_stage = stage_by_name["确认升级存量 Hermes VM"]
        upgrade_stage = stage_by_name["升级存量 Hermes VM"]
        prod_if = "${{ ci.branch }} == master"
        reviewers = ["skipzhang", "pablozhong", "erichuyuehu", "sarahzzhang"]
        refresh_reviews = (((refresh_approval_stage.get("check-in") or {}).get("reviews") or {}).get("flows") or [])[0]
        upgrade_reviews = (((upgrade_approval_stage.get("check-in") or {}).get("reviews") or {}).get("flows") or [])[0]

        self.assertEqual(refresh_approval_stage.get("if"), prod_if)
        self.assertEqual(refresh_stage.get("if"), prod_if)
        self.assertEqual(upgrade_approval_stage.get("if"), prod_if)
        self.assertEqual(upgrade_stage.get("if"), prod_if)
        self.assertEqual(refresh_reviews.get("reviewers"), reviewers)
        self.assertEqual(upgrade_reviews.get("reviewers"), reviewers)
        self.assertLess(stages.index(build_stage), stages.index(refresh_approval_stage))
        self.assertLess(stages.index(refresh_approval_stage), stages.index(refresh_stage))
        self.assertLess(stages.index(refresh_stage), stages.index(upgrade_approval_stage))
        self.assertLess(stages.index(upgrade_approval_stage), stages.index(upgrade_stage))

        self.assertIn("refresh_hermes_sandbox_pools.sh", workflow_text)
        self.assertIn("list_hermes_pool_vms.sh", workflow_text)
        self.assertIn("create_hermes_tat_command.sh", workflow_text)
        self.assertIn("invoke_hermes_tat_command.sh", workflow_text)
        self.assertNotIn('HERMES_TAT_COMMAND_ID is required for existing Hermes VM upgrade', workflow_text)
        self.assertIn("images/helpers/config-hermes-python-mirrors.sh", workflow_text)
        self.assertNotIn("tccli tat DeleteCommand", workflow_text)
        self.assertGreaterEqual(workflow_text.count("ci_ensure_jq"), 2)
        self.assertIn('HERMES_TAT_BATCH_SIZE="${HERMES_TAT_BATCH_SIZE:-5}"', workflow_text)
        self.assertIn('HERMES_TAT_SINGLE_ATTEMPTS="${HERMES_TAT_SINGLE_ATTEMPTS:-3}"', workflow_text)
        self.assertIn("不直连数据库，不修改 pool / instance 状态", workflow_text)
        self.assertIn("批次失败后自动拆成单台重试", workflow_text)

        list_script = REPO_ROOT / ".ci/runtime/commands/list_hermes_pool_vms.sh"
        create_script = REPO_ROOT / ".ci/runtime/commands/create_hermes_tat_command.sh"
        invoke_script = REPO_ROOT / ".ci/runtime/commands/invoke_hermes_tat_command.sh"
        repair_script = REPO_ROOT / "images/helpers/config-hermes-python-mirrors.sh"
        blueprint_id_file = REPO_ROOT / "images/hermes-backend-blueprint-id"
        self.assertTrue(list_script.exists())
        self.assertTrue(create_script.exists())
        self.assertTrue(invoke_script.exists())
        self.assertTrue(blueprint_id_file.exists())
        self.assertEqual(blueprint_id_file.read_text().strip(), "lhbp-8gsotw6u")
        self.assertIn("does not patch pools, update SKUs, invoke TAT, or write database rows", list_script.read_text())
        create_script_text = create_script.read_text()
        self.assertIn("tccli tat CreateCommand", create_script_text)
        self.assertIn("--CommandType SHELL", create_script_text)
        self.assertIn("--Content", create_script_text)
        self.assertIn("images/hermes-backend-blueprint-id", create_script_text)
        self.assertIn("export HERMES_BACKEND_BLUEPRINT_ID", create_script_text)
        self.assertIn("batches run strictly serially", invoke_script.read_text())
        self.assertIn("batch failed; retrying", invoke_script.read_text())
        repair_script_text = repair_script.read_text()
        self.assertIn('"$config_dir/systemd/user"', repair_script_text)
        self.assertIn('chown "$user:$user" "$config_dir"', repair_script_text)
        self.assertIn('chmod 0700 "$config_dir"', repair_script_text)
        self.assertIn("acli backend upgrade-start --blueprint-id", repair_script_text)

    def test_frontend_preview_uses_master_runtime(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/frontend-preview.yml").read_text()

        self.assertIn('FRONTEND_PREVIEW_RUNTIME_REF="${FRONTEND_PREVIEW_RUNTIME_REF:-origin/master}"', workflow_text)
        self.assertIn("git fetch --no-tags --depth=1 origin +master:refs/remotes/origin/master", workflow_text)
        self.assertIn('git archive --format=tar "$FRONTEND_PREVIEW_RUNTIME_REF" .ci', workflow_text)
        self.assertIn('bash "$FRONTEND_PREVIEW_RUNTIME_CI_DIR/runtime/commands/publish_frontend_preview.sh"', workflow_text)
        self.assertNotIn('"$PNPM_BIN" exec vite build', workflow_text)

        command_text = (REPO_ROOT / ".ci/runtime/commands/publish_frontend_preview.sh").read_text()
        self.assertIn('source "$CI_DIR/init.sh"', command_text)
        self.assertIn('python3 "$CI_DIR/runtime/commands/upload_staticpages_preview.py"', command_text)

    def test_frontend_preview_builds_cn_and_intl_with_separate_api_bases(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/runtime/commands/publish_frontend_preview.sh").read_text()

        self.assertIn('PREVIEW_CN_AUTH_API_BASE_URL="$(resolve_preview_auth_api_base_url "$FRONTEND_PREVIEW_BRANCH" cn)"', workflow_text)
        self.assertIn('PREVIEW_INTL_AUTH_API_BASE_URL="$(resolve_preview_auth_api_base_url "$FRONTEND_PREVIEW_BRANCH" intl)"', workflow_text)
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

    def test_frontend_mr_guard_runs_typecheck_and_vite_builds(self) -> None:
        package_json = json.loads((REPO_ROOT / "frontend/package.json").read_text())
        guard_text = (REPO_ROOT / "frontend/checks/guard.sh").read_text()

        self.assertEqual(package_json["scripts"]["check"], "tsc -b")
        self.assertIn('"$PNPM_BIN" check', guard_text)
        self.assertIn('FRONTEND_GUARD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lightclaw-frontend-guard.XXXXXX")"', guard_text)
        self.assertIn('VITE_BIN="$FRONTEND_GUARD_DIR/node_modules/.bin/vite"', guard_text)
        self.assertIn('VITE_AUTH_API_BASE_URL=https://api.lightvela.ai "$VITE_BIN" build --mode cn --outDir dist-ci-cn', guard_text)
        self.assertIn('VITE_AUTH_API_BASE_URL=https://lightclaw.tech "$VITE_BIN" build --mode global --outDir dist-ci-global', guard_text)
        self.assertIn("rm -rf dist-ci-cn dist-ci-global", guard_text)

    def test_prod_db_migration_workflow_is_manual_dry_run_then_check_in_then_apply(self) -> None:
        workflow_path = REPO_ROOT / ".ci/db-migration.yml"
        workflow_text = workflow_path.read_text()
        workflow = yaml.safe_load(workflow_text)
        on_config = workflow.get(True) or workflow.get("on") or {}
        template_text = (REPO_ROOT / ".ci/templates/db-migration.yml").read_text()
        template = yaml.safe_load(template_text)
        stages = workflow.get("stages") or []
        template_stages = template.get("stages") or []

        self.assertNotIn("push", on_config)
        self.assertEqual(on_config.get("manual"), "enabled")
        self.assertEqual((workflow.get("extends") or {}).get("template"), "db-migration.yml")
        self.assertFalse(stages)
        self.assertIn("SOURCE_SHA", template.get("variables") or {})
        self.assertIn("MIGRATION_DECISION", template.get("variables") or {})
        self.assertNotIn("APPLY", template.get("variables") or {})
        self.assertEqual(((template.get("variables") or {}).get("SKIP_IF_NO_MIGRATION_CHANGE") or {}).get("value"), "false")
        self.assertEqual(((template.get("variables") or {}).get("MIGRATION_DECISION") or {}).get("value"), "auto")
        self.assertEqual([stage.get("name") for stage in template_stages], [
            "Dry-run 生产 DB migration",
            "跳过生产 DB migration",
            "阻断生产 DB migration",
            "人工确认生产 DB migration",
            "执行生产 DB migration",
        ])
        self.assertIn("check-in", template_stages[3])
        self.assertEqual(template_stages[1].get("if"), "${{ variables.MIGRATION_DECISION }} == skip_migration")
        self.assertEqual(template_stages[2].get("if"), "${{ variables.MIGRATION_DECISION }} == block")
        self.assertEqual(template_stages[3].get("if"), "${{ variables.MIGRATION_DECISION }} == run_migration")
        self.assertEqual(template_stages[4].get("if"), "${{ variables.MIGRATION_DECISION }} == run_migration")
        self.assertNotIn("${{ci.actor}}", template_text)
        self.assertNotIn("${{ ci.actor }}", template_text)
        self.assertIn('reviewers: [ "skipzhang" ]', template_text)
        self.assertIn("请先检查上一阶段 dry-run 日志中的执行计划", template_text)
        self.assertEqual(template_text.count("run_prod_db_migration.py"), 2)
        self.assertIn("SKIP_IF_NO_MIGRATION_CHANGE", template_text)
        self.assertIn("MIGRATION_DECISION", template_text)
        self.assertIn("--decision-output db-migration-decision.json", template_text)
        self.assertIn("MIGRATION_DECISION must be auto, run_migration, skip_migration, or block", template_text)
        self.assertIn('--expect-decision "$MIGRATION_DECISION"', template_text)
        self.assertIn("--fail-if-run-without-expect", template_text)
        self.assertIn("--skip-if-no-migration-change", template_text)
        self.assertIn("无实际 DB 变更，跳过人工审核和 apply", template_text)
        self.assertIn("Dry-run 并打印生产 DB migration 计划", template_text)
        self.assertIn("创建并等待 migration/readiness Job", template_text)
        self.assertIn("--apply", template_text)

    def test_lightclaw_auth_prod_replaces_oauth_return_hosts(self) -> None:
        for env in ["shprod", "sgprod"]:
            with self.subTest(env=env):
                workflow = yaml.safe_load(
                    (REPO_ROOT / f"argocd/services/lightclaw-auth/{env}/kustomization.yaml").read_text()
                )
                replacements = workflow.get("replacements") or []
                self.assertTrue(
                    any(
                        (replacement.get("source") or {}).get("fieldPath")
                        == "data.AUTH_OAUTH_RETURN_TO_ALLOWED_HOSTS"
                        for replacement in replacements
                    )
                )

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

    def test_cloudagent_gateway_adds_service_prod_reviewers(self) -> None:
        manifest = load_manifest()
        devcloud_bundle = require_build_metadata(load_bundle(manifest, "cloudagent-gateway", "devcloud-dep"))
        bundle = load_bundle(manifest, "cloudagent-gateway", "shprod")
        workflow = yaml.safe_load((REPO_ROOT / ".ci/cloudagent-gateway.yml").read_text())
        parameters = (workflow.get("extends") or {}).get("parameters") or {}
        on_config = workflow.get("on") or workflow.get(True) or {}
        watched_paths = ((on_config.get("push") or {}).get("paths") or [])

        self.assertEqual(parameters.get("PROD_REVIEWERS"), '["skipzhang", "roberttwang", "cocofhu"]')
        self.assertEqual(parameters.get("MASTER_BUILD_ENVS"), "devcloud-dep,shprod")
        self.assertEqual(parameters.get("MASTER_AUTO_PIN_ENVS"), "devcloud-dep")
        self.assertEqual(devcloud_bundle.image_repo, "csighub.tencentyun.com/skipzhang/cloudagent-gateway")
        self.assertIn(
            "argocd/secrets/shprod/cloudagent-wsa-search-secrets.sops.yaml",
            bundle.publish_paths,
        )
        self.assertIn(
            "argocd/secrets/shprod/cloudagent-wisp-secrets.sops.yaml",
            bundle.publish_paths,
        )
        self.assertIn("argocd/secrets/*/cloudagent-wsa-search-secrets.sops.yaml", watched_paths)
        self.assertIn("argocd/secrets/*/cloudagent-wisp-secrets.sops.yaml", watched_paths)

    def test_channelgateway_uses_devcloud_csighub_release_contract(self) -> None:
        manifest = load_manifest()
        bundle = require_build_metadata(load_bundle(manifest, "channelgateway", "devcloud-dep"))
        workflow = yaml.safe_load((REPO_ROOT / ".ci/channelgateway.yml").read_text())
        parameters = (workflow.get("extends") or {}).get("parameters") or {}
        on_config = workflow.get("on") or workflow.get(True) or {}
        watched_paths = ((on_config.get("push") or {}).get("paths") or [])

        self.assertEqual((workflow.get("extends") or {}).get("template"), "service-release.yml")
        self.assertEqual(parameters.get("MASTER_BUILD_ENVS"), "devcloud-dep")
        self.assertEqual(parameters.get("MASTER_AUTO_PIN_ENVS"), "devcloud-dep")
        self.assertEqual(parameters.get("ENABLE_MASTER_PROD_PROMOTE"), False)
        self.assertEqual(bundle.image_repo, "csighub.tencentyun.com/skipzhang/channelgateway")
        self.assertIn("argocd/services/channelgateway/devcloud-dep/**", bundle.publish_paths)
        self.assertIn("argocd/secrets/devcloud-dep/channelgateway-runtime-secrets.sops.yaml", bundle.publish_paths)
        self.assertIn("cloudagent/acp-client/**", watched_paths)
        self.assertIn("argocd/services/channelgateway/**", watched_paths)
        self.assertIn("argocd/secrets/*/channelgateway-runtime-secrets.sops.yaml", watched_paths)

    def test_cloudladdergateway_uses_tkex_template_release_contract(self) -> None:
        manifest = load_manifest()
        domestic_bundle = require_build_metadata(load_bundle(manifest, "cloudladdergateway", "tkexgz"))
        intl_bundle = require_build_metadata(load_bundle(manifest, "cloudladdergateway", "tkexsg"))
        workflow = yaml.safe_load((REPO_ROOT / ".ci/cloudladdergateway.yml").read_text())
        parameters = (workflow.get("extends") or {}).get("parameters") or {}
        on_config = workflow.get("on") or workflow.get(True) or {}
        watched_paths = ((on_config.get("push") or {}).get("paths") or [])

        self.assertEqual((workflow.get("extends") or {}).get("template"), "service-release.yml")
        self.assertEqual(parameters.get("MASTER_BUILD_ENVS"), "tkexgz,tkexsg")
        self.assertEqual(parameters.get("MASTER_AUTO_PIN_ENVS"), "none")
        self.assertEqual(parameters.get("ENABLE_MASTER_PROD_PROMOTE"), False)
        self.assertEqual(parameters.get("PLAYGROUND_BUILD_ENVS"), "none")
        self.assertEqual(parameters.get("PLAYGROUND_AUTO_PIN_ENVS"), "none")
        self.assertEqual(domestic_bundle.image_repo, "csighub.tencentyun.com/skipzhang/cloudladdergateway")
        self.assertEqual(intl_bundle.image_repo, "csighub.tencentyun.com/skipzhang/cloudladdergateway")
        self.assertIn("argocd/services/cloudladdergateway/tkexgz/**", domestic_bundle.publish_paths)
        self.assertIn("argocd/services/cloudladdergateway/tkexsg/**", intl_bundle.publish_paths)
        self.assertIn("shared/cloudladdertransport/**", watched_paths)
        self.assertIn("argocd/services/cloudladdergateway/**", watched_paths)

    def test_lightclaw_auth_workflow_watches_release_contract_inputs(self) -> None:
        workflow = yaml.safe_load((REPO_ROOT / ".ci/lightclaw-auth.yml").read_text())
        on_config = workflow.get("on") or workflow.get(True) or {}
        watched_paths = ((on_config.get("push") or {}).get("paths") or [])

        self.assertIn("argocd/secrets/*/lightclaw-auth-content-audit-secrets.sops.yaml", watched_paths)
        self.assertIn("argocd/secrets/*/lightvela-e2e-auth-secrets.sops.yaml", watched_paths)

    def test_beijing_lightclaw_auth_keeps_official_account_config(self) -> None:
        env_path = REPO_ROOT / "argocd/services/lightclaw-auth/beijing-sandbox/auth-platform.env"
        values = dict(
            line.split("=", 1)
            for line in env_path.read_text().splitlines()
            if line and not line.startswith("#")
        )

        self.assertEqual(values["AUTH_WECHAT_OFFICIAL_ACCOUNT_APP_ID"], "wxf95ea3ae45d5304f")
        self.assertEqual(
            values["AUTH_WECHAT_OFFICIAL_ACCOUNT_REDIRECT_URI"],
            "https://lightclaw.tech/auth/oauth/wechat/callback",
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

    def test_service_release_shell_resolves_branch_for_openapi_manual_start(self) -> None:
        template_text = (REPO_ROOT / ".ci/templates/service-release.yml").read_text()

        self.assertEqual(template_text.count("resolve_source_branch()"), 2)
        self.assertEqual(template_text.count("SOURCE_BRANCH=\"$(resolve_source_branch '${{ ci.branch }}')\""), 2)
        self.assertIn("BK_CI_GIT_REPO_BRANCH:-${DEVOPS_GIT_REPO_BRANCH:-}", template_text)
        self.assertNotIn('case "${{ ci.branch }}" in', template_text)
        self.assertNotIn('PLAYGROUND_ENV="${{ ci.branch }}"', template_text)
        self.assertIn('case "$SOURCE_BRANCH" in', template_text)
        self.assertIn('PLAYGROUND_ENV="$SOURCE_BRANCH"', template_text)
        self.assertIn('unsupported source branch for release: ${SOURCE_BRANCH:-unknown}', template_text)

    def test_service_release_creates_independent_prod_promote_candidates(self) -> None:
        template_path = REPO_ROOT / ".ci/templates/service-release.yml"
        template_text = template_path.read_text()
        template = yaml.safe_load(template_text) or {}
        stages = template.get("stages") or []
        stage_by_name = {stage.get("name"): stage for stage in stages}

        entry_stage = stage_by_name["是否准备进入生产 ${{ parameters.DISPLAY_NAME }}"]
        promote_stage = stage_by_name["创建生产 promote 候选 ${{ parameters.DISPLAY_NAME }}"]
        shprod_db_stage = stage_by_name["发起 shprod DB migration ${{ parameters.DISPLAY_NAME }}"]
        sgprod_db_stage = stage_by_name["发起 sgprod DB migration ${{ parameters.DISPLAY_NAME }}"]
        second_approval_stage = stage_by_name["二次确认生产镜像升级 ${{ parameters.DISPLAY_NAME }}"]
        prod_promote_stage_if = (
            "${{ parameters.ENABLE_MASTER_PROD_PROMOTE }} == true && "
            "${{ variables.PIPELINE_MODE }} == build && "
            "${{ ci.branch }} == master"
        )
        shprod_db_stage_if = (
            "${{ parameters.ENABLE_MASTER_PROD_PROMOTE }} == true && "
            "${{ parameters.ENABLE_MASTER_PROD_DB_MIGRATION }} == true && "
            "${{ parameters.ENABLE_MASTER_SHPROD_DB_MIGRATION }} == true && "
            "${{ variables.PIPELINE_MODE }} == build && "
            "${{ ci.branch }} == master"
        )
        sgprod_db_stage_if = (
            "${{ parameters.ENABLE_MASTER_PROD_PROMOTE }} == true && "
            "${{ parameters.ENABLE_MASTER_PROD_DB_MIGRATION }} == true && "
            "${{ parameters.ENABLE_MASTER_SGPROD_DB_MIGRATION }} == true && "
            "${{ variables.PIPELINE_MODE }} == build && "
            "${{ ci.branch }} == master"
        )
        entry_reviews = (((entry_stage.get("check-in") or {}).get("reviews") or {}).get("flows") or [])[0]

        self.assertEqual(entry_stage.get("if"), prod_promote_stage_if)
        self.assertEqual(entry_reviews.get("name"), "是否准备进入生产")
        self.assertIn("本阶段确认是否允许本次构建进入生产候选流程", template_text)
        self.assertLess(
            template_text.index("是否准备进入生产 ${{ parameters.DISPLAY_NAME }}"),
            template_text.index("发起 shprod DB migration ${{ parameters.DISPLAY_NAME }}"),
        )
        self.assertLess(
            template_text.index("发起 shprod DB migration ${{ parameters.DISPLAY_NAME }}"),
            template_text.index("发起 sgprod DB migration ${{ parameters.DISPLAY_NAME }}"),
        )
        self.assertLess(
            template_text.index("发起 sgprod DB migration ${{ parameters.DISPLAY_NAME }}"),
            template_text.index("二次确认生产镜像升级 ${{ parameters.DISPLAY_NAME }}"),
        )
        self.assertLess(
            template_text.index("二次确认生产镜像升级 ${{ parameters.DISPLAY_NAME }}"),
            template_text.index("创建生产 promote 候选 ${{ parameters.DISPLAY_NAME }}"),
        )
        self.assertNotIn("Dry-run 生产 DB migration ${{ parameters.DISPLAY_NAME }}", template_text)
        self.assertNotIn("确认生产 promote ${{ parameters.DISPLAY_NAME }}", template_text)
        self.assertNotIn("执行生产 DB migration ${{ parameters.DISPLAY_NAME }}", template_text)
        self.assertIn("run_prod_db_migration.py", template_text)
        self.assertIn("--decision-output shprod-db-migration-decision.json", template_text)
        self.assertIn("--decision-output sgprod-db-migration-decision.json", template_text)
        self.assertIn("resolve_prod_promote_envs.py", template_text)
        self.assertNotIn("SOURCE_SHA=${{ ci.sha }}", template_text)
        self.assertNotIn("SOURCE_SHA=构建阶段日志里的完整 SOURCE_SHA", template_text)
        self.assertEqual(
            promote_stage.get("if"),
            prod_promote_stage_if,
        )
        self.assertEqual(shprod_db_stage.get("if"), shprod_db_stage_if)
        self.assertEqual(sgprod_db_stage.get("if"), sgprod_db_stage_if)
        self.assertEqual(second_approval_stage.get("if"), prod_promote_stage_if)
        second_approval_reviews = (((second_approval_stage.get("check-in") or {}).get("reviews") or {}).get("flows") or [])[0]
        self.assertEqual(second_approval_reviews.get("name"), "二次确认生产镜像升级")
        template_parameters = {parameter.get("name"): parameter for parameter in template.get("parameters") or []}
        self.assertEqual(template_parameters.get("PROD_REVIEWERS", {}).get("default"), '["skipzhang"]')
        self.assertEqual(entry_reviews.get("reviewers"), "${{ parameters.PROD_REVIEWERS }}")
        self.assertEqual(second_approval_reviews.get("reviewers"), "${{ parameters.PROD_REVIEWERS }}")
        self.assertIn("reviewers: ${{ parameters.PROD_REVIEWERS }}", template_text)
        self.assertIn('if [[ "${{ variables.PIPELINE_MODE }}" != "build" ]]; then', template_text)
        self.assertIn('if [[ "${{ ci.branch }}" != "master" ]]; then', template_text)
        self.assertNotIn("csv_contains()", template_text)
        self.assertNotIn("resolve_prod_promote_envs()", template_text)
        self.assertNotIn('if [[ "$env_name" != "shprod" && "$env_name" != "sgprod" ]]; then', template_text)
        self.assertIn("MASTER_AUTO_PIN_ENVS", template_text)
        self.assertIn("promote_bundle_image_to_gitops.sh", template_text)
        self.assertIn("若本服务启用生产 DB migration，会先发起 shprod / sgprod DB 子流水线", template_text)
        self.assertIn("若本服务未启用生产 DB migration，会直接进入生产镜像升级二次确认", template_text)
        self.assertIn("本次镜像 tag / SOURCE_SHA 确实允许进入 shprod / sgprod GitOps 待同步流程", template_text)
        self.assertIn("若本服务启用生产 DB migration，shprod / sgprod DB 子流水线已经完成", template_text)
        self.assertIn("点击通过后，流水线才会创建 shprod / sgprod promote 分支", template_text)
        self.assertIn("构建 ${{ parameters.DISPLAY_NAME }} 镜像矩阵", template_text)
        self.assertIn("SHORT_SHA='${{ ci.sha }}'", template_text)
        self.assertIn('SHORT_SHA="${BK_CI_GIT_HEAD_COMMITS%%,*}"', template_text)
        self.assertNotIn('SHORT_SHA="${{ ci.sha }}"', template_text)
        self.assertNotIn('SHORT_SHA="${SHORT_SHA:0:12}"', template_text)
        self.assertIn("北京测试 DB 变更检查与 GitOps auto-pin", template_text)
        self.assertIn('BUILD_ONLY=true bash "$REPO_ROOT/.ci/runtime/build_and_promote_to_gitops.sh"', template_text)
        self.assertIn('AUTO_PIN_ONLY=true bash "$REPO_ROOT/.ci/runtime/build_and_promote_to_gitops.sh"', template_text)
        self.assertIn('bash "$REPO_ROOT/.ci/runtime/promote_bundle_image_to_gitops.sh"', template_text)
        self.assertIn('RUNTIME_SNAPSHOT="$(ci_create_runtime_snapshot "$REPO_ROOT/.ci")"', template_text)
        self.assertNotIn('cp "$REPO_ROOT/.ci/init.sh" "$RUNTIME_SNAPSHOT/.ci/init.sh"', template_text)
        self.assertNotIn('cp -R "$REPO_ROOT/.ci/runtime" "$RUNTIME_SNAPSHOT/.ci/runtime"', template_text)
        self.assertIn('PROMOTE_BUNDLE_SCRIPT="$RUNTIME_SNAPSHOT/.ci/runtime/promote_bundle_image_to_gitops.sh"', template_text)
        self.assertIn('bash "$PROMOTE_BUNDLE_SCRIPT"', template_text)
        self.assertIn("RELEASE_IMAGE_DIR=\".ci/.release-images/${{ parameters.SERVICE }}-${{ steps.prepare.outputs.tag }}\"", template_text)
        self.assertIn("SubPipelineExecStream@1.*", template_text)
        self.assertEqual(template_text.count('targetPathFromUrl: ".ci/db-migration.yml"'), 2)
        self.assertIn('buildInfo: "shprod DB migration: ${{ parameters.BUNDLE }} @ ${{ ci.sha }} decision=${{ steps.plan.outputs.decision }}"', template_text)
        self.assertIn('buildInfo: "sgprod DB migration: ${{ parameters.BUNDLE }} @ ${{ ci.sha }} decision=${{ steps.plan.outputs.decision }}"', template_text)
        self.assertIn('key: "SERVICE"', template_text)
        self.assertIn('value: "${{ parameters.BUNDLE }}"', template_text)
        self.assertIn('key: "SOURCE_SHA"', template_text)
        self.assertIn('value: "${{ ci.sha }}"', template_text)
        self.assertIn('key: "SKIP_IF_NO_MIGRATION_CHANGE"', template_text)
        self.assertIn('key: "MIGRATION_DECISION"', template_text)
        self.assertIn('value: "${{ steps.plan.outputs.decision }}"', template_text)
        self.assertEqual(template_text.count('value: "true"'), 2)
        self.assertIn('value: "shprod"', template_text)
        self.assertIn('value: "sgprod"', template_text)

    def test_db_contract_workflows_enable_prod_db_migration_child_pipelines(self) -> None:
        for workflow_path in sorted(PROD_DB_MIGRATION_WORKFLOWS):
            with self.subTest(workflow=workflow_path):
                workflow = yaml.safe_load((REPO_ROOT / workflow_path).read_text()) or {}
                params = (workflow.get("extends") or {}).get("parameters") or {}

                self.assertIs(params.get("ENABLE_MASTER_PROD_DB_MIGRATION"), True)
                self.assertIsNot(params.get("ENABLE_MASTER_PROD_PROMOTE"), False)

    def test_service_release_workflows_without_prod_matrix_disable_prod_promote(self) -> None:
        for workflow_path in [REPO_ROOT / ".ci/staticpages.yml", REPO_ROOT / ".ci/trade.yml"]:
            with self.subTest(workflow=workflow_path.name):
                workflow = yaml.safe_load(workflow_path.read_text()) or {}
                params = (workflow.get("extends") or {}).get("parameters") or {}

                self.assertNotIn("shprod", params.get("MASTER_BUILD_ENVS", ""))
                self.assertNotIn("sgprod", params.get("MASTER_BUILD_ENVS", ""))
                self.assertIs(params.get("ENABLE_MASTER_PROD_PROMOTE"), False)

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

    def assert_registry_credentials_cover_build_envs(self, workflow: str, build_envs: str) -> None:
        required_by_env = {
            "beijing-sandbox": "TCR_BEIJING_PASSWORD",
            "beijing-sandbox-2": "TCR_BEIJING_PASSWORD",
            "sandbox-kr-1": "TCR_KR1_PASSWORD",
            "shprod": "TCR_SHPROD_PASSWORD",
            "sgprod": "TCR_SGPROD_PASSWORD",
            "devcloud-dep": "CSIGHUB_PASSWORD",
        }
        for env_name in {item.strip() for item in build_envs.split(",") if item.strip()}:
            required = required_by_env.get(env_name)
            if required:
                self.assertIn(required, workflow, f"{env_name} builds require {required} in CI env")
            if env_name == "devcloud-dep":
                self.assertIn("CSIGHUB_USERNAME", workflow, "devcloud-dep builds require CSIGHUB_USERNAME in CI env")


if __name__ == "__main__":
    unittest.main()
