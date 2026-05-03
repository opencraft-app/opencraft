import io
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock


RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gates import config  # noqa: E402
from support import process  # noqa: E402


class ConfigGateTests(unittest.TestCase):
    def test_project_and_pin_preserves_commands_and_cwd(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp) / "repo"
            runtime_command_dir = repo_root / ".ci/runtime/commands"
            repo_root.mkdir(parents=True)
            with mock.patch.object(config, "run_logged") as run_logged:
                with redirect_stderr(io.StringIO()):
                    config.project_and_pin(
                        repo_root=repo_root,
                        runtime_command_dir=runtime_command_dir,
                        bundle_service="payment",
                        pin_targets="payment, subscription",
                        env="shprod",
                        image="example.com/payment@sha256:abc",
                        source_ref="abc123",
                        deployed_at="2026-05-03T00:00:00Z",
                    )

        self.assertEqual(run_logged.call_count, 3)
        self.assertEqual(
            run_logged.call_args_list[0],
            mock.call(
                [
                    "python3",
                    str(runtime_command_dir / "project_release_bundle.py"),
                    "--repo-root",
                    str(repo_root),
                    "--service",
                    "payment",
                    "--env",
                    "shprod",
                    "--source-ref",
                    "abc123",
                ],
                cwd=repo_root,
            ),
        )
        self.assertEqual(
            run_logged.call_args_list[1],
            mock.call(
                [
                    "python3",
                    str(runtime_command_dir / "update_image_pin.py"),
                    "--repo-root",
                    str(repo_root),
                    "--service",
                    "payment",
                    "--env",
                    "shprod",
                    "--image",
                    "example.com/payment@sha256:abc",
                    "--deployed-at",
                    "2026-05-03T00:00:00Z",
                ],
                cwd=repo_root,
            ),
        )
        self.assertEqual(run_logged.call_args_list[2].kwargs["cwd"], repo_root)
        self.assertIn("--service", run_logged.call_args_list[2].args[0])
        self.assertIn("subscription", run_logged.call_args_list[2].args[0])

    def test_validate_config_preserves_banner_and_validation_commands(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp) / "repo"
            init_repo_root = Path(tmp) / "source"
            runtime_command_dir = Path(tmp) / "runtime/commands"
            bundle_manifest = repo_root / ".ci/runtime/release-bundles.manifest"
            for service in ("payment", "subscription"):
                (repo_root / f"argocd/services/{service}/shprod").mkdir(parents=True)
                (repo_root / f"argocd/services/{service}/shprod/kustomization.yaml").write_text("resources: []\n")

            stderr = io.StringIO()
            with mock.patch.object(config, "run_logged") as run_logged, redirect_stderr(stderr):
                config.validate_config(
                    repo_root=repo_root,
                    init_repo_root=init_repo_root,
                    runtime_command_dir=runtime_command_dir,
                    bundle_manifest=bundle_manifest,
                    pin_targets="payment,subscription",
                    env="shprod",
                )

        output = stderr.getvalue()
        self.assertIn("GitOps 发布门禁：校验配置契约", output)
        self.assertIn("目标环境：shprod", output)
        self.assertIn("目标服务：payment,subscription", output)
        self.assertIn("GitOps 发布门禁：配置契约校验通过", output)
        self.assertEqual(run_logged.call_count, 3)
        static_command = run_logged.call_args_list[0].args[0]
        self.assertEqual(static_command[0:4], ["bash", "-c", mock.ANY, "bash"])
        self.assertEqual(static_command[4:], [str(init_repo_root), str(runtime_command_dir), str(repo_root), "shprod", str(bundle_manifest)])
        self.assertEqual(run_logged.call_args_list[0].kwargs["cwd"], repo_root)
        for call, service in zip(run_logged.call_args_list[1:], ("payment", "subscription"), strict=True):
            self.assertEqual(
                call,
                mock.call(
                    [
                        "python3",
                        str(runtime_command_dir / "validate_gitops_kustomize.py"),
                        "--repo-root",
                        str(repo_root),
                        "--env",
                        "shprod",
                        "--source-path",
                        f"argocd/services/{service}/shprod",
                    ],
                    cwd=repo_root,
                ),
            )

    def test_run_logged_forwards_stdout_then_stderr_to_stderr(self) -> None:
        command = ["demo"]
        with mock.patch.object(
            process.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(command, 0, stdout="out\n", stderr="err\n"),
        ) as run:
            stderr = io.StringIO()
            with redirect_stderr(stderr):
                config.run_logged(command, cwd=Path("/tmp"))

        run.assert_called_once_with(command, cwd=Path("/tmp"), text=True, capture_output=True, check=False)
        self.assertEqual(stderr.getvalue(), "out\nerr\n")

    def test_run_logged_preserves_failure_output(self) -> None:
        command = ["demo"]
        with mock.patch.object(
            process.subprocess,
            "run",
            return_value=subprocess.CompletedProcess(command, 7, stdout="out\n", stderr="err\n"),
        ):
            with self.assertRaises(subprocess.CalledProcessError) as raised:
                with redirect_stderr(io.StringIO()):
                    config.run_logged(command, cwd=Path("/tmp"))

        self.assertEqual(raised.exception.returncode, 7)
        self.assertEqual(raised.exception.cmd, command)
        self.assertEqual(raised.exception.output, "out\n")
        self.assertEqual(raised.exception.stderr, "err\n")


if __name__ == "__main__":
    unittest.main()
