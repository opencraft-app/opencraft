import json
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
COMMAND_DIR = RUNTIME_DIR / "commands"
sys.path.insert(0, str(RUNTIME_DIR))

from contracts.bundles import load_bundle  # noqa: E402
from tests.helpers import git, git_output  # noqa: E402


class ResolveReleaseBundleTests(unittest.TestCase):
    def test_resolve_release_bundle_exposes_publish_paths(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(COMMAND_DIR / "resolve_release_bundle.py"),
                "--service",
                "user-auth",
                "--env",
                "beijing-sandbox",
                "--tag",
                "test-tag",
                "--format",
                "json",
            ],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)

        self.assertIn("publish_paths", payload)
        self.assertIn("argocd/services/lightclaw-auth/beijing-sandbox/**", payload["publish_paths"])
        self.assertIn("argocd/services/lightclaw-auth/common/**", payload["publish_paths"])
        self.assertIn("argocd/services/lightclaw-auth/profiles/sandbox/**", payload["publish_paths"])
        self.assertIn("argocd/apps/beijing-sandbox/sandbox-family-appset.yaml", payload["publish_paths"])
        self.assertIn("argocd/catalogs/sandbox/beijing-sandbox/lightclaw-auth.yaml", payload["publish_paths"])
        self.assertNotIn("argocd/apps/beijing-sandbox/lightclaw-auth.yaml", payload["publish_paths"])
        self.assertIn("user/auth/k8s/base/**", payload["publish_paths"])

    def test_resolve_release_bundle_supports_sandbox2_build_metadata(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(COMMAND_DIR / "resolve_release_bundle.py"),
                "--service",
                "ctl",
                "--env",
                "beijing-sandbox-2",
                "--tag",
                "test-tag",
                "--format",
                "json",
            ],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)

        self.assertEqual(payload["image_repo"], "lightclaw-bj8.tencentcloudcr.com/lightclaw/ctl")
        self.assertIn("argocd/catalogs/sandbox/beijing-sandbox-2/ctl.yaml", payload["publish_paths"])
        self.assertIn("argocd/apps/beijing-sandbox/sandbox-family-appset.yaml", payload["publish_paths"])
        self.assertNotIn("argocd/apps/beijing-sandbox-2/sandbox-family-appset.yaml", payload["publish_paths"])

    def test_resolve_release_bundle_supports_sandbox_multi_image_targets(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(COMMAND_DIR / "resolve_release_bundle.py"),
                "--service",
                "sandbox",
                "--env",
                "beijing-sandbox-2",
                "--tag",
                "test-tag",
                "--format",
                "json",
            ],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)

        self.assertEqual(
            set(payload["images"]),
            {
                "SANDBOX_API_IMAGE",
                "SANDBOX_MIGRATE_IMAGE",
                "SANDBOX_WORKER_IMAGE",
                "SANDBOX_INGRESSPROXY_ROUTER_IMAGE",
                "SANDBOX_INGRESSPROXY_SHARD_IMAGE",
            },
        )
        self.assertEqual(
            payload["images"]["SANDBOX_API_IMAGE"],
            "lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api:test-tag",
        )

    def test_resolve_release_bundle_blocks_non_target_sandbox2_services(self) -> None:
        for service in ["ai-gateway", "nextgen-dashboard", "session"]:
            with self.subTest(service=service):
                result = subprocess.run(
                    [
                        "python3",
                        str(COMMAND_DIR / "resolve_release_bundle.py"),
                        "--service",
                        service,
                        "--env",
                        "beijing-sandbox-2",
                        "--tag",
                        "test-tag",
                        "--format",
                        "json",
                    ],
                    cwd=REPO_ROOT,
                    capture_output=True,
                    text=True,
                )

                self.assertEqual(result.returncode, 1)
                self.assertIn("does not define docker build inputs", result.stderr)

    def test_resolve_release_bundle_is_independent_of_cwd(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(COMMAND_DIR / "resolve_release_bundle.py"),
                "--service",
                "frontend",
                "--env",
                "shprod",
                "--tag",
                "test-tag",
                "--format",
                "json",
            ],
            cwd=REPO_ROOT / "frontend",
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)

        self.assertEqual(payload["service"], "frontend")
        self.assertEqual(payload["env"], "shprod")

    def test_resolve_release_bundle_keeps_shprod_leaf_app_path(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(COMMAND_DIR / "resolve_release_bundle.py"),
                "--service",
                "user-auth",
                "--env",
                "shprod",
                "--tag",
                "test-tag",
                "--format",
                "json",
            ],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)

        self.assertIn("argocd/apps/shprod/lightclaw-auth.yaml", payload["publish_paths"])
        self.assertNotIn("argocd/apps/shprod/sandbox-family-appset.yaml", payload["publish_paths"])

    def test_build_release_image_reads_manifest_independent_of_cwd(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(COMMAND_DIR / "build_release_image.py"),
                "--service",
                "does-not-exist",
                "--env",
                "shprod",
                "--tag",
                "test-tag",
            ],
            cwd=REPO_ROOT / "frontend",
            capture_output=True,
            text=True,
        )

        self.assertEqual(result.returncode, 1)
        self.assertIn("unknown release bundle: does-not-exist", result.stderr)

    def test_ai_gateway_build_context_matches_root_relative_dockerfile(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(COMMAND_DIR / "resolve_release_bundle.py"),
                "--service",
                "ai-gateway",
                "--env",
                "beijing-sandbox",
                "--tag",
                "test-tag",
                "--format",
                "json",
            ],
            cwd=REPO_ROOT,
            check=True,
            capture_output=True,
            text=True,
        )
        payload = json.loads(result.stdout)

        self.assertEqual(payload["dockerfile"], "ai-gateway/deploy/Dockerfile")
        self.assertEqual(payload["build_context"], ".")

    def test_load_bundle_rejects_non_mapping_multi_image_repo(self) -> None:
        manifest = {
            "bundles": {
                "sandbox": {
                    "image_targets": [
                        {
                            "name": "api",
                            "image_key": "SANDBOX_API_IMAGE",
                            "dockerfile": "sandbox/Dockerfile.api",
                            "build_context": "sandbox",
                            "image_repo": "lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api",
                        }
                    ]
                }
            }
        }

        with self.assertRaisesRegex(ValueError, "image_repo must be a YAML mapping"):
            load_bundle(manifest, "sandbox", "beijing-sandbox-2")

    def test_load_bundle_rejects_incomplete_multi_image_target_for_env(self) -> None:
        manifest = {
            "bundles": {
                "sandbox": {
                    "image_targets": [
                        {
                            "name": "api",
                            "dockerfile": "sandbox/Dockerfile.api",
                            "build_context": "sandbox",
                            "image_repo": {
                                "beijing-sandbox-2": (
                                    "lightclaw-bj8.tencentcloudcr.com/lightclaw/sandbox-api"
                                )
                            },
                        }
                    ]
                }
            }
        }

        with self.assertRaisesRegex(ValueError, "does not define image_key"):
            load_bundle(manifest, "sandbox", "beijing-sandbox-2")


