import json
import re
import subprocess
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path

import yaml


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.bundles import (  # noqa: E402
    is_playground_env,
    load_bundle,
    load_manifest,
    playground_catalog_root,
    playground_region,
    require_build_metadata,
)
from contracts.release_bundle_manifest import dump_manifest, merge_bundle_sources  # noqa: E402


SANDBOX_ENV = "beijing-sandbox-2"
PLAYGROUND_ENV = "sandbox-bj-7"
KOREA_PLAYGROUND_ENV = "sandbox-kr-1"
JAPAN_PLAYGROUND_ENV = "sandbox-jp-1"
PLAYGROUND_BUILDABLE_BUNDLES = {
    "admin-gateway",
    "ai-gateway",
    "ctl",
    "frontend",
    "gateway-dashboard",
    "nextgen-dashboard",
    "payment",
    "sandbox",
    "service-gateway",
    "staticpages",
    "subscription",
    "trade",
    "user-auth",
    "vibebase",
    "workers",
}
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

TOKYO_RELEASE_WORKFLOWS = {
    "admin-gateway": (".ci/tokyo-admin-gateway.yml", ".ci/admin-gateway.yml", "admin-gateway", "env"),
    "ai-gateway": (".ci/tokyo-ai-gateway.yml", ".ci/ai-gateway.yml", "ai-gateway", "env"),
    "ctl": (".ci/tokyo-ctl.yml", ".ci/ctl.yml", "ctl", "env"),
    "frontend": (".ci/tokyo-frontend.yml", ".ci/frontend.yml", "frontend", "cn-pool"),
    "gateway-dashboard": (
        ".ci/tokyo-gateway-dashboard.yml",
        ".ci/gateway-dashboard.yml",
        "gateway-dashboard",
        "env",
    ),
    "user-auth": (".ci/tokyo-lightclaw-auth.yml", ".ci/lightclaw-auth.yml", "lightclaw-auth", "env"),
    "nextgen-dashboard": (
        ".ci/tokyo-nextgen-dashboard.yml",
        ".ci/nextgen-dashboard.yml",
        "nextgen-dashboard",
        "env",
    ),
    "payment": (".ci/tokyo-payment.yml", ".ci/payment.yml", "payment", "env"),
    "sandbox": (".ci/tokyo-sandbox.yml", ".ci/sandbox.yml", "sandbox", "env"),
    "service-gateway": (
        ".ci/tokyo-service-gateway.yml",
        ".ci/service-gateway.yml",
        "service-gateway",
        "env",
    ),
    "subscription": (".ci/tokyo-subscription.yml", ".ci/subscription.yml", "subscription", "env"),
    "trade": (".ci/tokyo-trade.yml", ".ci/trade.yml", "trade", "env"),
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
    ".ci/velagw.yml",
} | {workflow_path for workflow_path, *_ in TOKYO_RELEASE_WORKFLOWS.values()}

PROD_DB_MIGRATION_WORKFLOWS = {
    ".ci/ai-gateway.yml",
    ".ci/ctl.yml",
    ".ci/lightclaw-auth.yml",
    ".ci/payment.yml",
    ".ci/sandbox.yml",
    ".ci/subscription.yml",
    ".ci/trade.yml",
}


def load_velagw_resources(env: str) -> tuple[dict, list[dict]]:
    service_root = REPO_ROOT / "argocd/services/velagw" / env
    kustomization = yaml.safe_load((service_root / "kustomization.yaml").read_text())
    docs = load_kustomization_resources(service_root, kustomization)
    return kustomization, docs


def load_kustomization_resources(root: Path, kustomization: dict) -> list[dict]:
    docs = []
    for resource in kustomization.get("resources", []):
        path = (root / resource).resolve()
        if path.is_dir():
            child = yaml.safe_load((path / "kustomization.yaml").read_text())
            docs.extend(load_kustomization_resources(path, child))
            continue
        docs.extend(doc for doc in yaml.safe_load_all(path.read_text()) if doc)
    return docs


def load_platform_env(env: str) -> dict[str, str]:
    content = (REPO_ROOT / "argocd/services/velagw" / env / "velagw-platform.env").read_text()
    return {
        key: value
        for line in content.splitlines()
        if line and not line.startswith("#")
        for key, separator, value in [line.partition("=")]
        if separator
    }


