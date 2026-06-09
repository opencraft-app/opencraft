import sys
import unittest
from unittest import mock
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.build_release_image import (  # noqa: E402
    build_target,
    docker_daemon_available,
    docker_build_command,
    playground_frontend_auth_api_base_url,
    resolve_docker_build_args,
)
from contracts.bundles import ImageTarget  # noqa: E402


class BuildReleaseImageTests(unittest.TestCase):
    def test_frontend_playground_build_bakes_env_scoped_auth_api_base(self) -> None:
        self.assertEqual(
            resolve_docker_build_args("frontend", "sandbox-bj-7"),
            {"VITE_AUTH_API_BASE_URL": "https://api-sandbox-bj-7.lightclaw.tech"},
        )

    def test_playground_frontend_auth_api_base_uses_env_name(self) -> None:
        self.assertEqual(
            playground_frontend_auth_api_base_url("sandbox-bj-6"),
            "https://api-sandbox-bj-6.lightclaw.tech",
        )
        self.assertEqual(
            playground_frontend_auth_api_base_url("sandbox-kr-1"),
            "https://api-sandbox-kr-1.lightclaw.tech",
        )

    def test_frontend_non_playground_build_has_no_extra_build_args(self) -> None:
        self.assertEqual(resolve_docker_build_args("frontend", "shprod"), {})

    def test_non_frontend_playground_build_has_no_extra_build_args(self) -> None:
        self.assertEqual(resolve_docker_build_args("payment", "sandbox-bj-7"), {})

    def test_docker_build_command_places_build_args_before_context(self) -> None:
        target = ImageTarget(
            name="frontend",
            image_key=None,
            dockerfile="frontend/deploy/Dockerfile",
            build_context="frontend",
            image_repo="registry.example.com/lightclaw/frontend",
        )

        command = docker_build_command(
            target,
            "registry.example.com/lightclaw/frontend:frontend-sandbox-bj-7-abc123",
            "linux/amd64",
            {"VITE_AUTH_API_BASE_URL": "https://api-sandbox-bj-7.lightclaw.tech"},
        )

        self.assertIn("--build-arg", command)
        self.assertIn("VITE_AUTH_API_BASE_URL=https://api-sandbox-bj-7.lightclaw.tech", command)
        self.assertEqual(command[-1], "frontend")

    def test_docker_daemon_unavailable_when_binary_missing(self) -> None:
        with mock.patch("contracts.build_release_image.shutil.which", return_value=None):
            self.assertFalse(docker_daemon_available())

    def test_build_target_fails_before_build_when_docker_unavailable(self) -> None:
        target = ImageTarget(
            name="workers",
            image_key=None,
            dockerfile="workers/Dockerfile",
            build_context="workers",
            image_repo="registry.example.com/lightclaw/workers",
        )

        with mock.patch("contracts.build_release_image.docker_daemon_available", return_value=False), \
            mock.patch("contracts.build_release_image.print_runner_diagnostics"), \
            mock.patch("contracts.build_release_image.subprocess.run") as run:
            with self.assertRaisesRegex(RuntimeError, "docker daemon unavailable"):
                build_target(target, "workers-test", "linux/amd64", True, {})

        run.assert_not_called()

if __name__ == "__main__":
    unittest.main()
