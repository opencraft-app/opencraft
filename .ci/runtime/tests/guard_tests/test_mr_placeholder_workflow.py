import unittest
from pathlib import Path

REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class MRPlaceholderWorkflowTests(unittest.TestCase):
    def test_only_mr_events_trigger_the_placeholder_check(self) -> None:
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()

        trigger_block = workflow.split("on:\n", 1)[1].split("\nstages:\n", 1)[0]
        self.assertNotIn("  push:", trigger_block)
        self.assertIn("  mr:\n", trigger_block)
        self.assertIn("    action: [ open, reopen, push-update ]", trigger_block)
        self.assertIn("    report-commit-check: true", trigger_block)
        self.assertIn("    block-mr: true", trigger_block)

    def test_new_mr_updates_cancel_older_checks_for_the_same_branch(self) -> None:
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()

        concurrency_block = workflow.split("concurrency:\n", 1)[1].split("\nstages:\n", 1)[0]
        self.assertIn("  group: mr-placeholder-${{ ci.branch }}", concurrency_block)
        self.assertIn("  cancel-in-progress: true", concurrency_block)
        self.assertIn("  queue-length: 1", concurrency_block)

    def test_ci_only_candidate_guard_fallback_is_constrained(self) -> None:
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()

        self.assertIn("GIT_WOA_PRIVATE_TOKEN: ${{ settings.GIT_WOA_PRIVATE_TOKEN }}", workflow)
        self.assertIn("source .ci/init.sh", workflow)
        self.assertIn("ci_git_fetch_origin master", workflow)
        self.assertIn("CI_EXPECTED_BRANCH='${{ ci.branch }}'", workflow)
        self.assertIn("CI_EXPECTED_SHA='${{ ci.sha }}'", workflow)
        self.assertIn('ci_git_fetch_origin master "$CI_EXPECTED_BRANCH"', workflow)
        self.assertIn('CI_ACTUAL_SHA="$(git rev-parse HEAD)"', workflow)
        self.assertIn('git reset --hard "$CI_EXPECTED_SHA"', workflow)
        self.assertIn("git clean -ffd", workflow)
        self.assertIn('test "$(git rev-parse HEAD)" = "$CI_EXPECTED_SHA"', workflow)
        self.assertLess(workflow.index("checkout: self"), workflow.index("校验并修复 MR checkout"))
        self.assertLess(workflow.index("校验并修复 MR checkout"), workflow.index("派发变更目录约束"))
        self.assertNotIn("git fetch origin master", workflow)
        init_script = (REPO_ROOT / ".ci/init.sh").read_text()
        self.assertIn("CI_GIT_FETCH_REMOTE_URL:-git@git.woa.com:wisp/mono2.git", init_script)
        self.assertIn("+refs/heads/${arg}:refs/remotes/origin/${arg}", init_script)
        self.assertIn('export CI_RUNTIME_REF="origin/master"', workflow)
        self.assertIn('git rev-parse "${CI_RUNTIME_REF}"', workflow)
        self.assertNotIn("ci_prepare_runtime_ref origin/master", workflow)
        self.assertIn("--trusted-ref origin/master", workflow)
        self.assertIn('--changed-files-file "$CHANGED_FILES_FILE"', workflow)
        self.assertIn("trusted guard 失败，检查是否允许 .ci 自修复 fallback", workflow)
        self.assertIn("grep -Ev '^\\s*$|^\\.ci(/|$)'", workflow)
        self.assertIn("存在非 .ci/** 变更，禁止 fallback", workflow)
        self.assertIn("[[ ! -f .ci/checks/guard.sh ]]", workflow)
        self.assertIn("bash .ci/checks/guard.sh", workflow)
        self.assertIn('GUARD_NAME="ci-runtime-candidate"', workflow)


if __name__ == "__main__":
    unittest.main()
