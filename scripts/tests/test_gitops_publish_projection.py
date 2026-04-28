import json
import shutil
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPTS_DIR = REPO_ROOT / "scripts"


class ResolveReleaseBundleTests(unittest.TestCase):
    def test_resolve_release_bundle_exposes_publish_paths(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(SCRIPTS_DIR / "resolve_release_bundle.py"),
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
        self.assertIn("argocd/apps/beijing-sandbox/sandbox-family-appset.yaml", payload["publish_paths"])
        self.assertIn("argocd/catalogs/sandbox/beijing-sandbox/lightclaw-auth.yaml", payload["publish_paths"])
        self.assertNotIn("argocd/apps/beijing-sandbox/lightclaw-auth.yaml", payload["publish_paths"])
        self.assertIn("user/auth/k8s/base/**", payload["publish_paths"])

    def test_resolve_release_bundle_keeps_shprod_leaf_app_path(self) -> None:
        result = subprocess.run(
            [
                "python3",
                str(SCRIPTS_DIR / "resolve_release_bundle.py"),
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


class ProjectReleaseBundleTests(unittest.TestCase):
    def test_projection_syncs_publish_subset_and_deletes_stale_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo = Path(tmp)
            self._git(repo, "init")
            self._git(repo, "config", "user.email", "ci@example.com")
            self._git(repo, "config", "user.name", "CI")

            (repo / "scripts").mkdir()
            (repo / "scripts" / "release-bundles.yaml").write_text(
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
            self._git(repo, "add", ".")
            self._git(repo, "commit", "-m", "source")
            source_ref = self._git_output(repo, "rev-parse", "HEAD")

            self._git(repo, "checkout", "-b", "gitops")
            (repo / "argocd" / "services" / "demo" / "beijing-sandbox" / "config.yaml").write_text("old-config\n")
            (repo / "argocd" / "services" / "demo" / "beijing-sandbox" / "stale.yaml").write_text("stale\n")
            (repo / "argocd" / "apps" / "beijing-sandbox" / "demo.yaml").write_text("app: old\n")
            (repo / "argocd" / "apps" / "beijing-sandbox" / "sandbox-family-appset.yaml").write_text("appset: old\n")
            (repo / "argocd" / "catalogs" / "sandbox" / "beijing-sandbox" / "demo.yaml").write_text("catalog: old\n")
            (repo / "demo" / "k8s" / "base" / "manifests.yaml").write_text("old-manifest\n")
            (repo / "argocd" / "services" / "other" / "beijing-sandbox").mkdir(parents=True)
            (repo / "argocd" / "services" / "other" / "beijing-sandbox" / "keep.yaml").write_text("keep\n")
            self._git(repo, "add", ".")
            self._git(repo, "commit", "-m", "gitops base")

            result = subprocess.run(
                [
                    "python3",
                    str(SCRIPTS_DIR / "project_release_bundle.py"),
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

    def _git(self, repo: Path, *args: str) -> None:
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)

    def _git_output(self, repo: Path, *args: str) -> str:
        return subprocess.check_output(["git", *args], cwd=repo, text=True).strip()


if __name__ == "__main__":
    unittest.main()