class SandboxCatalogTests(unittest.TestCase):
    def test_appset_uses_non_reserved_catalog_source_path(self) -> None:
        appset = (REPO_ROOT / "argocd" / "apps" / "beijing-sandbox" / "sandbox-family-appset.yaml").read_text()

        self.assertIn("path: '{{ .sourcePath }}'", appset)
        self.assertNotIn("path: '{{ .path }}'", appset)

        catalog_files = sorted((REPO_ROOT / "argocd" / "catalogs" / "sandbox").glob("*/*.yaml"))
        self.assertGreaterEqual(len(catalog_files), 1)
        for catalog_file in catalog_files:
            content = catalog_file.read_text()
            self.assertIn("sourcePath: argocd/services/", content, msg=str(catalog_file))
            self.assertNotIn("\npath: argocd/services/", content, msg=str(catalog_file))

    def test_beijing_service_common_is_component(self) -> None:
        service_root = REPO_ROOT / "argocd" / "services"
        common_files = sorted(service_root.glob("*/common/kustomization.yaml"))
        self.assertGreaterEqual(len(common_files), 1)
        for common_file in common_files:
            content = common_file.read_text()
            self.assertIn("kind: Component", content, msg=str(common_file))

        beijing_files = sorted(service_root.glob("*/beijing-sandbox*/kustomization.yaml"))
        self.assertGreaterEqual(len(beijing_files), 1)
        for beijing_file in beijing_files:
            content = beijing_file.read_text()
            self.assertIn("- ../common", content, msg=str(beijing_file))
            self.assertNotIn("resources:\n- ../common", content, msg=str(beijing_file))


