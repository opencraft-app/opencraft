import sys
import unittest
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.build_release_image import docker_build_command, resolve_docker_build_args  # noqa: E402
from contracts.bundles import ImageTarget  # noqa: E402


class BuildReleaseImageTests(unittest.TestCase):
    def test_frontend_playground_build_bakes_public_auth_api_base(self) -> None:
        self.assertEqual(
            resolve_docker_build_args("frontend", "sandbox-bj-7"),
            {"VITE_AUTH_API_BASE_URL": "https://lightclaw.tech"},
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
            {"VITE_AUTH_API_BASE_URL": "https://lightclaw.tech"},
        )

        self.assertIn("--build-arg", command)
        self.assertIn("VITE_AUTH_API_BASE_URL=https://lightclaw.tech", command)
        self.assertEqual(command[-1], "frontend")


if __name__ == "__main__":
    unittest.main()
