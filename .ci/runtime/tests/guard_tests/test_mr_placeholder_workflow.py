import unittest
from pathlib import Path

REPO_ROOT = next(parent for parent in Path(__file__).resolve().parents if (parent / ".ci/runtime").is_dir())


class MRPlaceholderWorkflowTests(unittest.TestCase):
    def test_ci_only_candidate_guard_fallback_is_constrained(self) -> None:
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()

        self.assertIn("GIT_WOA_PRIVATE_TOKEN: ${{ settings.GIT_WOA_PRIVATE_TOKEN }}", workflow)
        self.assertIn("source .ci/init.sh", workflow)
        self.assertIn("ci_git_fetch_origin master", workflow)
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
