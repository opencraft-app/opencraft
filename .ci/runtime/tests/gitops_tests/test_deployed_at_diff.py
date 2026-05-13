import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.deployed_at_diff import staged_diff_is_deployed_at_only


class DeployedAtDiffTests(unittest.TestCase):
    def test_detects_deployed_at_only_staged_diff(self) -> None:
        with self.git_repo() as repo:
            platform_env = repo / "argocd/services/admin-gateway/beijing-sandbox/admin-gateway-platform.env"
            platform_env.parent.mkdir(parents=True)
            platform_env.write_text(
                "ADMIN_GATEWAY_IMAGE=example.com/admin@sha256:old\n"
                "ADMIN_GATEWAY_DEPLOYED_AT=2026-05-13T02:57:15Z\n"
            )
            self.git(repo, "add", ".")
            self.git(repo, "commit", "-m", "base")

            platform_env.write_text(
                "ADMIN_GATEWAY_IMAGE=example.com/admin@sha256:old\n"
                "ADMIN_GATEWAY_DEPLOYED_AT=2026-05-13T03:14:17Z\n"
            )
            self.git(repo, "add", ".")

            self.assertTrue(staged_diff_is_deployed_at_only(repo))

    def test_rejects_image_pin_change_with_deployed_at_change(self) -> None:
        with self.git_repo() as repo:
            platform_env = repo / "argocd/services/admin-gateway/beijing-sandbox/admin-gateway-platform.env"
            platform_env.parent.mkdir(parents=True)
            platform_env.write_text(
                "ADMIN_GATEWAY_IMAGE=example.com/admin@sha256:old\n"
                "ADMIN_GATEWAY_DEPLOYED_AT=2026-05-13T02:57:15Z\n"
            )
            self.git(repo, "add", ".")
            self.git(repo, "commit", "-m", "base")

            platform_env.write_text(
                "ADMIN_GATEWAY_IMAGE=example.com/admin@sha256:new\n"
                "ADMIN_GATEWAY_DEPLOYED_AT=2026-05-13T03:14:17Z\n"
            )
            self.git(repo, "add", ".")

            self.assertFalse(staged_diff_is_deployed_at_only(repo))

    def test_rejects_config_change_with_deployed_at_change(self) -> None:
        with self.git_repo() as repo:
            platform_env = repo / "argocd/services/admin-gateway/beijing-sandbox/admin-gateway-platform.env"
            config = repo / "argocd/services/admin-gateway/beijing-sandbox/config.yaml"
            platform_env.parent.mkdir(parents=True)
            platform_env.write_text(
                "ADMIN_GATEWAY_IMAGE=example.com/admin@sha256:old\n"
                "ADMIN_GATEWAY_DEPLOYED_AT=2026-05-13T02:57:15Z\n"
            )
            config.write_text("feature: old\n")
            self.git(repo, "add", ".")
            self.git(repo, "commit", "-m", "base")

            platform_env.write_text(
                "ADMIN_GATEWAY_IMAGE=example.com/admin@sha256:old\n"
                "ADMIN_GATEWAY_DEPLOYED_AT=2026-05-13T03:14:17Z\n"
            )
            config.write_text("feature: new\n")
            self.git(repo, "add", ".")

            self.assertFalse(staged_diff_is_deployed_at_only(repo))

    def test_empty_staged_diff_is_not_deployed_at_only(self) -> None:
        with self.git_repo() as repo:
            platform_env = repo / "argocd/services/admin-gateway/beijing-sandbox/admin-gateway-platform.env"
            platform_env.parent.mkdir(parents=True)
            platform_env.write_text("ADMIN_GATEWAY_DEPLOYED_AT=2026-05-13T02:57:15Z\n")
            self.git(repo, "add", ".")
            self.git(repo, "commit", "-m", "base")

            self.assertFalse(staged_diff_is_deployed_at_only(repo))

    def git_repo(self):
        temp_dir = tempfile.TemporaryDirectory()
        repo = Path(temp_dir.name)
        self.git(repo, "init")
        self.git(repo, "config", "user.name", "Test User")
        self.git(repo, "config", "user.email", "test@example.com")
        return _TempRepo(temp_dir, repo)

    def git(self, repo: Path, *args: str) -> None:
        subprocess.run(["git", "-C", str(repo), *args], check=True, capture_output=True, text=True)


class _TempRepo:
    def __init__(self, temp_dir: tempfile.TemporaryDirectory, repo: Path) -> None:
        self.temp_dir = temp_dir
        self.repo = repo

    def __enter__(self) -> Path:
        return self.repo

    def __exit__(self, exc_type, exc_value, traceback) -> None:
        self.temp_dir.cleanup()


if __name__ == "__main__":
    unittest.main()
