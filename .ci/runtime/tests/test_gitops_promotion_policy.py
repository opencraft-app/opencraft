import tempfile
import subprocess
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

    def test_playground_branch_uses_auto_merge_convergence_policy(self) -> None:
        policy = promotion_policy.policy_for_branch("promote-sandbox-bj-7-trade-abc123")

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "sandbox-bj-7")
        self.assertEqual(policy.branch_prefix, "promote-sandbox-bj-7-")
        self.assertEqual(policy.kustomize_mode.value, "changed_only")
        self.assertEqual(policy.kustomize_args, ["--changed-only"])
        self.assertEqual(policy.verify_mode.value, "argo_convergence")
        self.assertTrue(policy.auto_merge)
        self.assertTrue(policy.auto_sync)
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

    def test_sgprod_policy_matches_production_manual_sync_shape(self) -> None:
        policy = promotion_policy.policy_for_branch("promote-sgprod-lightclaw-auth-abc123")

        self.assertIsNotNone(policy)
        self.assertEqual(policy.env, "sgprod")
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
    def test_release_trailers_are_read_from_release_commit_not_repair_head(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            repo_path = Path(repo)
            subprocess.run(["git", "init", "-b", "gitops"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.name", "test"], cwd=repo_path, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo_path, check=True)
            (repo_path / "state.txt").write_text("base\n")
            subprocess.run(["git", "add", "state.txt"], cwd=repo_path, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "checkout", "-b", "promote-beijing-sandbox-ctl-tag"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)
            (repo_path / "state.txt").write_text("release\n")
            subprocess.run(["git", "add", "state.txt"], cwd=repo_path, check=True)
            subprocess.run(
                [
                    "git",
                    "commit",
                    "-m",
                    "发布到北京测试：ctl",
                    "-m",
                    "Release-id: beijing-sandbox/ctl/source/tag\nRelease-gate-auto-merge: true\nRelease-gate-argo-sync: auto",
                ],
                cwd=repo_path,
                check=True,
                stdout=subprocess.DEVNULL,
            )
            (repo_path / "ci.txt").write_text("repair\n")
            subprocess.run(["git", "add", "ci.txt"], cwd=repo_path, check=True)
            subprocess.run(["git", "commit", "-m", "刷新 CI 入口"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)

            trailers = gitops_promotion._release_trailers(  # noqa: SLF001
                repo_path,
                "promote-beijing-sandbox-ctl-tag",
                "gitops",
            )

        self.assertEqual(trailers["Release-gate-auto-merge"], "true")
        self.assertEqual(trailers["Release-gate-argo-sync"], "auto")

    def test_release_trailer_selection_reports_ignored_runtime_trigger_commits(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            repo_path = Path(repo)
            subprocess.run(["git", "init", "-b", "gitops"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.name", "test"], cwd=repo_path, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo_path, check=True)
            (repo_path / "state.txt").write_text("base\n")
            subprocess.run(["git", "add", "state.txt"], cwd=repo_path, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "checkout", "-b", "promote-sandbox-bj-7-service-gateway-tag"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)
            (repo_path / "state.txt").write_text("release\n")
            subprocess.run(["git", "add", "state.txt"], cwd=repo_path, check=True)
            subprocess.run(
                [
                    "git",
                    "commit",
                    "-m",
                    "发布到北京 Playground sandbox-bj-7：service-gateway",
                    "-m",
                    "\n".join(
                        [
                            "Release-id: sandbox-bj-7/service-gateway/source/tag",
                            "Release-runtime-ref: playground/sandbox-bj-7",
                            "Release-runtime-commit: source",
                            "Release-gate-auto-merge: true",
                            "Release-gate-argo-sync: auto",
                        ]
                    ),
                ],
                cwd=repo_path,
                check=True,
                stdout=subprocess.DEVNULL,
            )
            subprocess.run(
                [
                    "git",
                    "commit",
                    "--allow-empty",
                    "-m",
                    "Trigger promotion validation",
                    "-m",
                    "Release-runtime-ref: playground/sandbox-bj-7\nRelease-runtime-commit: runtime-fix",
                ],
                cwd=repo_path,
                check=True,
                stdout=subprocess.DEVNULL,
            )

            selection = gitops_promotion._select_release_trailers(  # noqa: SLF001
                repo_path,
                "promote-sandbox-bj-7-service-gateway-tag",
                "gitops",
            )

        self.assertEqual(selection.search_mode, "target_range")
        self.assertEqual(selection.trailers["Release-gate-auto-merge"], "true")
        self.assertEqual(selection.trailers["Release-runtime-commit"], "source")
        self.assertEqual(len(selection.ignored_runtime_only_revisions), 1)
        self.assertEqual(selection.ignored_runtime_only_summary, selection.ignored_runtime_only_revisions[0][:12])

    def test_release_gate_error_includes_selected_commit_and_repair_hint(self) -> None:
        selection = gitops_promotion.ReleaseTrailerSelection(
            trailers={
                "Release-id": "sandbox-bj-7/service-gateway/source/tag",
                "Release-runtime-ref": "playground/sandbox-bj-7",
                "Release-runtime-commit": "244a7f35333177bfe9da737fee7950e52bb6c083",
            },
            revision="6c7b587f299998601ce9bf2bb65aac45d6d805e1",
            search_mode="source_history_fallback",
            ignored_runtime_only_revisions=("07e734bf4223fcf1dd1574f72d1a8607e2a92728",),
        )

        message = gitops_promotion._release_gate_error(  # noqa: SLF001
            "promote-sandbox-bj-7-service-gateway-service-gateway-a14b69b75466",
            selection,
            "Release-gate-auto-merge",
            "",
            "true",
        )

        self.assertIn("Release-gate-auto-merge=missing expected=true", message)
        self.assertIn("release_commit=6c7b587f2999", message)
        self.assertIn("ignored_runtime_only_commits=07e734bf4223", message)
        self.assertIn("CI retrigger/repair commit", message)

    def test_release_trailers_refresh_remote_promote_ref(self) -> None:
        with tempfile.TemporaryDirectory() as temp:
            origin = Path(temp) / "origin.git"
            source = Path(temp) / "source"
            ci = Path(temp) / "ci"
            subprocess.run(["git", "init", "--bare", origin], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "init", "-b", "gitops", source], check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.name", "test"], cwd=source, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=source, check=True)
            (source / "state.txt").write_text("base\n")
            subprocess.run(["git", "add", "state.txt"], cwd=source, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=source, check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "remote", "add", "origin", str(origin)], cwd=source, check=True)
            subprocess.run(["git", "push", "origin", "gitops"], cwd=source, check=True, stdout=subprocess.DEVNULL)

            subprocess.run(["git", "checkout", "-b", "promote-beijing-sandbox-ctl-tag"], cwd=source, check=True, stdout=subprocess.DEVNULL)
            (source / "state.txt").write_text("release\n")
            subprocess.run(["git", "add", "state.txt"], cwd=source, check=True)
            subprocess.run(
                [
                    "git",
                    "commit",
                    "-m",
                    "发布到北京测试：ctl",
                    "-m",
                    "Release-id: beijing-sandbox/ctl/source/tag\nRelease-gate-auto-merge: true\nRelease-gate-argo-sync: auto",
                ],
                cwd=source,
                check=True,
                stdout=subprocess.DEVNULL,
            )
            subprocess.run(["git", "push", "origin", "promote-beijing-sandbox-ctl-tag"], cwd=source, check=True, stdout=subprocess.DEVNULL)

            subprocess.run(["git", "clone", "--branch", "gitops", "--single-branch", str(origin), str(ci)], check=True, stdout=subprocess.DEVNULL)

            trailers = gitops_promotion._release_trailers(  # noqa: SLF001
                ci,
                "promote-beijing-sandbox-ctl-tag",
                "gitops",
            )

        self.assertEqual(trailers["Release-gate-auto-merge"], "true")
        self.assertEqual(trailers["Release-gate-argo-sync"], "auto")

    def test_validate_rejects_ci_changes_in_promote_diff(self) -> None:
        with tempfile.TemporaryDirectory() as repo:
            repo_path = Path(repo)
            subprocess.run(["git", "init", "-b", "gitops"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "config", "user.name", "test"], cwd=repo_path, check=True)
            subprocess.run(["git", "config", "user.email", "test@example.com"], cwd=repo_path, check=True)
            (repo_path / "state.txt").write_text("base\n")
            subprocess.run(["git", "add", "state.txt"], cwd=repo_path, check=True)
            subprocess.run(["git", "commit", "-m", "base"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)
            subprocess.run(["git", "checkout", "-b", "promote-beijing-sandbox-ctl-tag"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)
            (repo_path / ".ci").mkdir()
            (repo_path / ".ci/gitops-promotion.yml").write_text("version: v2.0\n")
            subprocess.run(["git", "add", ".ci/gitops-promotion.yml"], cwd=repo_path, check=True)
            subprocess.run(["git", "commit", "-m", "bad ci diff"], cwd=repo_path, check=True, stdout=subprocess.DEVNULL)

            with self.assertRaisesRegex(RuntimeError, "must not carry .ci changes"):
                gitops_promotion._reject_ci_changes(  # noqa: SLF001
                    repo_path,
                    "promote-beijing-sandbox-ctl-tag",
                    "gitops",
                )

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
