import argparse
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import sys
from contextlib import contextmanager

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gates import runner  # noqa: E402
from gates.image import ImageGateResult  # noqa: E402
from gates.result import APPROVED_GATE_KEYS, ReleaseGateResult  # noqa: E402


class GateRunnerTests(unittest.TestCase):
    def test_result_dotenv_contains_only_approved_shell_keys(self) -> None:
        result = ReleaseGateResult(
            image_status="passed",
            image_pin_payload="example.com/payment@sha256:abc",
            image_digests_json='{"example.com/payment:test":"sha256:abc"}',
            config_status="passed",
            db_status="passed",
            requires_db_readiness=True,
            auto_merge_allowed=True,
            auto_sync_allowed=False,
            argo_sync="manual",
            release_dependency_changed=False,
            manual_actions=["manual Argo sync required after GitOps MR merge"],
        )

        output = result.to_dotenv()
        keys = [line.split("=", 1)[0] for line in output.splitlines() if line.strip()]

        self.assertEqual(sorted(keys), sorted(APPROVED_GATE_KEYS))
        self.assertNotIn("GATE_DB_MODE", output)
        self.assertNotIn("GATE_REQUIRES_DB_JOB", output)
        self.assertNotIn("GATE_RELEASE_DEPENDENCIES", output)

    def test_runner_runs_image_gate_then_projected_config_before_db(self) -> None:
        call_order: list[str] = []

        with self.patch_runner(call_order) as patched:
            result = runner.run(self.args())
            patched["config"].assert_called_once()
            patched["db"].assert_called_once()
            self.assertEqual(patched["config"].call_args.kwargs["image"], "example.com/payment@sha256:abc")
            self.assertEqual(patched["db"].call_args.kwargs["image"], "example.com/payment@sha256:abc")
            self.assertEqual(
                patched["db"].call_args.kwargs["gitops_worktree"],
                patched["config"].call_args.kwargs["worktree"],
            )

        self.assertEqual(call_order, ["image", "config", "db"])
        self.assertEqual(result.image_status, "passed")
        self.assertEqual(result.image_pin_payload, "example.com/payment@sha256:abc")
        self.assertEqual(result.config_status, "passed")
        self.assertEqual(result.db_status, "passed")

    def test_runner_does_not_run_config_or_db_when_image_gate_fails(self) -> None:
        call_order: list[str] = []

        with mock.patch.object(runner, "run_image_gate", side_effect=lambda **_kwargs: call_order.append("image") or (_ for _ in ()).throw(RuntimeError("missing image"))), \
            mock.patch.object(runner, "run_config_gate", side_effect=lambda **_kwargs: call_order.append("config") or "passed"), \
            mock.patch.object(runner, "run_db_gate", side_effect=lambda **_kwargs: call_order.append("db") or ("passed", self.plan())):
            with self.assertRaises(RuntimeError):
                runner.run(self.args())

        self.assertEqual(call_order, ["image"])

    def test_temp_resources_cleanup_on_success(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            with runner.GateTempResources(repo_root) as resources:
                self.assertIsNotNone(resources.worktree)
                assert resources.worktree is not None
                resources.worktree.mkdir(parents=True)
                worktree = resources.worktree
            self.assertFalse(worktree.exists())

    def test_temp_resources_cleanup_on_failure(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            with self.assertRaises(RuntimeError):
                with runner.GateTempResources(repo_root) as resources:
                    self.assertIsNotNone(resources.worktree)
                    assert resources.worktree is not None
                    resources.worktree.mkdir(parents=True)
                    worktree = resources.worktree
                    raise RuntimeError("boom")
            self.assertFalse(worktree.exists())

    def test_temp_resources_do_not_delete_shell_owned_bootstrap(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            repo_root = Path(tmp)
            shell_bootstrap = repo_root / "shell-bootstrap"
            shell_bootstrap.mkdir()
            with runner.GateTempResources(repo_root) as resources:
                assert resources.worktree is not None
                resources.worktree.mkdir(parents=True)
            self.assertTrue(shell_bootstrap.exists())

    @contextmanager
    def patch_runner(self, call_order: list[str]):
        image = mock.Mock(
            side_effect=lambda **_kwargs: call_order.append("image")
            or ImageGateResult(
                status="passed",
                pin_payload="example.com/payment@sha256:abc",
                digests_json='{"example.com/payment:test":"sha256:abc"}',
            )
        )
        config = mock.Mock(side_effect=lambda **_kwargs: call_order.append("config") or "passed")
        db = mock.Mock(side_effect=lambda **_kwargs: call_order.append("db") or ("passed", self.plan()))
        with mock.patch.object(runner, "run_image_gate", image), \
            mock.patch.object(runner, "run_config_gate", config), \
            mock.patch.object(runner, "run_db_gate", db):
            yield {"image": image, "config": config, "db": db}

    def args(self) -> argparse.Namespace:
        return argparse.Namespace(
            repo_root=".",
            runtime_command_dir=str(RUNTIME_DIR / "commands"),
            bundle_service="payment",
            pin_targets="payment",
            env="beijing-sandbox",
            image="example.com/payment:test",
            source_ref="abc123",
            deployed_at="2026-05-02T00:00:00Z",
            remote_name="origin",
            gitops_branch="gitops",
            format="dotenv",
        )

    def plan(self) -> SimpleNamespace:
        return SimpleNamespace(
            requires_db_readiness=True,
            auto_merge_allowed=True,
            auto_sync_allowed=True,
            argo_sync="auto",
            release_dependency_changed=False,
            manual_actions=[],
        )


if __name__ == "__main__":
    unittest.main()
