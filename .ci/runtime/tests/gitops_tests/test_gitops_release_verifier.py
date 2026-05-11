import tempfile
import unittest
from pathlib import Path
import sys

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from tests.helpers import git, git_output

from gitops.gitops_release_verifier import (
    ReleaseTarget,
    changed_files_from_merge_commit,
    changed_files_from_recent_commits,
    expected_images_for_target,
    format_convergence_log_line,
    format_merge_only_note,
    infer_release_targets,
    revision_contains_merge_commit,
)


class GitopsReleaseVerifierTests(unittest.TestCase):
    def test_infer_release_targets_from_promote_commit_paths(self) -> None:
        targets = infer_release_targets(
            [
                ".ci/runtime/commands/gitops_merge_request.py",
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
            git(repo_root, "init")
            git(repo_root, "config", "user.email", "ci@example.com")
            git(repo_root, "config", "user.name", "CI")

            service_dir = repo_root / "argocd" / "services" / "lightclaw-auth" / "beijing-sandbox"
            service_dir.mkdir(parents=True)
            (service_dir / "auth-platform.env").write_text("AUTH_IMAGE=example.com/auth:v1\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "pin image")

            workflow = repo_root / ".ci" / "gitops-promotion.yml"
            workflow.parent.mkdir(parents=True)
            workflow.write_text("version: v2.0\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "fix workflow")

            targets = infer_release_targets(changed_files_from_recent_commits(repo_root))

        self.assertEqual(targets, [ReleaseTarget(service="lightclaw-auth", env="beijing-sandbox")])

    def test_changed_files_from_merge_commit_uses_first_parent_diff(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            git(repo_root, "init")
            git(repo_root, "config", "user.email", "ci@example.com")
            git(repo_root, "config", "user.name", "CI")
            (repo_root / "README.md").write_text("base\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "base")
            git(repo_root, "checkout", "-b", "gitops")
            git(repo_root, "checkout", "-b", "promote")

            service_dir = repo_root / "argocd" / "services" / "lightclaw-auth" / "beijing-sandbox"
            service_dir.mkdir(parents=True)
            (service_dir / "auth-platform.env").write_text("AUTH_IMAGE=example.com/auth:v1\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "pin image")

            git(repo_root, "checkout", "gitops")
            git(repo_root, "merge", "--no-ff", "promote", "-m", "merge promote")
            merge_commit = git_output(repo_root, "rev-parse", "HEAD")

            changed_files = changed_files_from_merge_commit(repo_root, merge_commit, "gitops")

        self.assertIn("argocd/services/lightclaw-auth/beijing-sandbox/auth-platform.env", changed_files)

    def test_changed_files_from_merge_commit_returns_empty_for_noop_trigger_merge(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            git(repo_root, "init")
            git(repo_root, "config", "user.email", "ci@example.com")
            git(repo_root, "config", "user.name", "CI")
            (repo_root / "README.md").write_text("base\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "base")
            git(repo_root, "checkout", "-b", "gitops")
            git(repo_root, "checkout", "-b", "promote")
            git(repo_root, "commit", "--allow-empty", "-m", "rerun checks")

            git(repo_root, "checkout", "gitops")
            git(repo_root, "merge", "--no-ff", "promote", "-m", "merge noop promote")
            merge_commit = git_output(repo_root, "rev-parse", "HEAD")

            changed_files = changed_files_from_merge_commit(repo_root, merge_commit, "gitops")

        self.assertEqual(changed_files, [])

    def test_revision_contains_merge_commit_accepts_later_gitops_head(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            git(repo_root, "init")
            git(repo_root, "config", "user.email", "ci@example.com")
            git(repo_root, "config", "user.name", "CI")
            (repo_root / "README.md").write_text("base\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "base")
            git(repo_root, "checkout", "-b", "gitops")

            git(repo_root, "checkout", "-b", "promote-auth")
            service_dir = repo_root / "argocd" / "services" / "lightclaw-auth" / "beijing-sandbox"
            service_dir.mkdir(parents=True)
            (service_dir / "auth-platform.env").write_text("AUTH_IMAGE=example.com/auth:v1\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "pin auth image")

            git(repo_root, "checkout", "gitops")
            git(repo_root, "merge", "--no-ff", "promote-auth", "-m", "merge auth promote")
            auth_merge_commit = git_output(repo_root, "rev-parse", "HEAD")

            git(repo_root, "checkout", "-b", "promote-dashboard")
            dashboard_dir = repo_root / "argocd" / "services" / "gateway-dashboard" / "beijing-sandbox"
            dashboard_dir.mkdir(parents=True)
            (dashboard_dir / "gateway-dashboard-platform.env").write_text("GATEWAY_DASHBOARD_IMAGE=example.com/dashboard:v1\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "pin dashboard image")

            git(repo_root, "checkout", "gitops")
            git(repo_root, "merge", "--no-ff", "promote-dashboard", "-m", "merge dashboard promote")
            later_gitops_head = git_output(repo_root, "rev-parse", "HEAD")

            contains = revision_contains_merge_commit(
                repo_root,
                later_gitops_head,
                auth_merge_commit,
                "gitops",
            )

        self.assertTrue(contains)

    def test_revision_contains_merge_commit_rejects_unrelated_revision(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            git(repo_root, "init")
            git(repo_root, "config", "user.email", "ci@example.com")
            git(repo_root, "config", "user.name", "CI")
            (repo_root / "README.md").write_text("base\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "base")
            git(repo_root, "checkout", "-b", "gitops")

            git(repo_root, "checkout", "-b", "promote-auth")
            (repo_root / "auth.env").write_text("AUTH_IMAGE=example.com/auth:v1\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "pin auth image")
            auth_commit = git_output(repo_root, "rev-parse", "HEAD")

            git(repo_root, "checkout", "gitops")
            (repo_root / "dashboard.env").write_text("DASHBOARD_IMAGE=example.com/dashboard:v1\n")
            git(repo_root, "add", ".")
            git(repo_root, "commit", "-m", "pin dashboard image")
            unrelated_gitops_head = git_output(repo_root, "rev-parse", "HEAD")

            contains = revision_contains_merge_commit(
                repo_root,
                unrelated_gitops_head,
                auth_commit,
                "gitops",
            )

        self.assertFalse(contains)

    def test_format_convergence_log_line_includes_live_state_and_expectations(self) -> None:
        line = format_convergence_log_line(
            {
                "app_name": "ctl-beijing-sandbox",
                "revision": "abcdef1234567890",
                "sync_status": "OutOfSync",
                "health_status": "Progressing",
                "images": ["example.com/ctl:v1"],
            },
            expected_revision="fedcba9876543210",
            expected_images=["example.com/ctl:v2"],
            elapsed_seconds=30,
            wait_seconds=600,
        )

        self.assertIn("app=ctl-beijing-sandbox", line)
        self.assertIn("elapsed=30/600s", line)
        self.assertIn("revision=abcdef123456", line)
        self.assertIn("expected_revision=fedcba987654", line)
        self.assertIn("sync=OutOfSync", line)
        self.assertIn("health=Progressing", line)
        self.assertIn("expected_images=example.com/ctl:v2", line)
        self.assertIn("live_images=example.com/ctl:v1", line)

    def test_format_merge_only_note_marks_shprod_as_pending_manual_sync(self) -> None:
        note = format_merge_only_note(
            {"iid": 220, "merge_commit_sha": "abcdef123456"},
            [ReleaseTarget(service="frontend", env="shprod")],
        )

        self.assertIn("待同步状态", note)
        self.assertIn("frontend-shprod", note)
        self.assertIn("生产环境不自动同步", note)



if __name__ == "__main__":
    unittest.main()
