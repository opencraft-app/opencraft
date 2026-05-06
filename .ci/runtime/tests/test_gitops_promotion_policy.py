import tempfile
import unittest
from pathlib import Path
from unittest import mock

from helpers import import_runtime_module


promotion_policy = import_runtime_module("gitops.promotion_policy")
gitops_promotion = import_runtime_module("gitops.gitops_promotion")


class PromotionPolicyTests(unittest.TestCase):
    def test_beijing_sandbox_2_prefix_wins_before_beijing_sandbox(self) -> None:
        policy = promotion_policy.policy_for_branch("promote-beijing-sandbox-2-ctl-abc123")

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "beijing-sandbox-2")
        self.assertEqual(policy.kustomize_mode.value, "full")
        self.assertEqual(policy.verify_mode.value, "argo_convergence")
        self.assertTrue(policy.auto_merge)
        self.assertTrue(policy.cleanup_source_branch)

    def test_shprod_policy_is_merge_only_changed_only_and_keeps_branch(self) -> None:
        policy = promotion_policy.policy_for_branch("promote-shprod-lightclaw-auth-abc123")

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "shprod")
        self.assertEqual(policy.kustomize_args, ["--changed-only"])
        self.assertEqual(
            policy.verify_args,
            ["--merge-only", "--merge-wait-seconds", "3600", "--merge-poll-seconds", "15"],
        )
        self.assertFalse(policy.auto_sync)
        self.assertFalse(policy.cleanup_source_branch)
        self.assertEqual(policy.required_argo_sync, "manual")

    def test_unknown_promote_branch_is_rejected(self) -> None:
        with self.assertRaises(ValueError):
            promotion_policy.require_policy_for_branch("promote-unknown-service-tag")


class PromotionCommandTests(unittest.TestCase):
    def test_verify_command_uses_shprod_merge_only_policy(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            commands: list[list[str]] = []
            with mock.patch.object(gitops_promotion, "_run", side_effect=lambda command, cwd=None: commands.append(command)):
                exit_code = gitops_promotion.verify_main(
                    [
                        "--repo-root",
                        repo,
                        "--source-branch",
                        "promote-shprod-lightclaw-auth-tag",
                        "--target-branch",
                        "gitops",
                    ]
                )

        self.assertEqual(exit_code, 0)
        self.assertEqual(len(commands), 1)
        command = commands[0]
        self.assertIn("verify_gitops_release.py", command[1])
        self.assertIn("--merge-only", command)
        self.assertIn("--merge-wait-seconds", command)
        self.assertIn("3600", command)

    def test_cleanup_command_skips_shprod_without_api_call(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            with mock.patch.object(gitops_promotion, "_run") as run:
                exit_code = gitops_promotion.cleanup_main(
                    [
                        "--repo-root",
                        repo,
                        "--source-branch",
                        "promote-shprod-lightclaw-auth-tag",
                        "--target-branch",
                        "gitops",
                    ]
                )

        self.assertEqual(exit_code, 0)
        run.assert_not_called()

    def test_cleanup_command_calls_underlying_cleanup_for_beijing(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            commands: list[list[str]] = []
            with mock.patch.object(gitops_promotion, "_run", side_effect=lambda command, cwd=None: commands.append(command)):
                exit_code = gitops_promotion.cleanup_main(
                    [
                        "--repo-root",
                        repo,
                        "--source-branch",
                        "promote-beijing-sandbox-ctl-tag",
                        "--target-branch",
                        "gitops",
                    ]
                )

        self.assertEqual(exit_code, 0)
        self.assertEqual(len(commands), 1)
        self.assertIn("gitops_cleanup_source_branch.py", commands[0][1])


if __name__ == "__main__":
    unittest.main()
