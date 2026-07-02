import sys
import tempfile
import unittest
from unittest import mock
from types import SimpleNamespace
from pathlib import Path


REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())
RUNTIME_DIR = REPO_ROOT / ".ci" / "runtime"
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from contracts.build_release_image import (  # noqa: E402
    build_target,
    docker_daemon_available,
    docker_build_command,
    image_for_target,
    main,
    playground_frontend_auth_api_base_url,
    playground_frontend_region,
    resolve_docker_build_args,
)
from contracts.bundles import ImageTarget  # noqa: E402
from contracts.image_existence import ImageCheckResult  # noqa: E402


class BuildReleaseImageTests(unittest.TestCase):
    def test_frontend_playground_build_bakes_env_scoped_auth_api_base(self) -> None:
        self.assertEqual(
            resolve_docker_build_args("frontend", "sandbox-bj-7"),
            {
                "NEXT_PUBLIC_AUTH_API_BASE_URL": "https://api-sandbox-bj-7.lightclaw.tech",
                "NEXT_PUBLIC_REGION": "cn",
                "VITE_AUTH_API_BASE_URL": "https://api-sandbox-bj-7.lightclaw.tech",
                "VITE_REGION": "cn",
            },
        )
        self.assertEqual(
            resolve_docker_build_args("frontend", "sandbox-kr-1"),
            {
                "NEXT_PUBLIC_AUTH_API_BASE_URL": "https://api-sandbox-kr-1.lightclaw.tech",
                "NEXT_PUBLIC_REGION": "global",
                "VITE_AUTH_API_BASE_URL": "https://api-sandbox-kr-1.lightclaw.tech",
                "VITE_REGION": "global",
            },
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

    def test_playground_frontend_region_uses_cluster_region(self) -> None:
        self.assertEqual(playground_frontend_region("sandbox-bj-7"), "cn")
        self.assertEqual(playground_frontend_region("sandbox-kr-1"), "global")

    def test_frontend_non_playground_build_has_no_extra_build_args(self) -> None:
        self.assertEqual(resolve_docker_build_args("frontend", "shprod"), {})

    def test_non_frontend_playground_build_has_no_extra_build_args(self) -> None:
        self.assertEqual(resolve_docker_build_args("payment", "sandbox-bj-7"), {})

    def test_docker_build_command_places_build_args_before_context(self) -> None:
        target = ImageTarget(
            name="frontend",
            image_key=None,
            dockerfile="frontend/deploy/Dockerfile",
            build_context=".",
            image_repo="registry.example.com/lightclaw/frontend",
        )

        command = docker_build_command(
            target,
            "registry.example.com/lightclaw/frontend:frontend-sandbox-bj-7-abc123",
            "linux/amd64",
            {
                "NEXT_PUBLIC_AUTH_API_BASE_URL": "https://api-sandbox-bj-7.lightclaw.tech",
                "NEXT_PUBLIC_REGION": "cn",
                "VITE_AUTH_API_BASE_URL": "https://api-sandbox-bj-7.lightclaw.tech",
                "VITE_REGION": "cn",
            },
        )

        self.assertIn("--build-arg", command)
        self.assertIn("NEXT_PUBLIC_AUTH_API_BASE_URL=https://api-sandbox-bj-7.lightclaw.tech", command)
        self.assertIn("NEXT_PUBLIC_REGION=cn", command)
        self.assertIn("VITE_AUTH_API_BASE_URL=https://api-sandbox-bj-7.lightclaw.tech", command)
        self.assertIn("VITE_REGION=cn", command)
        self.assertEqual(command[-1], ".")

    def test_image_for_target_matches_docker_build_image_ref(self) -> None:
        target = ImageTarget(
            name="lightclaw-auth",
            image_key=None,
            dockerfile="user/auth/Dockerfile",
            build_context=".",
            image_repo="registry.example.com/lightclaw/lightclaw-auth",
        )

        image = image_for_target(target, "user-auth-abc123")
        command = docker_build_command(target, image, "linux/amd64", {})

        self.assertEqual(image, "registry.example.com/lightclaw/lightclaw-auth:user-auth-abc123")
        self.assertIn(image, command)

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

    def test_main_reuses_existing_remote_image_without_building(self) -> None:
        target = ImageTarget(
            name="lightclaw-auth",
            image_key=None,
            dockerfile="user/auth/Dockerfile",
            build_context=".",
            image_repo="registry.example.com/lightclaw/lightclaw-auth",
        )
        bundle = SimpleNamespace(
            service="user-auth",
            env="shprod",
            image_targets=None,
            dockerfile=target.dockerfile,
            build_context=target.build_context,
            image_repo=target.image_repo,
        )
        expected_image = "registry.example.com/lightclaw/lightclaw-auth:user-auth-abc123"

        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(sys, "argv", [
                "build_release_image.py",
                "--service", "user-auth",
                "--env", "shprod",
                "--tag", "user-auth-abc123",
                "--push",
                "--reuse-existing",
                "--image-output-file", str(Path(tmp) / "image.txt"),
            ]), \
            mock.patch("contracts.build_release_image.load_manifest", return_value={}), \
            mock.patch("contracts.build_release_image.load_bundle", return_value=bundle), \
            mock.patch("contracts.build_release_image.require_build_metadata", return_value=bundle), \
            mock.patch("contracts.build_release_image.verify_images", return_value=[
                ImageCheckResult(expected_image, True, "sha256:auth"),
            ]) as verify, \
            mock.patch("contracts.build_release_image.build_target") as build:
            self.assertEqual(main(), 0)

            verify.assert_called_once_with([expected_image], log_missing_errors=False)
            build.assert_not_called()
            self.assertEqual((Path(tmp) / "image.txt").read_text().strip(), expected_image)

    def test_main_builds_when_expected_remote_image_is_missing(self) -> None:
        target = ImageTarget(
            name="lightclaw-auth",
            image_key=None,
            dockerfile="user/auth/Dockerfile",
            build_context=".",
            image_repo="registry.example.com/lightclaw/lightclaw-auth",
        )
        bundle = SimpleNamespace(
            service="user-auth",
            env="shprod",
            image_targets=None,
            dockerfile=target.dockerfile,
            build_context=target.build_context,
            image_repo=target.image_repo,
        )
        expected_image = "registry.example.com/lightclaw/lightclaw-auth:user-auth-abc123"

        with tempfile.TemporaryDirectory() as tmp, \
            mock.patch.object(sys, "argv", [
                "build_release_image.py",
                "--service", "user-auth",
                "--env", "shprod",
                "--tag", "user-auth-abc123",
                "--push",
                "--reuse-existing",
                "--image-output-file", str(Path(tmp) / "image.txt"),
            ]), \
            mock.patch("contracts.build_release_image.load_manifest", return_value={}), \
            mock.patch("contracts.build_release_image.load_bundle", return_value=bundle), \
            mock.patch("contracts.build_release_image.require_build_metadata", return_value=bundle), \
            mock.patch("contracts.build_release_image.verify_images", return_value=[
                ImageCheckResult(expected_image, False),
            ]) as verify, \
            mock.patch("contracts.build_release_image.build_target", return_value=expected_image) as build:
            self.assertEqual(main(), 0)

            verify.assert_called_once_with([expected_image], log_missing_errors=False)
            build.assert_called_once_with(
                ImageTarget(
                    name="user-auth",
                    image_key=None,
                    dockerfile=target.dockerfile,
                    build_context=target.build_context,
                    image_repo=target.image_repo,
                ),
                "user-auth-abc123",
                "linux/amd64",
                True,
                {},
            )
            self.assertEqual((Path(tmp) / "image.txt").read_text().strip(), expected_image)

if __name__ == "__main__":
    unittest.main()
