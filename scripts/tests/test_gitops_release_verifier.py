import subprocess
import tempfile
import unittest
from pathlib import Path

from scripts.verify_gitops_release import (
    ReleaseTarget,
    changed_files_from_recent_commits,
    expected_images_for_target,
    infer_release_targets,
)


class GitopsReleaseVerifierTests(unittest.TestCase):
    def test_infer_release_targets_from_promote_commit_paths(self) -> None:
        targets = infer_release_targets(
            [
                "scripts/gitops_merge_request.py",
                "argocd/services/ctl/beijing-sandbox/ctl-platform.env",
                "argocd/services/ctl/beijing-sandbox/kustomization.yaml",
                "argocd/services/ctl/common/kustomization.yaml",
                "argocd/services/ctl/profiles/sandbox/kustomization.yaml",
                "argocd/services/admin-gateway/beijing-sandbox/admin-gateway-platform.env",
                "argocd/apps/beijing-sandbox/ctl.yaml",
            ]
        )

        self.assertEqual(
            targets,
            [
                ReleaseTarget(service="ctl", env="beijing-sandbox"),
                ReleaseTarget(service="admin-gateway", env="beijing-sandbox"),
            ],
        )

    def test_expected_images_for_target_collects_all_image_keys(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            env_dir = repo_root / "argocd" / "services" / "sandbox" / "beijing-sandbox"
            env_dir.mkdir(parents=True)
            (env_dir / "sandbox-platform.env").write_text(
                "\n".join(
                    [
                        "SANDBOX_API_IMAGE=example.com/api:v1",
                        "SANDBOX_WORKER_IMAGE=example.com/worker:v1",
                        "SANDBOX_DEPLOYED_AT=2026-04-28T00:00:00Z",
                    ]
                )
                + "\n"
            )

            images = expected_images_for_target(repo_root, ReleaseTarget(service="sandbox", env="beijing-sandbox"))

        self.assertEqual(images, ["example.com/api:v1", "example.com/worker:v1"])

    def test_changed_files_from_recent_commits_finds_service_change_before_ci_only_tail(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            self._git(repo_root, "init")
            self._git(repo_root, "config", "user.email", "ci@example.com")
            self._git(repo_root, "config", "user.name", "CI")

            service_dir = repo_root / "argocd" / "services" / "lightclaw-auth" / "beijing-sandbox"
            service_dir.mkdir(parents=True)
            (service_dir / "auth-platform.env").write_text("AUTH_IMAGE=example.com/auth:v1\n")
            self._git(repo_root, "add", ".")
            self._git(repo_root, "commit", "-m", "pin image")

            workflow = repo_root / ".ci" / "gitops-promotion.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("version: v2.0\n")
            self._git(repo_root, "add", ".")
            self._git(repo_root, "commit", "-m", "fix workflow")

            targets = infer_release_targets(changed_files_from_recent_commits(repo_root))

        self.assertEqual(targets, [ReleaseTarget(service="lightclaw-auth", env="beijing-sandbox")])

    def _git(self, repo: Path, *args: str) -> None:
        subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True)


if __name__ == "__main__":
    unittest.main()