class ProjectReleaseBundleTests(unittest.TestCase):
    def test_projection_syncs_publish_subset_and_deletes_stale_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            git(repo, "init")
            git(repo, "config", "user.email", "ci@example.com")
            git(repo, "config", "user.name", "CI")

            (repo / ".ci" / "runtime").mkdir(parents=True)
            (repo / ".ci" / "runtime" / "release-bundles.manifest").write_text(
                textwrap.dedent(
                    """\
                    bundles:
                      demo:
                        owner: demo
                        source: demo
                        reason: Demo bundle
                        allowed_paths:
                          - demo/k8s/base
                        exit_condition: never
                        dockerfile: demo/Dockerfile
                        build_context: demo
                        image_repo:
                          beijing-sandbox: example.com/demo
                        publish_paths:
                          - argocd/services/demo/{env}/**
                          - argocd/apps/{env}/demo.yaml
                          - demo/k8s/base/**
                        publish_paths_by_env:
                          beijing-sandbox:
                            - argocd/services/demo/beijing-sandbox/**
                            - argocd/apps/beijing-sandbox/sandbox-family-appset.yaml
                            - argocd/catalogs/sandbox/beijing-sandbox/demo.yaml
                            - demo/k8s/base/**
                    """
                )
            )
            (repo / "demo" / "k8s" / "base").mkdir(parents=True)
            (repo / "demo" / "k8s" / "base" / "manifests.yaml").write_text("source-manifest\n")
            (repo / "argocd" / "services" / "demo" / "beijing-sandbox").mkdir(parents=True)
            (repo / "argocd" / "services" / "demo" / "beijing-sandbox" / "config.yaml").write_text("new-config\n")
            (repo / "argocd" / "apps" / "beijing-sandbox").mkdir(parents=True)
            (repo / "argocd" / "apps" / "beijing-sandbox" / "sandbox-family-appset.yaml").write_text("appset: new\n")
            (repo / "argocd" / "catalogs" / "sandbox" / "beijing-sandbox").mkdir(parents=True)
            (repo / "argocd" / "catalogs" / "sandbox" / "beijing-sandbox" / "demo.yaml").write_text("catalog: new\n")
            (repo / "README.md").write_text("source repo\n")
            git(repo, "add", ".")
            git(repo, "commit", "-m", "source")
            source_ref = git_output(repo, "rev-parse", "HEAD")

            git(repo, "checkout", "-b", "gitops")
            (repo / "argocd" / "services" / "demo" / "beijing-sandbox" / "config.yaml").write_text("old-config\n")
            (repo / "argocd" / "services" / "demo" / "beijing-sandbox" / "stale.yaml").write_text("stale\n")
            (repo / "argocd" / "apps" / "beijing-sandbox" / "demo.yaml").write_text("app: old\n")
            (repo / "argocd" / "apps" / "beijing-sandbox" / "sandbox-family-appset.yaml").write_text("appset: old\n")
            (repo / "argocd" / "catalogs" / "sandbox" / "beijing-sandbox" / "demo.yaml").write_text("catalog: old\n")
            (repo / "demo" / "k8s" / "base" / "manifests.yaml").write_text("old-manifest\n")
            (repo / "argocd" / "services" / "other" / "beijing-sandbox").mkdir(parents=True)
            (repo / "argocd" / "services" / "other" / "beijing-sandbox" / "keep.yaml").write_text("keep\n")
            git(repo, "add", ".")
            git(repo, "commit", "-m", "gitops base")

            result = subprocess.run(
                [
                    "python3",
                    str(COMMAND_DIR / "project_release_bundle.py"),
                    "--repo-root",
                    str(repo),
                    "--service",
                    "demo",
                    "--env",
                    "beijing-sandbox",
                    "--source-ref",
                    source_ref,
                ],
                cwd=repo,
                capture_output=True,
                text=True,
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            self.assertEqual(
                (repo / "argocd" / "services" / "demo" / "beijing-sandbox" / "config.yaml").read_text(),
                "new-config\n",
            )
            self.assertFalse((repo / "argocd" / "services" / "demo" / "beijing-sandbox" / "stale.yaml").exists())
            self.assertEqual((repo / "argocd" / "apps" / "beijing-sandbox" / "demo.yaml").read_text(), "app: old\n")
            self.assertEqual((repo / "argocd" / "apps" / "beijing-sandbox" / "sandbox-family-appset.yaml").read_text(), "appset: new\n")
            self.assertEqual((repo / "argocd" / "catalogs" / "sandbox" / "beijing-sandbox" / "demo.yaml").read_text(), "catalog: new\n")
            self.assertEqual((repo / "demo" / "k8s" / "base" / "manifests.yaml").read_text(), "source-manifest\n")
            self.assertTrue((repo / "argocd" / "services" / "other" / "beijing-sandbox" / "keep.yaml").exists())



if __name__ == "__main__":
    unittest.main()
