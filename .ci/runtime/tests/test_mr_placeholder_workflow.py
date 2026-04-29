import unittest
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[3]


class MRPlaceholderWorkflowTests(unittest.TestCase):
    def test_ci_only_candidate_guard_fallback_is_constrained(self) -> None:
        workflow = (REPO_ROOT / ".ci/mr-placeholder.yml").read_text()

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
