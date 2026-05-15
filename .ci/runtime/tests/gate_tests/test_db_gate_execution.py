import unittest
from contextlib import redirect_stderr
from io import StringIO
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import sys

RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gates.db import run_db_gate  # noqa: E402


class DbGateExecutionTests(unittest.TestCase):
    def test_shprod_readiness_never_runs_controlled_db_job(self) -> None:
        command_calls: list[tuple[list[str], Path]] = []
        repo_root = Path("/tmp/source-root")
        gitops_worktree = Path("/tmp/projected-gitops")
        initial = self.plan(env="shprod", db_status="unknown")
        passed = self.plan(env="shprod", db_status="passed")

        with mock.patch("gates.db.load_plan", side_effect=[initial, passed]), \
            mock.patch("gates.db.run_logged", side_effect=lambda command, cwd: command_calls.append((command, cwd))), \
            redirect_stderr(StringIO()):
            status, plan = run_db_gate(
                repo_root=repo_root,
                gitops_worktree=gitops_worktree,
                runtime_command_dir=RUNTIME_DIR / "commands",
                bundle_manifest=RUNTIME_DIR / "release-bundles.manifest",
                service="payment",
                env="shprod",
                source_ref="abc123",
                image="example.com/payment:test",
                pin_targets="payment",
            )

        commands = [command for command, _cwd in command_calls]
        rendered_commands = "\n".join(" ".join(command) for command in commands)
        self.assertEqual(status, "passed")
        self.assertEqual(plan.db_status, "passed")
        self.assertIn("verify_db_contract.py", rendered_commands)
        self.assertNotIn("run_gitops_db_job.py", rendered_commands)
        verify_command = next(command for command in commands if any("verify_db_contract.py" in part for part in command))
        self.assertIn(str(gitops_worktree), verify_command)
        self.assertIn(str(repo_root), verify_command)
        self.assertIn("ci_ensure_db_job_tools", verify_command[2])
        self.assertIn((verify_command, gitops_worktree), command_calls)

    def test_beijing_readiness_runs_controlled_db_job_when_required(self) -> None:
        command_calls: list[tuple[list[str], Path]] = []
        repo_root = Path("/tmp/source-root")
        gitops_worktree = Path("/tmp/projected-gitops")
        initial = self.plan(env="beijing-sandbox", db_status="unknown")
        passed = self.plan(env="beijing-sandbox", db_status="passed")

        with mock.patch("gates.db.load_plan", side_effect=[initial, passed]), \
            mock.patch("gates.db.run_logged", side_effect=lambda command, cwd: command_calls.append((command, cwd))), \
            redirect_stderr(StringIO()) as stderr:
            status, plan = run_db_gate(
                repo_root=repo_root,
                gitops_worktree=gitops_worktree,
                runtime_command_dir=RUNTIME_DIR / "commands",
                bundle_manifest=RUNTIME_DIR / "release-bundles.manifest",
                service="payment",
                env="beijing-sandbox",
                source_ref="abc123",
                image="example.com/payment:test",
                pin_targets="payment",
            )

        commands = [command for command, _cwd in command_calls]
        rendered_commands = "\n".join(" ".join(command) for command in commands)
        self.assertEqual(status, "passed")
        self.assertEqual(plan.db_status, "passed")
        self.assertIn("run_gitops_db_job.py", rendered_commands)
        self.assertIn("verify_db_contract.py", rendered_commands)
        db_job_command = next(command for command in commands if any("run_gitops_db_job.py" in part for part in command))
        verify_command = next(command for command in commands if any("verify_db_contract.py" in part for part in command))
        self.assertEqual(db_job_command[0], "bash")
        self.assertIn("ci_ensure_db_job_tools", db_job_command[2])
        self.assertIn("ci_ensure_db_job_tools", verify_command[2])
        self.assertIn(str(repo_root), db_job_command)
        self.assertIn(str(gitops_worktree), db_job_command)
        self.assertIn(str(gitops_worktree), verify_command)
        self.assertIn((db_job_command, gitops_worktree), command_calls)
        self.assertIn((verify_command, gitops_worktree), command_calls)
        output = stderr.getvalue()
        self.assertIn("北京自动发布 DB gate 可视化", output)
        self.assertIn("受控 DB job：will_run=true", output)
        self.assertIn("DB readiness：will_run=true", output)
        self.assertIn("run_gitops_db_job.py --service payment --operation migration --env beijing-sandbox --revision abc123 --apply --wait", output)
        self.assertIn("verify_db_contract.py --service payment --env beijing-sandbox --apply --wait", output)

    def plan(self, *, env: str, db_status: str) -> SimpleNamespace:
        return SimpleNamespace(
            service="payment",
            env=env,
            source_sha="abc123",
            db_status=db_status,
            db_mode="migration",
            migration_changed=False,
            requires_db_job=True,
            requires_db_readiness=True,
            readiness_supported=True,
            db_job_service="payment",
            db_job_operation="migration",
            db_job_image_override="",
            release_dependency_changed=False,
            release_dependencies=[],
            auto_merge_allowed=True,
            auto_sync_allowed=env != "shprod",
            argo_sync="manual" if env == "shprod" else "auto",
            manual_actions=[],
        )


if __name__ == "__main__":
    unittest.main()
