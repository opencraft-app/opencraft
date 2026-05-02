import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

import sys

RUNTIME_DIR = Path(__file__).resolve().parents[1]
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gates.db import run_db_gate  # noqa: E402


class DbGateExecutionTests(unittest.TestCase):
    def test_shprod_readiness_never_runs_controlled_db_job(self) -> None:
        commands: list[list[str]] = []
        initial = self.plan(env="shprod", db_status="unknown")
        passed = self.plan(env="shprod", db_status="passed")

        with mock.patch("gates.db.load_plan", side_effect=[initial, passed]), \
            mock.patch("gates.db.run_logged", side_effect=lambda command, cwd: commands.append(command)):
            status, plan = run_db_gate(
                repo_root=Path(".").resolve(),
                runtime_command_dir=RUNTIME_DIR / "commands",
                bundle_manifest=RUNTIME_DIR / "release-bundles.manifest",
                service="payment",
                env="shprod",
                source_ref="abc123",
                image="example.com/payment:test",
                pin_targets="payment",
            )

        rendered_commands = "\n".join(" ".join(command) for command in commands)
        self.assertEqual(status, "passed")
        self.assertEqual(plan.db_status, "passed")
        self.assertIn("verify_db_contract.py", rendered_commands)
        self.assertNotIn("run_gitops_db_job.py", rendered_commands)

    def test_beijing_readiness_runs_controlled_db_job_when_required(self) -> None:
        commands: list[list[str]] = []
        initial = self.plan(env="beijing-sandbox", db_status="unknown")
        passed = self.plan(env="beijing-sandbox", db_status="passed")

        with mock.patch("gates.db.load_plan", side_effect=[initial, passed]), \
            mock.patch("gates.db.run_logged", side_effect=lambda command, cwd: commands.append(command)):
            status, plan = run_db_gate(
                repo_root=Path(".").resolve(),
                runtime_command_dir=RUNTIME_DIR / "commands",
                bundle_manifest=RUNTIME_DIR / "release-bundles.manifest",
                service="payment",
                env="beijing-sandbox",
                source_ref="abc123",
                image="example.com/payment:test",
                pin_targets="payment",
            )

        rendered_commands = "\n".join(" ".join(command) for command in commands)
        self.assertEqual(status, "passed")
        self.assertEqual(plan.db_status, "passed")
        self.assertIn("run_gitops_db_job.py", rendered_commands)
        self.assertIn("verify_db_contract.py", rendered_commands)

    def plan(self, *, env: str, db_status: str) -> SimpleNamespace:
        return SimpleNamespace(
            service="payment",
            env=env,
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