def load_velagw_shprod_resources() -> tuple[dict, list[dict]]:
    return load_velagw_resources("shprod")


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

    def test_beijing_ctl_routes_only_the_llmgateway_canary(self) -> None:
        secret = yaml.safe_load(
            (REPO_ROOT / "argocd/secrets/beijing-sandbox/ctl-runtime-secrets.sops.yaml").read_text()
        )
        values = secret.get("stringData") or {}

        self.assertEqual(
            values.get("CTL_LLMGATEWAY_NEW_USER_ALLOWLIST"),
            "usr_31b0bd10d198d7aa7012fbf0,usr_cd57811ec414ce48e8d40c6c",
        )
        self.assertEqual(
            values.get("CTL_LLMGATEWAY_RENEWAL_MIGRATION_ALLOWLIST"),
            "usr_31b0bd10d198d7aa7012fbf0,usr_cd57811ec414ce48e8d40c6c",
        )

    def test_shprod_ctl_routes_new_users_and_bot_creates_to_llmgateway(self) -> None:
        secret = yaml.safe_load(
            (REPO_ROOT / "argocd/secrets/shprod/ctl-runtime-secrets.sops.yaml").read_text()
        )
        values = secret.get("stringData") or {}

        self.assertEqual(values.get("CTL_LLMGATEWAY_BASE_URL"), "https://token-admin.lightvela.com")
        self.assertEqual(values.get("CTL_LLMGATEWAY_DEFAULT_BASE_URL"), "https://token.lightvela.com/v1")
        self.assertEqual(values.get("CTL_LLMGATEWAY_DEFAULT_MODEL_ID"), "auto")
        self.assertEqual(values.get("CTL_LLMGATEWAY_NEW_USER_ALLOWLIST"), "*")
        self.assertEqual(values.get("CTL_LLMGATEWAY_BOT_CREATE_MIGRATION_ALLOWLIST"), "*")
        self.assertEqual(
            values.get("CTL_LLMGATEWAY_RENEWAL_MIGRATION_ALLOWLIST"),
            "usr_58b6bb1f68ba7f46584bd282",
        )
        for key in ("CTL_LLMGATEWAY_ADMIN_TOKEN", "CTL_LLMGATEWAY_INTERNAL_SERVICE_TOKEN"):
            with self.subTest(key=key):
                self.assertRegex(values.get(key, ""), r"^ENC\[")

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

    def test_user_auth_prod_projection_covers_ksops_secret_files(self) -> None:
        manifest = load_manifest()

        for env in ("shprod", "sgprod"):
            with self.subTest(env=env):
                bundle = require_build_metadata(load_bundle(manifest, "user-auth", env))
                service_root = REPO_ROOT / "argocd" / "services" / "lightclaw-auth" / env
                referenced_secrets = {
                    (generator.parent / secret_path).resolve().relative_to(REPO_ROOT).as_posix()
                    for generator in service_root.glob("ksops*-generator.yaml")
                    for secret_path in (yaml.safe_load(generator.read_text()) or {}).get("files", [])
                }

                self.assertFalse(
                    referenced_secrets - set(bundle.publish_paths),
                    f"user-auth/{env} publish projection misses KSOPS secrets: "
                    f"{sorted(referenced_secrets - set(bundle.publish_paths))}",
                )

    def test_ctl_prod_projection_covers_ksops_secret_files(self) -> None:
        manifest = load_manifest()
        workflow = (REPO_ROOT / ".ci" / "ctl.yml").read_text()

        workflow_config = yaml.safe_load(workflow) or {}
        workflow_parameters = (workflow_config.get("extends") or {}).get("parameters") or {}
        self.assertIs(workflow_parameters.get("ENABLE_MASTER_PROD_DB_MIGRATION"), True)
        self.assertIs(workflow_parameters.get("ENABLE_MASTER_SHPROD_DB_MIGRATION"), False)
        self.assertIs(workflow_parameters.get("ENABLE_MASTER_SGPROD_DB_MIGRATION"), True)

        for env in ("shprod", "sgprod"):
            with self.subTest(env=env):
                bundle = require_build_metadata(load_bundle(manifest, "ctl", env))
                service_root = REPO_ROOT / "argocd" / "services" / "ctl" / env
                referenced_secrets = {
                    (generator.parent / secret_path).resolve().relative_to(REPO_ROOT).as_posix()
                    for generator in service_root.glob("ksops*-generator.yaml")
                    for secret_path in (yaml.safe_load(generator.read_text()) or {}).get("files", [])
                }

                self.assertFalse(
                    referenced_secrets - set(bundle.publish_paths),
                    f"ctl/{env} publish projection misses KSOPS secrets: "
                    f"{sorted(referenced_secrets - set(bundle.publish_paths))}",
                )

        self.assertIn("argocd/secrets/*/ctl-agentchat-secrets.sops.yaml", workflow)
        self.assertIn("argocd/secrets/*/ctl-website-runtime-secrets.sops.yaml", workflow)

    def test_sgprod_website_cos_lifecycle_only_expires_temporary_artifacts(self) -> None:
        lifecycle_path = (
            REPO_ROOT
            / "argocd"
            / "services"
            / "workers-website-deployer"
            / "sgprod"
            / "website-cos-lifecycle.xml"
        )
        self.assertTrue(lifecycle_path.is_file(), f"missing desired COS lifecycle: {lifecycle_path}")

        rule = ET.parse(lifecycle_path).getroot().find("Rule")
        self.assertIsNotNone(rule)
        self.assertEqual(rule.findtext("Status"), "Enabled")
        self.assertEqual(rule.findtext("Filter/Prefix"), "_artifacts/")
        self.assertEqual(rule.findtext("Expiration/Days"), "2")
        self.assertEqual(rule.findtext("AbortIncompleteMultipartUpload/DaysAfterInitiation"), "1")

    def test_sgprod_site_gateway_tls_binding_is_platform_owned(self) -> None:
        service_root = REPO_ROOT / "argocd" / "services" / "site-gateway" / "sgprod"
        kustomization = yaml.safe_load((service_root / "kustomization.yaml").read_text()) or {}
        resources = kustomization.get("resources") or []
        platform_values = {
            key: value
            for line in (service_root / "site-gateway-platform.env").read_text().splitlines()
            if line and not line.startswith("#")
            for key, separator, value in [line.partition("=")]
            if separator
        }

        self.assertNotIn("tls-secrets.yaml", resources)
        self.assertFalse((service_root / "tls-secrets.yaml").exists())
        self.assertEqual(platform_values.get("SITE_GATEWAY_TLS_SECRET_NAME"), "site-gateway-wildcard-tls")

        readme = (service_root / "README.md").read_text()
        self.assertIn("TLS lifecycle is platform-owned", readme)
        self.assertIn("does not create, update, or rotate that Secret", readme)

    def test_site_gateway_auth_contract_keeps_international_public(self) -> None:
        base_manifest = REPO_ROOT / "site-gateway" / "k8s" / "base" / "manifests.yaml"
        documents = list(yaml.safe_load_all(base_manifest.read_text()))
        config_map = next(doc for doc in documents if doc.get("kind") == "ConfigMap")
        for key in (
            "SITE_GATEWAY_AUTH_MODE",
            "SITE_GATEWAY_AUTH_ISSUER",
            "SITE_GATEWAY_AUTH_AUDIENCE",
            "SITE_GATEWAY_AUTH_START_URL",
            "SITE_GATEWAY_AUTH_PUBLIC_KEYS",
            "SITE_GATEWAY_AUTH_SESSION_TTL",
        ):
            self.assertIn(key, config_map.get("data", {}))

        platform_values = {
            key: value
            for line in (
                REPO_ROOT / "argocd" / "services" / "site-gateway" / "sgprod" / "site-gateway-platform.env"
            ).read_text().splitlines()
            if line and not line.startswith("#")
            for key, separator, value in [line.partition("=")]
            if separator
        }
        self.assertEqual(platform_values.get("SITE_GATEWAY_AUTH_MODE"), "public")

        bundle = (REPO_ROOT / ".ci" / "runtime" / "bundles" / "site-gateway.bundle").read_text()
        self.assertIn("site-gateway/docs", bundle)

    def test_user_auth_realname_mode_matches_deploy_facing_config(self) -> None:
        for env in ("beijing-sandbox", "shprod"):
            with self.subTest(env=env):
                source_patch = next(
                    doc
                    for doc in yaml.safe_load_all(
                        (REPO_ROOT / f"user/auth/k8s/overlays/{env}/patch-realname-faceid.yaml").read_text()
                    )
                    if doc.get("kind") == "ConfigMap"
                )
                deploy_patch = next(
                    doc
                    for doc in yaml.safe_load_all(
                        (REPO_ROOT / f"argocd/services/lightclaw-auth/{env}/patch-shadowbinding.yaml").read_text()
                    )
                    if doc.get("kind") == "ConfigMap"
                )
                source_mode = source_patch["data"]["LIGHTCLAW_REALNAME_ASSURANCE_MODE"]
                deploy_mode = deploy_patch["data"]["LIGHTCLAW_REALNAME_ASSURANCE_MODE"]

                self.assertEqual(source_mode, "faceless")
                self.assertEqual(deploy_mode, source_mode)

    def test_beijing_shadow_callback_prefix_matches_deploy_facing_config(self) -> None:
        source_patch = yaml.safe_load(
            (REPO_ROOT / "user/auth/k8s/overlays/beijing-sandbox/patch-shadowbinding.yaml").read_text()
        )
        deploy_patch = next(
            doc
            for doc in yaml.safe_load_all(
                (
                    REPO_ROOT
                    / "argocd/services/lightclaw-auth/beijing-sandbox/patch-shadowbinding.yaml"
                ).read_text()
            )
            if doc.get("kind") == "ConfigMap"
        )

        self.assertEqual(source_patch["data"]["SHADOW_USER_NAME_PREFIX"], "bjsbx_")
        self.assertEqual(
            deploy_patch["data"]["SHADOW_USER_NAME_PREFIX"],
            source_patch["data"]["SHADOW_USER_NAME_PREFIX"],
        )

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

    def test_japan_playground_identity_uses_tokyo_catalog(self) -> None:
        self.assertTrue(is_playground_env(JAPAN_PLAYGROUND_ENV))
        self.assertEqual(playground_region(JAPAN_PLAYGROUND_ENV), "jp")
        self.assertEqual(
            playground_catalog_root(JAPAN_PLAYGROUND_ENV),
            "argocd/catalogs/playground/tokyo-playground",
        )
        for malformed in ("sandbox-jp", "sandbox-jp-", "sandbox-jp-one", "sandbox-jp-1-extra"):
            with self.subTest(env=malformed):
                self.assertFalse(is_playground_env(malformed))

    def test_japan_playground_buildable_bundles_use_jp_registry(self) -> None:
        manifest = load_manifest()
        actual_buildable: set[str] = set()

        for bundle_name in sorted((manifest.get("bundles") or {})):
            try:
                bundle = require_build_metadata(load_bundle(manifest, bundle_name, JAPAN_PLAYGROUND_ENV))
            except ValueError:
                continue
            actual_buildable.add(bundle_name)
            repositories = [target.image_repo for target in bundle.image_targets]
            if bundle.image_repo:
                repositories.append(bundle.image_repo)
            self.assertTrue(repositories, bundle_name)
            for repository in repositories:
                with self.subTest(bundle=bundle_name, repository=repository):
                    self.assertTrue(
                        repository.startswith("lightclaw-jp1.tencentcloudcr.com/lightclaw/"),
                        repository,
                    )

        self.assertEqual(actual_buildable, PLAYGROUND_BUILDABLE_BUNDLES)

    def test_japan_master_release_uses_independent_service_workflows(self) -> None:
        manifest = load_manifest()

        for bundle_name, (workflow_path, source_workflow_path, pin_targets, runner_pool) in (
            TOKYO_RELEASE_WORKFLOWS.items()
        ):
            with self.subTest(bundle=bundle_name):
                require_build_metadata(load_bundle(manifest, bundle_name, JAPAN_PLAYGROUND_ENV))
                workflow_entry = yaml.safe_load((REPO_ROOT / workflow_path).read_text())
                source_workflow = yaml.safe_load((REPO_ROOT / source_workflow_path).read_text())
                effective_workflow = self.load_effective_workflow(workflow_path)
                push = self.push_config(workflow_entry)

                self.assertEqual(push.get("branches"), ["master", "playground/sandbox-jp-*"])
                self.assertEqual(push.get("paths"), self.push_paths(source_workflow))
                self.assertEqual(push.get("paths-ignore"), self.push_paths_ignore(source_workflow))
                self.assertEqual(
                    (workflow_entry.get("concurrency") or {}).get("group"),
                    f"mono2-service-release-tokyo-{Path(workflow_path).stem.removeprefix('tokyo-')}",
                )
                self.assert_release_entry_targets(
                    workflow_entry,
                    expected_service=bundle_name,
                    expected_pin_targets=pin_targets,
                    expected_master_build_envs=JAPAN_PLAYGROUND_ENV,
                    expected_master_auto_pin_envs=JAPAN_PLAYGROUND_ENV,
                    expected_playground_build_envs="auto",
                    expected_playground_auto_pin_envs="auto",
                )
                parameters = (workflow_entry.get("extends") or {}).get("parameters") or {}
                self.assertEqual(parameters.get("DEFAULT_TARGET_ENV"), JAPAN_PLAYGROUND_ENV)
                self.assertEqual(parameters.get("RUNNER_POOL_NAME", "env"), runner_pool)
                self.assertIs(parameters.get("ENABLE_MASTER_PROD_PROMOTE"), False)
                self.assert_registry_credentials_cover_build_envs(effective_workflow, JAPAN_PLAYGROUND_ENV)

        source_workflow_paths = {item[1] for item in TOKYO_RELEASE_WORKFLOWS.values()}
        tokyo_workflow_paths = {item[0] for item in TOKYO_RELEASE_WORKFLOWS.values()}
        self.assertTrue(source_workflow_paths.isdisjoint(tokyo_workflow_paths))

        template_text = (REPO_ROOT / ".ci/templates/service-release.yml").read_text()
        init_text = (REPO_ROOT / ".ci/init.sh").read_text()
        runtime_text = (REPO_ROOT / ".ci/runtime/build_and_promote_to_gitops.sh").read_text()
        pin_text = (REPO_ROOT / ".ci/runtime/pin_image_to_gitops.sh").read_text()
        self.assertIn("playground/sandbox-jp-*", template_text)
        jp_registry_credential = "${{ settings.TCR_JP1_REGISTRY_CREDENTIAL.password }}"
        self.assertEqual(template_text.count(jp_registry_credential), 2)
        self.assertNotIn("${{ settings.TCR_JP1_PASSWORD }}", template_text)
        self.assertIn("sandbox-jp-*|tokyo-sandbox", init_text)
        self.assertIn("/etc/lightclaw-ci/tcr_jp1_password", init_text)
        self.assertIn('password_var="${TCR_JP1_PASSWORD:-}"', init_text)
        self.assertNotIn('TCR_JP1_PASSWORD:-${TCR_BEIJING_PASSWORD', init_text)
        self.assertIn('sandbox-jp-* ]]', runtime_text)
        self.assertIn("sandbox-jp-*) printf '东京 Playground %s'", pin_text)

    def test_japan_auth_ssm_manifest_declares_required_keys_without_values(self) -> None:
        manifest_path = REPO_ROOT / "scripts/ssm_manifest.lightclaw-auth.sandbox-jp-1.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())

        self.assertEqual(manifest["defaults"]["region"], "ap-tokyo")
        self.assertEqual(manifest["defaults"]["version_id"], "SSM_Current")
        self.assertEqual(len(manifest["items"]), 1)
        item = manifest["items"][0]
        self.assertEqual(item["secret_name"], "mono-sandbox-jp-1-lightclaw-auth-secrets")
        self.assertEqual(item["namespace"], "lightvela-playground-sandbox-jp-1")
        self.assertEqual(
            item["required_keys"],
            [
                "LIGHTCLAW_ADMIN_TOKEN",
                "LIGHTCLAW_AUTH_DB_PASSWORD",
                "LIGHTCLAW_COS_BUCKET_URL",
                "LIGHTCLAW_COS_SECRET_ID",
                "LIGHTCLAW_COS_SECRET_KEY",
                "LIGHTCLAW_GITHUB_CLIENT_SECRET",
                "LIGHTCLAW_QQ_APP_KEY",
                "LIGHTCLAW_WECHAT_APP_SECRET",
                "LIGHTVELA_WECHAT_OFFICIAL_ACCOUNT_APP_SECRET",
                "LIGHTCLAW_SES_SECRET_ID",
                "LIGHTCLAW_SES_SECRET_KEY",
                "TENCENT_REALNAME_SECRET_ID",
                "TENCENT_REALNAME_SECRET_KEY",
                "TENCENT_REALNAME_ENDPOINT",
                "REALNAME_ENCRYPTION_KEY",
                "TENCENT_REALNAME_FACEID_RULE_ID",
                "TENCENT_REALNAME_ACCOUNT_ID",
                "TENCENT_REALNAME_FACEID_REDIRECT_URL",
            ],
        )
        self.assertNotIn("values", item)
        self.assertNotIn("stringData", item)

    def test_japan_runtime_ssm_manifest_is_independent_and_complete(self) -> None:
        manifest_path = REPO_ROOT / "scripts/ssm_manifest.runtime.sandbox-jp-1.yaml"
        manifest = yaml.safe_load(manifest_path.read_text())

        self.assertEqual(manifest["defaults"]["region"], "ap-tokyo")
        self.assertEqual(manifest["defaults"]["version_id"], "SSM_Current")
        items = manifest["items"]
        self.assertEqual(len(items), 16)
        self.assertEqual(len({item["id"] for item in items}), 16)
        for item in items:
            with self.subTest(item=item["id"]):
                self.assertTrue(item["secret_name"].startswith("mono-sandbox-jp-1-"))
                self.assertEqual(item["namespace"], "lightvela-playground-sandbox-jp-1")
                self.assertTrue(item["output_path"].startswith("argocd/secrets/sandbox-jp-1/"))
                self.assertTrue(item["required_keys"])
                self.assertNotIn("values", item)
                self.assertNotIn("stringData", item)

        expected_outputs = {
            "admin-gateway-runtime-secrets.sops.yaml",
            "ai-gateway-runtime-secrets.sops.yaml",
            "cloudladder-callback-secrets.sops.yaml",
            "credit-runtime-secrets.sops.yaml",
            "ctl-conf-common.sops.yaml",
            "ctl-conf-rewrite.sops.yaml",
            "ctl-runtime-secrets.sops.yaml",
            "gateway-dashboard-runtime-secrets.sops.yaml",
            "nextgen-dashboard-runtime-secrets.sops.yaml",
            "payment-runtime-secrets.sops.yaml",
            "sandbox-runtime-secrets.sops.yaml",
            "service-gateway-runtime-secrets.sops.yaml",
            "session-runtime-secrets.sops.yaml",
            "shadow-runtime-secrets.sops.yaml",
            "subscription-runtime-secrets.sops.yaml",
            "trade-runtime-secrets.sops.yaml",
        }
        self.assertEqual(
            {Path(item["output_path"]).name for item in items},
            expected_outputs,
        )
        service_gateway = next(
            item for item in items if item["id"] == "service-gateway-runtime-secrets"
        )
        self.assertEqual(
            service_gateway["required_keys"],
            [
                "SERVICE_GATEWAY_ADMIN_BASIC_AUTH_PASSWORD",
                "SERVICE_GATEWAY_ADMIN_BASIC_AUTH_USER",
            ],
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

    def test_workers_release_bundle_targets_shanghai_worker_cluster(self) -> None:
        manifest = load_manifest()

        bundle = require_build_metadata(load_bundle(manifest, "workers", "shanghai-workers"))
        workflow = yaml.safe_load((REPO_ROOT / ".ci/workers.yml").read_text())
        workflow_params = (workflow.get("extends") or {}).get("parameters") or {}

        self.assertEqual(bundle.image_repo, "lightclaw-shprod.tencentcloudcr.com/lightclaw/workers")
        self.assertEqual(workflow_params.get("SERVICE"), "workers")
        self.assertEqual(workflow_params.get("BUNDLE"), "workers-rescue-exporter,workers-hermes-importer")
        self.assertIn("workers/catalog.yaml", bundle.allowed_paths)
        self.assertIn("argocd/apps/shanghai-workers/workers-runtime.yaml", bundle.publish_paths)
        self.assertIn("argocd/apps/shanghai-workers/workers-rescue-exporter.yaml", bundle.publish_paths)
        self.assertIn("argocd/apps/shanghai-workers/workers-hermes-importer.yaml", bundle.publish_paths)
        self.assertIn("argocd/services/workers-runtime/shanghai-workers/**", bundle.publish_paths)
        self.assertIn("argocd/services/workers-rescue-exporter/shanghai-workers/**", bundle.publish_paths)
        self.assertIn("argocd/services/workers-hermes-importer/shanghai-workers/**", bundle.publish_paths)
        self.assertIn("argocd/root/shanghai-workers.yaml", bundle.publish_paths)
        self.assertIn("argocd/projects/shanghai-workers.yaml", bundle.publish_paths)
        self.assertIn("argocd/clusters/shanghai-workers.yaml", bundle.publish_paths)
        self.assertIn("argocd/secrets/shanghai-workers/workers-runtime-secrets.sops.yaml", bundle.publish_paths)

    def test_velagw_release_bundle_targets_beijing_llmgateway_cluster(self) -> None:
        manifest = load_manifest()

        bundle = require_build_metadata(load_bundle(manifest, "velagw", "beijing-llmgateway"))
        workflow = yaml.safe_load((REPO_ROOT / ".ci/velagw.yml").read_text())
        parameters = (workflow.get("extends") or {}).get("parameters") or {}
        app = yaml.safe_load((REPO_ROOT / "argocd/apps/beijing-llmgateway/velagw.yaml").read_text())
        project = yaml.safe_load((REPO_ROOT / "argocd/projects/beijing-llmgateway.yaml").read_text())
        cluster = yaml.safe_load((REPO_ROOT / "argocd/clusters/beijing-llmgateway.yaml").read_text())
        service_root = REPO_ROOT / "argocd/services/velagw/beijing-llmgateway"
        kustomization = yaml.safe_load((service_root / "kustomization.yaml").read_text())
        workloads = (service_root / "workloads.yaml").read_text()
        workload_docs = list(yaml.safe_load_all(workloads))
        shard_manager_docs = list(yaml.safe_load_all((service_root / "shard-manager.yaml").read_text()))
        traffic = next(
            doc
            for doc in workload_docs
            if doc
            and doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == "llmgateway-traffic"
        )
        traffic_container = next(
            container
            for container in traffic["spec"]["template"]["spec"]["containers"]
            if container.get("name") == "traffic"
        )
        traffic_env = {entry["name"]: entry.get("value") for entry in traffic_container.get("env", [])}
        core_worker = next(
            doc
            for doc in workload_docs
            if doc
            and doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == "llmgateway-worker-core"
        )
        core_worker_container = next(
            container
            for container in core_worker["spec"]["template"]["spec"]["containers"]
            if container.get("name") == "worker"
        )
        core_worker_env = {
            entry["name"]: entry.get("value") for entry in core_worker_container.get("env", [])
        }

        self.assertEqual(bundle.image_repo, "lightclaw-bj82.tencentcloudcr.com/llmgateway/llmgateway")
        self.assertEqual(parameters.get("SERVICE"), "velagw")
        self.assertEqual(parameters.get("MASTER_BUILD_ENVS"), "beijing-llmgateway,shprod,sgprod")
        self.assertEqual(parameters.get("MASTER_AUTO_PIN_ENVS"), "beijing-llmgateway")
        self.assertEqual(app["spec"]["destination"]["name"], "beijing-llmgateway")
        self.assertEqual(app["spec"]["source"]["path"], "argocd/services/velagw/beijing-llmgateway")
        self.assertEqual(cluster["spec"]["namespaces"], ["llmgateway"])
        self.assertTrue(cluster["spec"]["clusterResources"])
        self.assertIn("argocd/services/velagw/beijing-llmgateway/**", bundle.publish_paths)
        self.assertNotIn("kind: Secret", workloads)
        self.assertNotIn("kind: LLMFleet", workloads)
        self.assertNotIn("llmgateway-set-manager", workloads)
        self.assertEqual(traffic_env.get("LLMGATEWAY_SET_RUNTIME_ROUTE_REQUIRED"), "true")
        self.assertEqual(core_worker_env.get("LLMGATEWAY_SET_AUTOSCALER_RUNTIME_BACKEND"), "velagwset")
        self.assertEqual(core_worker_env.get("LLMGATEWAY_SET_AUTOSCALER_WRITER_EPOCH"), "2")
        self.assertEqual(
            kustomization.get("resources"),
            [
                "workloads.yaml",
                "llmfleet-rgd.yaml",
                "velagwset-crd.yaml",
                "velagwset-delete-policy.yaml",
                "velagwset-controller.yaml",
                "velagwset-provisioner.yaml",
                "shard-manager.yaml",
                "release-bootstrap.yaml",
            ],
        )
        cluster_resource_whitelist = {
            (entry.get("group"), entry.get("kind"))
            for entry in project["spec"].get("clusterResourceWhitelist", [])
        }
        self.assertTrue(
            {
                ("kro.run", "ResourceGraphDefinition"),
                ("apiextensions.k8s.io", "CustomResourceDefinition"),
                ("admissionregistration.k8s.io", "ValidatingAdmissionPolicy"),
                ("admissionregistration.k8s.io", "ValidatingAdmissionPolicyBinding"),
            }
            <= cluster_resource_whitelist
        )
        image_replacement_targets = {
            (target.get("select") or {}).get("name")
            for replacement in kustomization.get("replacements", [])
            if (replacement.get("source") or {}).get("fieldPath") == "data.VELAGW_IMAGE"
            for target in replacement.get("targets", [])
        }
        self.assertIn("velagwset-controller", image_replacement_targets)
        self.assertIn("velagwset-provisioner", image_replacement_targets)
        self.assertIn("llmgateway-shard-manager", image_replacement_targets)
        self.assertIn("llmgateway-release-bootstrap", image_replacement_targets)
        shard_manager = next(
            doc
            for doc in shard_manager_docs
            if doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == "llmgateway-shard-manager"
        )
        self.assertEqual(shard_manager["spec"].get("replicas"), 2)
        shard_manager_container = next(
            container
            for container in shard_manager["spec"]["template"]["spec"]["containers"]
            if container.get("name") == "shard-manager"
        )
        self.assertIn("--leader-elect", shard_manager_container.get("args", []))
        shard_manager_env = {
            entry["name"]: entry for entry in shard_manager_container.get("env", [])
        }
        self.assertEqual(
            shard_manager_env["INTERNAL_SERVICE_TOKEN"]["valueFrom"]["secretKeyRef"],
            {"name": "llmgateway-control-runtime", "key": "INTERNAL_SERVICE_TOKEN"},
        )
        shard_manager_role = next(
            doc
            for doc in shard_manager_docs
            if doc.get("kind") == "Role"
            and (doc.get("metadata") or {}).get("name") == "llmgateway-shard-manager"
        )
        llmfleet_rule = next(
            rule
            for rule in shard_manager_role["rules"]
            if "llmfleets" in rule.get("resources", [])
        )
        self.assertEqual(llmfleet_rule.get("verbs"), ["get", "list", "watch"])
        self.assertNotIn(
            "VELAGW_PROVISIONER_IMAGE=",
            (service_root / "velagw-platform.env").read_text(),
        )
        for resource in (
            "llmfleet-rgd.yaml",
            "velagwset-crd.yaml",
            "velagwset-delete-policy.yaml",
            "velagwset-controller.yaml",
            "velagwset-provisioner.yaml",
            "shard-manager.yaml",
        ):
            with self.subTest(resource=resource):
                self.assertTrue((service_root / resource).is_file())

        for resource in ("llmfleet-rgd.yaml", "velagwset-crd.yaml", "velagwset-delete-policy.yaml"):
            with self.subTest(resource=resource):
                self.assertEqual(
                    (service_root / resource).read_text(),
                    (REPO_ROOT / "velagw/deploy/k8s/prod/gitops-base" / resource).read_text().replace(
                        "# Shared by every production VelaGW regional overlay.\n",
                        "",
                        1,
                    ),
                )
                for document in yaml.safe_load_all((service_root / resource).read_text()):
                    annotations = ((document or {}).get("metadata") or {}).get("annotations") or {}
                    self.assertIn(
                        "Prune=false",
                        annotations.get("argocd.argoproj.io/sync-options", ""),
                    )

    def test_velagw_image_build_runs_backend_and_console_tests(self) -> None:
        dockerfile = (REPO_ROOT / "velagw/Dockerfile").read_text()
        dockerignore = (REPO_ROOT / "velagw/.dockerignore").read_text().splitlines()

        self.assertIn("RUN apk add --no-cache bash curl git jq", dockerfile)
        self.assertIn("COPY .gitignore ./.gitignore", dockerfile)
        self.assertNotIn(".gitignore", dockerignore)
        for package_root in ("cmd", "internal", "deploy", "docs", "k8s", "openspec", "test"):
            with self.subTest(package_root=package_root):
                self.assertIn(f"COPY {package_root} ./{package_root}", dockerfile)

        go_test = dockerfile.index("RUN git init --quiet && go test ./...")
        go_build = dockerfile.index("RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build")
        console_install = dockerfile.index("RUN corepack enable && pnpm install --frozen-lockfile")
        console_test = dockerfile.index("RUN pnpm test")
        console_build = dockerfile.index("RUN pnpm run build")

        self.assertLess(go_test, go_build)
        self.assertLess(console_install, console_test)
        self.assertLess(console_test, console_build)

    def test_velagw_release_bundle_targets_shanghai_production_cluster(self) -> None:
        manifest = load_manifest()

        bundle = require_build_metadata(load_bundle(manifest, "velagw", "shprod"))
        workflow = yaml.safe_load((REPO_ROOT / ".ci/velagw.yml").read_text())
        parameters = (workflow.get("extends") or {}).get("parameters") or {}
        app = yaml.safe_load((REPO_ROOT / "argocd/apps/shprod/velagw.yaml").read_text())
        project = yaml.safe_load((REPO_ROOT / "argocd/projects/shprod-velagw.yaml").read_text())
        cluster = yaml.safe_load((REPO_ROOT / "argocd/clusters/shanghai-llmgateway-prod.yaml").read_text())

        self.assertEqual(bundle.image_repo, "lightclaw-shprod.tencentcloudcr.com/llmgateway/llmgateway")
        self.assertEqual(parameters.get("DEFAULT_TARGET_ENV"), "shprod")
        self.assertEqual(parameters.get("MASTER_BUILD_ENVS"), "beijing-llmgateway,shprod,sgprod")
        self.assertEqual(parameters.get("MASTER_AUTO_PIN_ENVS"), "beijing-llmgateway")
        self.assertTrue(parameters.get("ENABLE_MASTER_PROD_PROMOTE"))

        self.assertEqual(app["spec"]["project"], "shprod-velagw")
        self.assertEqual(app["spec"]["source"]["repoURL"], "git@git.woa.com:wisp/mono2.git")
        self.assertEqual(app["spec"]["source"]["targetRevision"], "gitops")
        self.assertEqual(app["spec"]["source"]["path"], "argocd/services/velagw/shprod")
        self.assertEqual(app["spec"]["destination"]["name"], "shanghai-llmgateway-prod")
        self.assertEqual(app["spec"]["destination"]["namespace"], "llmgateway")
        self.assertNotIn("automated", app["spec"].get("syncPolicy") or {})

        self.assertEqual(project["spec"]["sourceRepos"], ["git@git.woa.com:wisp/mono2.git"])
        self.assertEqual(
            project["spec"]["destinations"],
            [{"namespace": "llmgateway", "name": "shanghai-llmgateway-prod"}],
        )
        self.assertEqual(cluster["spec"]["server"], "https://43.180.150.109:443")
        self.assertEqual(cluster["spec"]["tlsServerName"], "cls-baiv5l5p.ccs.tencent-cloud.com")
        self.assertEqual(cluster["spec"]["projectPath"], "argocd/projects/shprod-velagw.yaml")
        self.assertEqual(cluster["spec"]["namespaces"], ["llmgateway"])
        self.assertTrue(cluster["spec"]["clusterResources"])

        self.assertIn("argocd/apps/shprod/velagw.yaml", bundle.publish_paths)
        self.assertIn("argocd/projects/shprod-velagw.yaml", bundle.publish_paths)
        self.assertIn("argocd/clusters/shanghai-llmgateway-prod.yaml", bundle.publish_paths)
        self.assertIn("argocd/services/velagw/shprod/**", bundle.publish_paths)
        self.assertIn("velagw/deploy/k8s/prod/gitops-base/**", bundle.publish_paths)

        kustomization, resource_docs = load_velagw_shprod_resources()
        kinds = {doc.get("kind") for doc in resource_docs}
        self.assertNotIn("Secret", kinds)
        self.assertNotIn("Namespace", kinds)
        self.assertNotIn("LLMFleet", kinds)
        self.assertIn("ResourceGraphDefinition", kinds)
        self.assertIn("CustomResourceDefinition", kinds)
        self.assertIn("ValidatingAdmissionPolicy", kinds)
        self.assertIn("ValidatingAdmissionPolicyBinding", kinds)
        self.assertEqual(
            kustomization.get("resources"),
            ["../../../../velagw/deploy/k8s/prod/gitops-base"],
        )

        cluster_resource_whitelist = {
            (entry.get("group"), entry.get("kind"))
            for entry in project["spec"].get("clusterResourceWhitelist", [])
        }
        self.assertTrue(
            {
                ("kro.run", "ResourceGraphDefinition"),
                ("apiextensions.k8s.io", "CustomResourceDefinition"),
                ("admissionregistration.k8s.io", "ValidatingAdmissionPolicy"),
                ("admissionregistration.k8s.io", "ValidatingAdmissionPolicyBinding"),
            }
            <= cluster_resource_whitelist
        )

        traffic = next(
            doc
            for doc in resource_docs
            if doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == "llmgateway-traffic"
        )
        traffic_container = next(
            container
            for container in traffic["spec"]["template"]["spec"]["containers"]
            if container.get("name") == "traffic"
        )
        traffic_env = {entry["name"]: entry.get("value") for entry in traffic_container.get("env", [])}
        self.assertEqual(traffic_env.get("LLMGATEWAY_SET_RUNTIME_ROUTE_REQUIRED"), "true")

        core_worker = next(
            doc
            for doc in resource_docs
            if doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == "llmgateway-worker-core"
        )
        core_worker_container = next(
            container
            for container in core_worker["spec"]["template"]["spec"]["containers"]
            if container.get("name") == "worker"
        )
        core_worker_env = {
            entry["name"]: entry.get("value") for entry in core_worker_container.get("env", [])
        }
        self.assertEqual(core_worker_env.get("LLMGATEWAY_SET_AUTOSCALER_RUNTIME_BACKEND"), "velagwset")
        self.assertEqual(core_worker_env.get("LLMGATEWAY_SET_AUTOSCALER_WRITER_EPOCH"), "2")

        deployments = {
            (doc.get("metadata") or {}).get("name"): doc
            for doc in resource_docs
            if doc.get("kind") == "Deployment"
        }
        controller = deployments["velagwset-controller"]
        provisioner = deployments["velagwset-provisioner"]
        shard_manager = deployments["llmgateway-shard-manager"]
        self.assertEqual(controller["spec"].get("replicas"), 2)
        self.assertEqual(provisioner["spec"].get("replicas"), 2)
        self.assertEqual(shard_manager["spec"].get("replicas"), 2)
        shard_manager_container = next(
            container
            for container in shard_manager["spec"]["template"]["spec"]["containers"]
            if container.get("name") == "shard-manager"
        )
        self.assertIn("--leader-elect", shard_manager_container.get("args", []))
        shard_manager_env = {
            entry["name"]: entry for entry in shard_manager_container.get("env", [])
        }
        self.assertEqual(
            shard_manager_env["INTERNAL_SERVICE_TOKEN"]["valueFrom"]["secretKeyRef"],
            {"name": "llmgateway-control-runtime", "key": "INTERNAL_SERVICE_TOKEN"},
        )
        shard_manager_role = next(
            doc
            for doc in resource_docs
            if doc.get("kind") == "Role"
            and (doc.get("metadata") or {}).get("name") == "llmgateway-shard-manager"
        )
        llmfleet_rule = next(
            rule
            for rule in shard_manager_role["rules"]
            if "llmfleets" in rule.get("resources", [])
        )
        self.assertEqual(llmfleet_rule.get("verbs"), ["get", "list", "watch"])

        controller_container = next(
            container
            for container in controller["spec"]["template"]["spec"]["containers"]
            if container.get("name") == "controller"
        )
        self.assertIn("--leader-elect", controller_container.get("args", []))
        self.assertNotIn("envFrom", controller_container)

        provisioner_container = next(
            container
            for container in provisioner["spec"]["template"]["spec"]["containers"]
            if container.get("name") == "provisioner"
        )
        provisioner_env = {
            entry["name"]: entry for entry in provisioner_container.get("env", [])
        }
        self.assertEqual(provisioner_env["LLMGATEWAY_CONTROL_URL"].get("value"), "http://llmgateway-control")
        self.assertEqual(provisioner_env["LLMGATEWAY_SET_SOURCE"].get("value"), "prod")
        self.assertEqual(provisioner_env["LLMGATEWAY_FLEET"].get("value"), "prod")
        self.assertEqual(
            load_platform_env("shprod")["VELAGW_VELAGWSET_SERVERLESS_TRAFFIC"],
            "true",
        )
        self.assertEqual(
            provisioner_env["INTERNAL_SERVICE_TOKEN"]["valueFrom"]["secretKeyRef"],
            {"name": "llmgateway-control-runtime", "key": "INTERNAL_SERVICE_TOKEN"},
        )

        image_replacement_targets = {
            (target.get("select") or {}).get("name")
            for replacement in kustomization.get("replacements", [])
            if (replacement.get("source") or {}).get("fieldPath") == "data.VELAGW_IMAGE"
            for target in replacement.get("targets", [])
        }
        self.assertIn("velagwset-controller", image_replacement_targets)
        self.assertIn("velagwset-provisioner", image_replacement_targets)
        self.assertIn("llmgateway-shard-manager", image_replacement_targets)
        self.assertIn("llmgateway-release-bootstrap", image_replacement_targets)
        self.assertFalse(
            any(
                doc.get("kind") == "CronJob"
                and (doc.get("metadata") or {}).get("name") == "llmgateway-set-manager"
                for doc in resource_docs
            )
        )
        bootstrap = next(
            doc
            for doc in resource_docs
            if doc.get("kind") == "Job"
            and (doc.get("metadata") or {}).get("name") == "llmgateway-release-bootstrap"
        )
        self.assertEqual(bootstrap["metadata"]["annotations"]["argocd.argoproj.io/hook"], "PostSync")

    def test_velagw_release_bundle_targets_johorbahru_sgprod_cluster(self) -> None:
        manifest = load_manifest()

        bundle = require_build_metadata(load_bundle(manifest, "velagw", "sgprod"))
        workflow = yaml.safe_load((REPO_ROOT / ".ci/velagw.yml").read_text())
        parameters = (workflow.get("extends") or {}).get("parameters") or {}
        app = yaml.safe_load((REPO_ROOT / "argocd/apps/sgprod/velagw.yaml").read_text())
        project = yaml.safe_load((REPO_ROOT / "argocd/projects/sgprod-velagw.yaml").read_text())
        cluster = yaml.safe_load((REPO_ROOT / "argocd/clusters/johorbahru-llmgateway-prod.yaml").read_text())
        service_root = REPO_ROOT / "argocd/services/velagw/sgprod"
        kustomization, resource_docs = load_velagw_resources("sgprod")

        self.assertEqual(bundle.image_repo, "lightclaw-sgprod.tencentcloudcr.com/lightclaw/velagw")
        self.assertEqual(parameters.get("MASTER_BUILD_ENVS"), "beijing-llmgateway,shprod,sgprod")
        self.assertEqual(parameters.get("MASTER_AUTO_PIN_ENVS"), "beijing-llmgateway")
        self.assertTrue(parameters.get("ENABLE_MASTER_PROD_PROMOTE"))

        self.assertEqual(app["spec"]["project"], "sgprod-velagw")
        self.assertEqual(app["spec"]["source"]["targetRevision"], "gitops")
        self.assertEqual(app["spec"]["source"]["path"], "argocd/services/velagw/sgprod")
        self.assertEqual(app["spec"]["destination"]["name"], "johorbahru-llmgateway-prod")
        self.assertEqual(app["spec"]["destination"]["namespace"], "llmgateway")
        self.assertNotIn("automated", app["spec"].get("syncPolicy") or {})

        self.assertEqual(
            project["spec"]["destinations"],
            [{"namespace": "llmgateway", "name": "johorbahru-llmgateway-prod"}],
        )
        self.assertEqual(cluster["spec"]["server"], "https://k8s-jhb.lightvela.com")
        self.assertEqual(cluster["spec"]["projectPath"], "argocd/projects/sgprod-velagw.yaml")
        self.assertEqual(cluster["spec"]["namespaces"], ["llmgateway"])
        self.assertTrue(cluster["spec"]["clusterResources"])

        self.assertIn("argocd/apps/sgprod/velagw.yaml", bundle.publish_paths)
        self.assertIn("argocd/projects/sgprod-velagw.yaml", bundle.publish_paths)
        self.assertIn("argocd/clusters/johorbahru-llmgateway-prod.yaml", bundle.publish_paths)
        self.assertIn("argocd/services/velagw/sgprod/**", bundle.publish_paths)
        self.assertIn("velagw/deploy/k8s/prod/gitops-base/**", bundle.publish_paths)

        kinds = {doc.get("kind") for doc in resource_docs}
        self.assertNotIn("Secret", kinds)
        self.assertNotIn("Namespace", kinds)
        self.assertNotIn("LLMFleet", kinds)

        workloads = [
            doc
            for doc in resource_docs
            if doc.get("kind") in {"Deployment", "Service"}
        ]
        core_worker = next(
            doc
            for doc in workloads
            if doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == "llmgateway-worker-core"
        )
        core_container = next(
            container
            for container in core_worker["spec"]["template"]["spec"]["containers"]
            if container.get("name") == "worker"
        )
        core_env = {entry["name"]: entry.get("value") for entry in core_container.get("env", [])}
        self.assertEqual(core_env.get("LLMGATEWAY_SET_AUTOSCALER_ENABLED"), "true")
        platform = load_platform_env("sgprod")
        self.assertEqual(platform["VELAGW_SET_AUTOSCALER_MIN_WARM_SETS"], "2")

        provisioner = next(
            doc
            for doc in workloads
            if doc.get("kind") == "Deployment"
            and (doc.get("metadata") or {}).get("name") == "velagwset-provisioner"
        )
        provisioner_container = next(
            container
            for container in provisioner["spec"]["template"]["spec"]["containers"]
            if container.get("name") == "provisioner"
        )
        provisioner_env = {
            entry["name"]: entry.get("value") for entry in provisioner_container.get("env", [])
        }
        self.assertEqual(platform["VELAGW_VELAGWSET_SERVERLESS_TRAFFIC"], "false")

        traffic_service = next(
            doc
            for doc in workloads
            if doc.get("kind") == "Service"
            and (doc.get("metadata") or {}).get("name") == "llmgateway-traffic"
        )
        protocol = platform["VELAGW_TRAFFIC_PROTOCOL"]
        self.assertIn("token.lightvela.ai", protocol)
        self.assertNotIn("token-jhb.lightvela.ai", protocol)
        self.assertIn("token-jhb-lightvela-ai-cert", protocol)
        control_protocol = platform["VELAGW_CONTROL_PROTOCOL"]
        self.assertIn("token-admin.lightvela.ai", control_protocol)
        self.assertNotIn("token-admin-jhb.lightvela.ai", control_protocol)

        ctl_runtime = yaml.safe_load(
            (REPO_ROOT / "argocd/secrets/sgprod/ctl-runtime-secrets.sops.yaml").read_text()
        )
        ctl_runtime_data = ctl_runtime["stringData"]
        self.assertEqual(
            ctl_runtime_data["CTL_LLMGATEWAY_BASE_URL"],
            "https://token-admin.lightvela.ai",
        )
        self.assertEqual(
            ctl_runtime_data["CTL_LLMGATEWAY_DEFAULT_BASE_URL"],
            "https://token.lightvela.ai/v1",
        )

        image_pin = (service_root / "velagw-platform.env").read_text()
        self.assertIn("lightclaw-sgprod.tencentcloudcr.com/lightclaw/velagw@sha256:", image_pin)

    def test_velagw_production_overlays_share_one_structural_base(self) -> None:
        base = REPO_ROOT / "velagw/deploy/k8s/prod/gitops-base"
        expected_base_files = {
            "kustomization.yaml",
            "workloads.yaml",
            "llmfleet-rgd.yaml",
            "velagwset-crd.yaml",
            "velagwset-delete-policy.yaml",
            "velagwset-controller.yaml",
            "velagwset-provisioner.yaml",
            "shard-manager.yaml",
            "release-bootstrap.yaml",
        }
        self.assertEqual(
            {path.name for path in base.iterdir() if path.is_file()},
            expected_base_files,
        )

        overlays = [REPO_ROOT / "argocd/services/velagw" / env for env in ("shprod", "sgprod")]
        for overlay in overlays:
            with self.subTest(overlay=overlay.name):
                self.assertEqual(
                    {path.name for path in overlay.iterdir() if path.is_file()},
                    {"README.md", "kustomization.yaml", "velagw-platform.env"},
                )
                kustomization = yaml.safe_load((overlay / "kustomization.yaml").read_text())
                self.assertEqual(
                    kustomization.get("resources"),
                    ["../../../../velagw/deploy/k8s/prod/gitops-base"],
                )

        self.assertEqual(
            (overlays[0] / "kustomization.yaml").read_text(),
            (overlays[1] / "kustomization.yaml").read_text(),
        )

        expected_keys = {
            "VELAGW_IMAGE",
            "VELAGW_DEPLOYED_AT",
            "VELAGW_OTEL_SERVICE_VERSION",
            "VELAGW_CLUSTER_NAME",
            "VELAGW_CLOUD_REGION",
            "VELAGW_CONTROL_PROTOCOL",
            "VELAGW_TRAFFIC_PROTOCOL",
            "VELAGW_SET_AUTOSCALER_MIN_WARM_SETS",
            "VELAGW_VELAGWSET_SERVERLESS_TRAFFIC",
            "VELAGW_SUBSCRIPTION_QUOTA_PACING_EFFECTIVE_AT",
        }
        expected_region_values = {
            "shprod": {
                "VELAGW_CLUSTER_NAME": "shanghai-llmgateway-prod",
                "VELAGW_CLOUD_REGION": "ap-shanghai",
                "VELAGW_SET_AUTOSCALER_MIN_WARM_SETS": "4",
                "VELAGW_VELAGWSET_SERVERLESS_TRAFFIC": "true",
                "VELAGW_SUBSCRIPTION_QUOTA_PACING_EFFECTIVE_AT": "0",
            },
            "sgprod": {
                "VELAGW_CLUSTER_NAME": "johorbahru-llmgateway-prod",
                "VELAGW_CLOUD_REGION": "ap-johorbahru",
                "VELAGW_SET_AUTOSCALER_MIN_WARM_SETS": "2",
                "VELAGW_VELAGWSET_SERVERLESS_TRAFFIC": "false",
                "VELAGW_SUBSCRIPTION_QUOTA_PACING_EFFECTIVE_AT": "0",
            },
        }
        for env, expected in expected_region_values.items():
            with self.subTest(env=env):
                platform = load_platform_env(env)
                self.assertEqual(set(platform), expected_keys)
                self.assertEqual(
                    {key: platform[key] for key in expected},
                    expected,
                )

    def test_velagw_beijing_otel_version_matches_subtree_source(self) -> None:
        marker = {}
        for line in (REPO_ROOT / "velagw/.mono2-subtree").read_text().splitlines():
            key, separator, value = line.partition("=")
            if separator:
                marker[key] = value
        expected_version = marker["upstream_commit"][:7]

        workloads = yaml.safe_load_all(
            (REPO_ROOT / "argocd/services/velagw/beijing-llmgateway/workloads.yaml").read_text()
        )
        actual_versions = {}
        for workload in workloads:
            if not workload or workload.get("kind") not in {"Deployment", "CronJob"}:
                continue
            if workload["kind"] == "CronJob":
                pod_spec = workload["spec"]["jobTemplate"]["spec"]["template"]["spec"]
            else:
                pod_spec = workload["spec"]["template"]["spec"]
            for container in pod_spec.get("containers", []):
                env = {entry["name"]: entry.get("value") for entry in container.get("env", [])}
                if "OTEL_SERVICE_VERSION" in env:
                    actual_versions[f"{workload['kind']}/{workload['metadata']['name']}/{container['name']}"] = env[
                        "OTEL_SERVICE_VERSION"
                    ]

        self.assertTrue(actual_versions)
        self.assertEqual(set(actual_versions.values()), {expected_version}, actual_versions)

    def test_velagw_production_otel_versions_match_subtree_source(self) -> None:
        marker = {}
        for line in (REPO_ROOT / "velagw/.mono2-subtree").read_text().splitlines():
            key, separator, value = line.partition("=")
            if separator:
                marker[key] = value
        expected_version = marker["upstream_commit"][:7]

        for env in ("shprod", "sgprod"):
            with self.subTest(env=env):
                self.assertEqual(
                    load_platform_env(env)["VELAGW_OTEL_SERVICE_VERSION"],
                    expected_version,
                )

    def test_workers_shanghai_overlay_uses_temporal_worker_deployment(self) -> None:
        rescue_deployment = yaml.safe_load(
            (REPO_ROOT / "workers/k8s/overlays/shanghai-workers/rescue-exporter/worker-deployment.yaml").read_text()
        )
        import_deployment = yaml.safe_load(
            (REPO_ROOT / "workers/k8s/overlays/shanghai-workers/hermes-importer/worker-deployment.yaml").read_text()
        )
        connection = yaml.safe_load(
            (REPO_ROOT / "workers/k8s/overlays/shanghai-workers/shared/connection.yaml").read_text()
        )
        overlay_readme = (REPO_ROOT / "workers/k8s/overlays/shanghai-workers/README.md").read_text()
        runtime_app = yaml.safe_load((REPO_ROOT / "argocd/apps/shanghai-workers/workers-runtime.yaml").read_text())
        rescue_app = yaml.safe_load((REPO_ROOT / "argocd/apps/shanghai-workers/workers-rescue-exporter.yaml").read_text())
        import_app = yaml.safe_load((REPO_ROOT / "argocd/apps/shanghai-workers/workers-hermes-importer.yaml").read_text())

        for worker_deployment in (rescue_deployment, import_deployment):
            self.assertEqual(worker_deployment["apiVersion"], "temporal.io/v1alpha1")
            self.assertEqual(worker_deployment["kind"], "WorkerDeployment")
            self.assertEqual(worker_deployment["spec"]["workerOptions"]["connectionRef"]["name"], "lightclaw-temporal")
            self.assertEqual(worker_deployment["spec"]["rollout"]["strategy"], "AllAtOnce")
        self.assertEqual(connection["kind"], "Connection")
        self.assertEqual(connection["spec"]["hostPort"], "temporal.lightvela.com:443")
        self.assertEqual(runtime_app["spec"]["source"]["path"], "argocd/services/workers-runtime/shanghai-workers")
        self.assertEqual(
            rescue_app["spec"]["source"]["path"],
            "argocd/services/workers-rescue-exporter/shanghai-workers",
        )
        self.assertEqual(
            import_app["spec"]["source"]["path"],
            "argocd/services/workers-hermes-importer/shanghai-workers",
        )
        self.assertIn("TEMPORAL_DEPLOYMENT_NAME", overlay_readme)
        self.assertIn("TEMPORAL_WORKER_BUILD_ID", overlay_readme)

    def test_workers_catalog_matches_shanghai_deploy_units(self) -> None:
        catalog = yaml.safe_load((REPO_ROOT / "workers/catalog.yaml").read_text())
        spec = catalog["spec"]
        env = spec["environments"]["shanghai-workers"]
        runtime = env["runtime"]
        workers = env["workers"]

        self.assertEqual(spec["image"]["bundle"], "workers")
        self.assertEqual(spec["image"]["key"], "WORKERS_IMAGE")
        self.assertEqual(env["namespace"], "temporal-workers")
        self.assertTrue((REPO_ROOT / runtime["sourceOverlay"]).is_dir())
        for worker in workers.values():
            self.assertTrue((REPO_ROOT / worker["sourceOverlay"]).is_dir())
            self.assertTrue((REPO_ROOT / worker["appPath"]).is_dir())
        self.assertTrue((REPO_ROOT / runtime["appPath"]).is_dir())

        workflow = yaml.safe_load((REPO_ROOT / ".ci/workers.yml").read_text())
        workflow_params = (workflow.get("extends") or {}).get("parameters") or {}
        self.assertEqual(workflow_params.get("SERVICE"), spec["image"]["bundle"])
        self.assertEqual(
            workflow_params.get("BUNDLE"),
            ",".join(worker["serviceId"] for worker in workers.values()),
        )

        runtime_app = yaml.safe_load((REPO_ROOT / "argocd/apps/shanghai-workers/workers-runtime.yaml").read_text())
        runtime_kustomization = yaml.safe_load((REPO_ROOT / runtime["appPath"] / "kustomization.yaml").read_text())
        connection = yaml.safe_load((REPO_ROOT / runtime["appPath"] / "connection.yaml").read_text())

        self.assertEqual(runtime_app["metadata"]["name"], runtime["appName"])
        self.assertEqual(runtime_app["spec"]["source"]["path"], runtime["appPath"])
        self.assertEqual(runtime_kustomization["namespace"], env["namespace"])
        self.assertEqual(connection["metadata"]["name"], runtime["temporalConnection"]["name"])
        self.assertEqual(connection["spec"]["hostPort"], runtime["temporalConnection"]["hostPort"])
        self.assertEqual(
            connection["spec"]["apiKeySecretRef"]["name"],
            runtime["temporalConnection"]["secretName"],
        )
        self.assertEqual(
            connection["spec"]["apiKeySecretRef"]["key"],
            runtime["temporalConnection"]["tokenKey"],
        )

        for app_file, worker in (
            ("workers-rescue-exporter.yaml", workers["rescue-exporter"]),
            ("workers-hermes-importer.yaml", workers["hermes-importer"]),
        ):
            worker_app = yaml.safe_load((REPO_ROOT / "argocd/apps/shanghai-workers" / app_file).read_text())
            worker_kustomization = yaml.safe_load((REPO_ROOT / worker["appPath"] / "kustomization.yaml").read_text())
            worker_deployment = yaml.safe_load((REPO_ROOT / worker["appPath"] / "worker-deployment.yaml").read_text())
            service_account = yaml.safe_load((REPO_ROOT / worker["appPath"] / "serviceaccount.yaml").read_text())
            platform_env = (REPO_ROOT / worker["appPath"] / "workers-platform.env").read_text()

            self.assertEqual(worker_app["metadata"]["name"], worker["appName"])
            self.assertEqual(worker_app["spec"]["source"]["path"], worker["appPath"])
            self.assertEqual(worker_kustomization["namespace"], env["namespace"])
            self.assertEqual(worker_deployment["metadata"]["name"], worker["workerDeploymentName"])
            self.assertEqual(worker_deployment["spec"]["workerOptions"]["temporalNamespace"], worker["temporalNamespace"])
            self.assertEqual(
                worker_deployment["spec"]["workerOptions"]["connectionRef"]["name"],
                runtime["temporalConnection"]["name"],
            )
            container = worker_deployment["spec"]["template"]["spec"]["containers"][0]
            self.assertEqual(container["name"], worker["containerName"])
            self.assertEqual(container["command"], worker["command"])
            self.assertEqual(container["args"], worker["args"])
            self.assertIn(
                {"name": "TEMPORAL_TASK_QUEUE", "value": worker["taskQueue"]},
                container["env"],
            )
            self.assertEqual(
                worker_deployment["spec"]["template"]["spec"]["serviceAccountName"],
                worker["serviceAccountName"],
            )
            self.assertEqual(service_account["metadata"]["name"], worker["serviceAccountName"])
            self.assertEqual(service_account["imagePullSecrets"][0]["name"], worker["imagePullSecret"])
            self.assertIn(f"{spec['image']['key']}=", platform_env)

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
        self.assertEqual(bundle.build_context, ".")
        self.assertIn("velalink", bundle.allowed_paths)
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
        self.assertIn("skip frontend artifact matrix build for playground branch", workflow_text)
        self.assertIn("shared Pages artifacts are master-only", workflow_text)
        self.assertIn("skip Cloudflare artifact release for playground branch", workflow_text)
        self.assertIn("shared Cloudflare staging is master-only", workflow_text)
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

    def test_frontend_checkouts_disable_virtual_merge(self) -> None:
        for workflow_path in (".ci/frontend.yml", ".ci/frontend-preview.yml"):
            with self.subTest(workflow=workflow_path):
                workflow = yaml.safe_load((REPO_ROOT / workflow_path).read_text())
                steps = workflow["stages"][0]["jobs"][next(iter(workflow["stages"][0]["jobs"]))]["steps"]
                checkout = next(step for step in steps if step.get("checkout") == "self")

                self.assertIs(checkout["with"].get("enableVirtualMergeBranch"), False)

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
        self.assertEqual((cn_workflow.get("extends") or {}).get("parameters", {}).get("COMBO"), "eo:cn-lightvela-prod-next")
        self.assertEqual(
            (intl_workflow.get("extends") or {}).get("parameters", {}).get("COMBO"),
            "eo:global-lightvela-intl-prod-next",
        )
        self.assertIn("FRONTEND_EDGEONE_ARTIFACT_SOURCE_SHA", template.get("variables") or {})
        self.assertIn("FRONTEND_EDGEONE_ARTIFACT_REF", template.get("variables") or {})
        self.assertIn("check-in", stages[0])
        self.assertNotIn("if:", template_text)
        self.assertIn("release_frontend_edgeone_artifact.sh", template_text)
        self.assertIn("POSTHOG_PROJECT_TOKEN: ${{ settings.POSTHOG_PROJECT_TOKEN }}", template_text)
        self.assertNotIn('"$PNPM_BIN" install --frozen-lockfile', template_text)

        command_text = (REPO_ROOT / ".ci/runtime/commands/release_frontend_edgeone_artifact.sh").read_text()
        self.assertIn("eo:cn-lightvela-prod-next)", command_text)
        self.assertIn("eo:global-lightvela-intl-prod-next)", command_text)
        self.assertIn("/etc/lightclaw-ci/edgeone_lightvela_prod_token", command_text)
        self.assertIn("/etc/lightclaw-ci/edgeone_lightvela_intl_prod_token", command_text)
        self.assertIn("ci_load_edgeone_credentials", command_text)
        self.assertIn('ARTIFACT_SOURCE_SHA="$FRONTEND_EDGEONE_CI_SHA"', command_text)
        self.assertIn("FRONTEND_EDGEONE_ARTIFACT_SOURCE_SHA is empty and ci.sha is unavailable", command_text)

        frontend_text = (REPO_ROOT / ".ci/frontend.yml").read_text()
        frontend_workflow = yaml.safe_load(frontend_text) or {}
        frontend_variables = frontend_workflow.get("variables") or {}
        self.assertEqual(
            frontend_variables.get("FRONTEND_ARTIFACT_MATRIX", {}).get("value"),
            "cf:cn-lightvela-staging,cf:global-lightvela-intl-staging,eo:cn-lightvela-prod-next,eo:global-lightvela-intl-prod-next",
        )
        self.assertEqual(
            frontend_variables.get("FRONTEND_RELEASE_MATRIX", {}).get("value"),
            "cf:cn-lightvela-staging,cf:global-lightvela-intl-staging",
        )
        self.assertIn("frontend 发布决策：进入 Cloudflare 预发 artifact 发布流程", frontend_text)
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
        beijing_preflight_stage = stage_by_name["预检北京主沙箱 Hermes 更新目标"]
        beijing_approval_stage = stage_by_name["确认刷新并修补北京主沙箱 Hermes"]
        beijing_refresh_stage = stage_by_name["刷新北京主沙箱 Hermes pools"]
        beijing_repair_stage = stage_by_name["升级存量北京主沙箱 Hermes VM"]
        singapore_preflight_stage = stage_by_name["预检新加坡生产 Hermes 更新目标"]
        singapore_approval_stage = stage_by_name["确认刷新并修补新加坡生产 Hermes"]
        singapore_refresh_stage = stage_by_name["刷新新加坡生产 Hermes pools"]
        singapore_repair_stage = stage_by_name["升级存量新加坡生产 Hermes VM"]
        shanghai_approval_stage = stage_by_name["确认刷新并修补上海生产 Hermes"]
        shanghai_refresh_stage = stage_by_name["刷新上海生产 Hermes pools"]
        shanghai_repair_stage = stage_by_name["升级存量上海生产 Hermes VM"]
        prod_if = "${{ ci.branch }} == master"
        reviewers = ["skipzhang", "pablozhong", "erichuyuehu", "sarahzzhang"]
        beijing_reviews = (((beijing_approval_stage.get("check-in") or {}).get("reviews") or {}).get("flows") or [])[0]
        singapore_reviews = (((singapore_approval_stage.get("check-in") or {}).get("reviews") or {}).get("flows") or [])[0]
        shanghai_reviews = (((shanghai_approval_stage.get("check-in") or {}).get("reviews") or {}).get("flows") or [])[0]

        self.assertEqual(beijing_approval_stage.get("if"), prod_if)
        self.assertEqual(beijing_preflight_stage.get("if"), prod_if)
        self.assertEqual(beijing_refresh_stage.get("if"), prod_if)
        self.assertEqual(beijing_repair_stage.get("if"), prod_if)
        self.assertEqual(singapore_approval_stage.get("if"), prod_if)
        self.assertEqual(singapore_preflight_stage.get("if"), prod_if)
        self.assertEqual(singapore_refresh_stage.get("if"), prod_if)
        self.assertEqual(singapore_repair_stage.get("if"), prod_if)
        self.assertEqual(shanghai_approval_stage.get("if"), prod_if)
        self.assertEqual(shanghai_refresh_stage.get("if"), prod_if)
        self.assertEqual(shanghai_repair_stage.get("if"), prod_if)
        self.assertEqual(beijing_reviews.get("reviewers"), reviewers)
        self.assertEqual(singapore_reviews.get("reviewers"), reviewers)
        self.assertEqual(shanghai_reviews.get("reviewers"), reviewers)
        self.assertLess(stages.index(build_stage), stages.index(beijing_preflight_stage))
        self.assertLess(stages.index(beijing_preflight_stage), stages.index(beijing_approval_stage))
        self.assertLess(stages.index(beijing_approval_stage), stages.index(beijing_refresh_stage))
        self.assertLess(stages.index(beijing_refresh_stage), stages.index(beijing_repair_stage))
        self.assertLess(stages.index(beijing_repair_stage), stages.index(singapore_preflight_stage))
        self.assertLess(stages.index(singapore_preflight_stage), stages.index(singapore_approval_stage))
        self.assertLess(stages.index(singapore_approval_stage), stages.index(singapore_refresh_stage))
        self.assertLess(stages.index(singapore_refresh_stage), stages.index(singapore_repair_stage))
        self.assertLess(stages.index(singapore_repair_stage), stages.index(shanghai_approval_stage))
        self.assertLess(stages.index(shanghai_approval_stage), stages.index(shanghai_refresh_stage))
        self.assertLess(stages.index(shanghai_refresh_stage), stages.index(shanghai_repair_stage))

        rollout_script = REPO_ROOT / ".ci/runtime/commands/rollout_hermes_sandbox_env.sh"
        refresh_env_script = REPO_ROOT / ".ci/runtime/commands/refresh_hermes_sandbox_env.sh"
        repair_vm_script = REPO_ROOT / ".ci/runtime/commands/repair_hermes_existing_vms.sh"
        rollout_script_text = rollout_script.read_text()
        refresh_env_script_text = refresh_env_script.read_text()
        repair_vm_script_text = repair_vm_script.read_text()
        workflow_and_runtime_text = workflow_text + rollout_script_text + refresh_env_script_text + repair_vm_script_text

        self.assertIn("refresh_hermes_sandbox_pools.sh", workflow_text)
        self.assertIn("refresh_hermes_sandbox_env.sh", workflow_text)
        self.assertIn("repair_hermes_existing_vms.sh", workflow_text)
        self.assertNotIn("bash .ci/runtime/commands/rollout_hermes_sandbox_env.sh", workflow_text)
        self.assertIn("extract_hermes_image_env.py", workflow_text)
        self.assertIn("resolve_hermes_reuse_image_name", workflow_text)
        self.assertIn("HERMES_REUSE_IMAGE_NAME", workflow_text)
        self.assertIn("HERMES_SKIP_IMAGE_BUILD", workflow_text)
        self.assertIn("--image-name \"$HERMES_IMAGE_NAME\"", workflow_text)
        self.assertIn(
            "--target-regions ap-beijing,ap-shanghai,ap-singapore,ap-tokyo",
            workflow_text,
        )
        self.assertIn("HERMES_IMAGE_ID_AP_TOKYO", workflow_text + refresh_env_script_text)
        self.assertIn("resolve_hermes_image_id.py --region \"$region\" --image-name \"$HERMES_IMAGE_NAME\"", workflow_and_runtime_text)
        self.assertIn("split_hermes_pool_vms_by_region.py", workflow_and_runtime_text)
        self.assertIn("HERMES_REFRESH_ENV_SPEC", workflow_text)
        self.assertIn("HERMES_REPAIR_ENV_SPEC", workflow_text)
        self.assertIn("sgprod:ap-singapore:kubeconfig_sgprod", workflow_text)
        self.assertIn("HERMES_SINGAPORE_HERMES_LEGACY_POOL_IDS", workflow_text)
        self.assertIn("预检北京主沙箱 Hermes 更新目标", workflow_text)
        self.assertIn("hermes-beijing-sandbox-preflight-vms", workflow_text)
        self.assertIn("No Beijing Hermes VM rows found; abort before manual approval", workflow_text)
        self.assertIn("resolve_hermes_image_id.py --region ap-beijing --image-name \"$HERMES_IMAGE_NAME\"", workflow_text)
        self.assertIn("预检新加坡生产 Hermes 更新目标", workflow_text)
        self.assertIn("hermes-sgprod-preflight-vms", workflow_text)
        self.assertIn("No Singapore Hermes VM rows found; abort before manual approval", workflow_text)
        self.assertIn("resolve_hermes_image_id.py --region ap-singapore --image-name \"$HERMES_IMAGE_NAME\"", workflow_text)
        self.assertIn("确认刷新并修补新加坡生产 Hermes", workflow_text)
        self.assertIn("beijing-sandbox:ap-beijing:kubeconfig_beijing_sandbox", workflow_text)
        self.assertIn("HERMES_BEIJING_HERMES_LEGACY_POOL_IDS", workflow_text)
        self.assertIn("pool-c2,pool-c3,pool-c4,pool-c5", workflow_text)
        self.assertIn("shprod:ap-shanghai:kubeconfig_shprod", workflow_text)
        self.assertIn("HERMES_SHANGHAI_HERMES_LEGACY_POOL_IDS", workflow_text)
        self.assertIn("pool-bj8,pool-c0,pool-c1,pool-c2,pool-c3,pool-c4,pool-c5", workflow_text)
        self.assertLess(workflow_text.index("beijing-sandbox:ap-beijing:kubeconfig_beijing_sandbox"), workflow_text.index("sgprod:ap-singapore:kubeconfig_sgprod"))
        self.assertLess(workflow_text.index("sgprod:ap-singapore:kubeconfig_sgprod"), workflow_text.index("shprod:ap-shanghai:kubeconfig_shprod"))
        self.assertNotIn("<<'PY'", workflow_text)
        self.assertNotIn("默认目标：shprod", workflow_text)
        self.assertNotIn('HERMES_TAT_COMMAND_ID is required for existing Hermes VM upgrade', workflow_text)
        self.assertIn("images/helpers/config-hermes-python-mirrors.sh", workflow_text)
        self.assertNotIn("tccli tat DeleteCommand", workflow_text)
        self.assertGreaterEqual(workflow_text.count("ci_ensure_jq"), 2)
        self.assertIn('HERMES_TAT_BATCH_SIZE="${HERMES_TAT_BATCH_SIZE:-5}"', workflow_and_runtime_text)
        self.assertIn('HERMES_TAT_SINGLE_ATTEMPTS="${HERMES_TAT_SINGLE_ATTEMPTS:-3}"', workflow_and_runtime_text)
        self.assertIn("不直连数据库，不执行 SQL", workflow_text)
        self.assertIn("批次失败后自动拆成单台重试", workflow_text)

        list_script = REPO_ROOT / ".ci/runtime/commands/list_hermes_pool_vms.sh"
        refresh_script = REPO_ROOT / ".ci/runtime/commands/refresh_hermes_sandbox_pools.sh"
        create_script = REPO_ROOT / ".ci/runtime/commands/create_hermes_tat_command.sh"
        invoke_script = REPO_ROOT / ".ci/runtime/commands/invoke_hermes_tat_command.sh"
        repair_script = REPO_ROOT / "images/helpers/config-hermes-python-mirrors.sh"
        blueprint_resolver = REPO_ROOT / "images/helpers/resolve-hermes-backend-blueprint-id.py"
        self.assertTrue(list_script.exists())
        self.assertTrue(refresh_script.exists())
        self.assertTrue(create_script.exists())
        self.assertTrue(invoke_script.exists())
        self.assertTrue(rollout_script.exists())
        self.assertTrue(refresh_env_script.exists())
        self.assertTrue(repair_vm_script.exists())
        self.assertTrue(blueprint_resolver.exists())
        self.assertIn("does not patch pools, update SKUs, invoke TAT, or write database rows", list_script.read_text())
        self.assertIn('/template-classes/${TEMPLATE_CLASS_ID}/resolve', refresh_script.read_text())
        self.assertIn('template-classes/{template}/resolve', list_script.read_text())
        self.assertIn("HERMES_LEGACY_POOL_IDS", refresh_script.read_text())
        self.assertIn("HERMES_LEGACY_POOL_IDS", list_script.read_text())
        self.assertIn("selected = {}", list_script.read_text())
        self.assertIn("selected = []", refresh_script.read_text())
        self.assertIn("SKU endpoint unavailable; pool patch will continue", refresh_script.read_text())
        self.assertIn("print_pool_discovery_debug", refresh_script.read_text())
        trigger_text = (REPO_ROOT / "images/hermes-image-trigger").read_text()
        committed_reuse_pins = [
            match.group(1)
            for match in re.finditer(r"(?:^|\s)reuse=([^\s]*)", trigger_text)
            if match.group(1)
        ]
        self.assertEqual([], committed_reuse_pins)
        create_script_text = create_script.read_text()
        self.assertIn("tccli tat CreateCommand", create_script_text)
        self.assertIn("--CommandType SHELL", create_script_text)
        self.assertIn("--Content", create_script_text)
        self.assertIn("resolve-hermes-backend-blueprint-id.py", create_script_text)
        self.assertIn("export HERMES_BACKEND_BLUEPRINT_ID", create_script_text)
        self.assertIn("batches run strictly serially", invoke_script.read_text())
        self.assertIn("batch failed; retrying", invoke_script.read_text())
        self.assertIn("refresh_hermes_sandbox_pools.sh", refresh_env_script_text)
        self.assertIn("resolve_hermes_image_id.py", refresh_env_script_text)
        self.assertIn('image_var="HERMES_IMAGE_ID_$(region_env_suffix "$region")"', refresh_env_script_text)
        self.assertIn('export "${image_var}=${image_id}"', refresh_env_script_text)
        self.assertIn("list_hermes_pool_vms.sh", repair_vm_script_text)
        self.assertIn("create_hermes_tat_command.sh", repair_vm_script_text)
        self.assertIn("invoke_hermes_tat_command.sh", repair_vm_script_text)
        self.assertIn("Repair existing Hermes VM inventory", repair_vm_script_text)
        self.assertIn("Refresh then repair one Hermes sandbox environment", rollout_script_text)
        self.assertIn(">&2", rollout_script_text)
        self.assertIn("refresh_hermes_sandbox_env.sh", rollout_script_text)
        self.assertIn("repair_hermes_existing_vms.sh", rollout_script_text)
        repair_script_text = repair_script.read_text()
        self.assertIn('"$config_dir/systemd/user"', repair_script_text)
        self.assertIn('chown "$user:$user" "$config_dir"', repair_script_text)
        self.assertIn('chmod 0700 "$config_dir"', repair_script_text)
        self.assertIn("acli backend --help", repair_script_text)
        self.assertIn("acli bundle-update", repair_script_text)
        self.assertIn("https://acli-1325194254.cos.accelerate.myqcloud.com/acli/install.sh", repair_script_text)
        self.assertIn("acli backend upgrade-start --blueprint-id", repair_script_text)

    def test_frontend_preview_uses_master_runtime(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/frontend-preview.yml").read_text()

        self.assertIn('FRONTEND_PREVIEW_RUNTIME_REF="${FRONTEND_PREVIEW_RUNTIME_REF:-origin/master}"', workflow_text)
        self.assertIn("GIT_WOA_PRIVATE_TOKEN: ${{ settings.GIT_WOA_PRIVATE_TOKEN }}", workflow_text)
        self.assertIn("source .ci/init.sh", workflow_text)
        self.assertIn("ci_git_fetch_origin --no-tags --depth=1 +refs/heads/master:refs/remotes/origin/master", workflow_text)
        self.assertIn('git archive --format=tar "$FRONTEND_PREVIEW_RUNTIME_REF" .ci', workflow_text)
        self.assertIn('bash "$FRONTEND_PREVIEW_RUNTIME_CI_DIR/runtime/commands/publish_frontend_preview.sh"', workflow_text)
        self.assertNotIn('"$PNPM_BIN" exec vite build', workflow_text)

        command_text = (REPO_ROOT / ".ci/runtime/commands/publish_frontend_preview.sh").read_text()
        self.assertIn('"$PNPM_BIN" run build:next', command_text)
        self.assertIn('rm -rf .next out "$output_dir"', command_text)
        self.assertIn('source "$CI_DIR/init.sh"', command_text)
        self.assertIn('python3 "$CI_DIR/runtime/commands/upload_staticpages_preview.py"', command_text)

        package_json = json.loads((REPO_ROOT / "frontend/package.json").read_text())
        self.assertIn("node scripts/clean-next-build-state.mjs", package_json["scripts"]["build:next"])

    def test_frontend_preview_builds_from_an_isolated_source_directory(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/frontend-preview.yml").read_text()

        self.assertIn(
            'FRONTEND_PREVIEW_SOURCE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/frontend-preview-source.XXXXXX")"',
            workflow_text,
        )
        self.assertIn(
            'git archive --format=tar "$FRONTEND_PREVIEW_SHA" | tar -xf - -C "$FRONTEND_PREVIEW_SOURCE_DIR"',
            workflow_text,
        )
        self.assertIn('export REPO_ROOT="$FRONTEND_PREVIEW_SOURCE_DIR"', workflow_text)
        self.assertIn('rm -rf "$FRONTEND_PREVIEW_RUNTIME_DIR" "$FRONTEND_PREVIEW_SOURCE_DIR"', workflow_text)
        self.assertLess(
            workflow_text.index('git archive --format=tar "$FRONTEND_PREVIEW_SHA"'),
            workflow_text.index('export REPO_ROOT="$FRONTEND_PREVIEW_SOURCE_DIR"'),
        )
        self.assertLess(
            workflow_text.index('export REPO_ROOT="$FRONTEND_PREVIEW_SOURCE_DIR"'),
            workflow_text.index('bash "$FRONTEND_PREVIEW_RUNTIME_CI_DIR/runtime/commands/publish_frontend_preview.sh"'),
        )

    def test_frontend_preview_builds_cn_and_intl_with_separate_api_bases(self) -> None:
        workflow_text = (REPO_ROOT / ".ci/runtime/commands/publish_frontend_preview.sh").read_text()

        self.assertIn('PREVIEW_CN_AUTH_API_BASE_URL="$(resolve_preview_auth_api_base_url "$FRONTEND_PREVIEW_BRANCH" cn)"', workflow_text)
        self.assertIn('PREVIEW_INTL_AUTH_API_BASE_URL="$(resolve_preview_auth_api_base_url "$FRONTEND_PREVIEW_BRANCH" intl)"', workflow_text)
        self.assertEqual(workflow_text.count('printf \'https://lightclaw.tech\''), 2)
        self.assertIn('build_next_preview_variant cn cn "$PREVIEW_CN_AUTH_API_BASE_URL" "$FRONTEND_NEXT_CN_DIR"', workflow_text)
        self.assertIn('build_next_preview_variant intl global "$PREVIEW_INTL_AUTH_API_BASE_URL" "$FRONTEND_NEXT_GLOBAL_DIR"', workflow_text)
        self.assertIn('export VITE_AUTH_API_BASE_URL="$api_base"', workflow_text)
        self.assertIn('export NEXT_PUBLIC_AUTH_API_BASE_URL="$api_base"', workflow_text)
        self.assertIn('export NEXT_WRITE_EDGEONE_BUILD_OUTPUT=0', workflow_text)
        self.assertIn('"$PNPM_BIN" run build:next', workflow_text)
        self.assertNotIn('"$PNPM_BIN" exec vite build', workflow_text)

    def test_frontend_mr_guard_runs_typecheck_and_frontend_builds(self) -> None:
        package_json = json.loads((REPO_ROOT / "frontend/package.json").read_text())
        guard_text = (REPO_ROOT / "frontend/checks/guard.sh").read_text()
        artifact_builder_text = (REPO_ROOT / "frontend/scripts/build-release-artifacts.mjs").read_text()

        frontend_scripts = package_json["scripts"]
        self.assertEqual(frontend_scripts["check"], frontend_scripts["check:next"])
        for script_name in ("build", "build:cn", "build:global"):
            self.assertIn("next build", frontend_scripts[script_name])
            self.assertNotIn("--webpack", frontend_scripts[script_name])
        self.assertIn("next build --webpack", frontend_scripts["build:next"])
        self.assertIn('["exec", "next", "build"]', artifact_builder_text)
        self.assertNotIn("--webpack", artifact_builder_text)
        recursive_pnpm_scripts = {
            name: script
            for name, script in frontend_scripts.items()
            if re.search(r"(^|[;&|()]\s*)pnpm\s+(run\s+)?", script)
        }
        self.assertEqual(
            recursive_pnpm_scripts,
            {},
            "frontend package scripts must not recursively call pnpm; CI invokes the pinned PNPM_BIN already",
        )
        self.assertIn('"$PNPM_BIN" check', guard_text)
        self.assertIn('FRONTEND_GUARD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/lightclaw-frontend-guard.XXXXXX")"', guard_text)
        self.assertIn('-cf - frontend velalink | tar -C "$FRONTEND_GUARD_ROOT" -xf -', guard_text)
        self.assertIn('--exclude="velalink/node_modules"', guard_text)
        self.assertIn('--exclude="velalink/target"', guard_text)
        self.assertIn('"$PNPM_BIN" build:cn', guard_text)
        self.assertIn('"$PNPM_BIN" build:global', guard_text)
        self.assertIn("NEXT_PUBLIC_AUTH_API_BASE_URL=https://api.lightvela.ai", guard_text)
        self.assertIn("NEXT_PUBLIC_AUTH_API_BASE_URL=https://lightclaw.tech", guard_text)
        self.assertIn("rm -rf out", guard_text)
        self.assertNotIn('VITE_BIN="$FRONTEND_GUARD_DIR/node_modules/.bin/vite"', guard_text)

    def test_frontend_mr_guard_disables_turbopack_build_cache(self) -> None:
        guard_text = (REPO_ROOT / "frontend/checks/guard.sh").read_text()
        next_config_text = (REPO_ROOT / "frontend/next.config.mjs").read_text()

        self.assertNotIn("turbopackFileSystemCacheForBuild", next_config_text)
        self.assertNotIn("FRONTEND_NEXT_CACHE", guard_text)
        self.assertNotIn("frontend_next_cache", guard_text)
        self.assertNotIn("restore_frontend_next_cache", guard_text)
        self.assertNotIn("save_frontend_next_cache", guard_text)
        self.assertIn('rm -rf .next out', guard_text)

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
        self.assertIn('reviewers: [ "skipzhang", "xinqishang" ]', template_text)
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

    def test_trade_workflow_builds_beijing_shprod_and_playground(self) -> None:
        manifest = load_manifest()
        bundle = require_build_metadata(load_bundle(manifest, "trade", "beijing-sandbox"))
        shprod_bundle = require_build_metadata(load_bundle(manifest, "trade", "shprod"))
        playground_bundle = require_build_metadata(load_bundle(manifest, "trade", PLAYGROUND_ENV))
        workflow = yaml.safe_load((REPO_ROOT / ".ci/trade.yml").read_text())

        self.assertEqual(bundle.image_repo, "lightclaw-bj8.tencentcloudcr.com/lightclaw/trade")
        self.assertIn("argocd/services/trade/beijing-sandbox/**", bundle.publish_paths)
        self.assertIn("argocd/services/trade/common/**", bundle.publish_paths)
        self.assertIn("argocd/apps/beijing-sandbox/sandbox-family-appset.yaml", bundle.publish_paths)
        self.assertIn("argocd/catalogs/sandbox/beijing-sandbox/trade.yaml", bundle.publish_paths)
        self.assertIn(
            "argocd/secrets/beijing-sandbox/trade-runtime-secrets.sops.yaml",
            bundle.publish_paths,
        )
        self.assertIn("trade/k8s/base/**", bundle.publish_paths)
        self.assertEqual(shprod_bundle.image_repo, "lightclaw-shprod.tencentcloudcr.com/lightclaw/trade")
        self.assertIn("argocd/services/trade/shprod/**", shprod_bundle.publish_paths)
        self.assertIn("argocd/services/trade/common/**", shprod_bundle.publish_paths)
        self.assertIn("argocd/apps/shprod/trade.yaml", shprod_bundle.publish_paths)
        self.assertIn("argocd/projects/shprod-trade.yaml", shprod_bundle.publish_paths)
        self.assertIn(
            "argocd/secrets/shprod/trade-runtime-secrets.sops.yaml",
            shprod_bundle.publish_paths,
        )
        self.assertIn("trade/k8s/base/**", shprod_bundle.publish_paths)
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
            expected_master_build_envs="beijing-sandbox,shprod",
            expected_master_auto_pin_envs="beijing-sandbox",
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

        self.assertEqual(parameters.get("PROD_REVIEWERS"), '["skipzhang", "roberttwang", "cocofhu", "lhuigou"]')
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
        self.assertIn("argocd/secrets/devcloud-dep/channelgateway-wecom-secrets.sops.yaml", bundle.publish_paths)
        self.assertIn("cloudagent/acp-client/**", watched_paths)
        self.assertIn("argocd/services/channelgateway/**", watched_paths)
        self.assertIn("argocd/secrets/*/channelgateway-runtime-secrets.sops.yaml", watched_paths)
        self.assertIn("argocd/secrets/*/channelgateway-wecom-secrets.sops.yaml", watched_paths)

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
        self.assertEqual(parameters.get("MASTER_AUTO_PIN_ENVS"), "tkexgz,tkexsg")
        self.assertEqual(parameters.get("ENABLE_MASTER_PROD_PROMOTE"), False)
        self.assertEqual(parameters.get("PLAYGROUND_BUILD_ENVS"), "none")
        self.assertEqual(parameters.get("PLAYGROUND_AUTO_PIN_ENVS"), "none")
        self.assertEqual(domestic_bundle.image_repo, "csighub.tencentyun.com/skipzhang/cloudladdergateway")
        self.assertEqual(intl_bundle.image_repo, "csighub.tencentyun.com/skipzhang/cloudladdergateway")
        self.assertIn("argocd/services/cloudladdergateway/tkexgz/**", domestic_bundle.publish_paths)
        self.assertIn("argocd/services/cloudladdergateway/tkexsg/**", intl_bundle.publish_paths)
        self.assertIn("argocd/secrets/tkexgz/cloudladdergateway-krsbx-callback-secrets.sops.yaml", domestic_bundle.publish_paths)
        self.assertIn("argocd/secrets/tkexsg/cloudladdergateway-krsbx-callback-secrets.sops.yaml", intl_bundle.publish_paths)
        self.assertIn("argocd/secrets/tkexsg/cloudladdergateway-polaris-*.sops.yaml", intl_bundle.publish_paths)
        self.assertIn("shared/cloudladdertransport/**", watched_paths)
        self.assertIn("argocd/services/cloudladdergateway/**", watched_paths)
        self.assertIn("argocd/secrets/*/cloudladdergateway-krsbx-callback-secrets.sops.yaml", watched_paths)
        self.assertIn("argocd/secrets/*/cloudladdergateway-polaris-*.sops.yaml", watched_paths)

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

    def test_prod_lightclaw_auth_maps_github_platform_values(self) -> None:
        expected_pairs = {
            ("data.AUTH_GITHUB_CLIENT_ID", "data.LIGHTCLAW_GITHUB_CLIENT_ID"),
            ("data.AUTH_GITHUB_REDIRECT_URI", "data.LIGHTCLAW_GITHUB_REDIRECT_URI"),
        }
        for env in ("shprod", "sgprod"):
            with self.subTest(env=env):
                kustomization_path = REPO_ROOT / f"argocd/services/lightclaw-auth/{env}/kustomization.yaml"
                kustomization = yaml.safe_load(kustomization_path.read_text()) or {}
                pairs = set()
                for replacement in kustomization.get("replacements") or []:
                    source = replacement.get("source") or {}
                    for target in replacement.get("targets") or []:
                        for field_path in target.get("fieldPaths") or []:
                            pairs.add((source.get("fieldPath"), field_path))

                self.assertTrue(
                    expected_pairs.issubset(pairs),
                    f"{env} must map GitHub platform values into lightclaw-auth-config",
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
        self.assertEqual(template_parameters.get("PROD_REVIEWERS", {}).get("default"), '["skipzhang", "xinqishang"]')
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
        for workflow_path in [REPO_ROOT / ".ci/staticpages.yml"]:
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
            "beijing-llmgateway": "TCR_BEIJING_LLMGATEWAY_PASSWORD",
            "sandbox-kr-1": "TCR_KR1_PASSWORD",
            "sandbox-jp-1": "TCR_JP1_PASSWORD",
            "shprod": "TCR_SHPROD_PASSWORD",
            "shanghai-workers": "TCR_SHPROD_PASSWORD",
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
