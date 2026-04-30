import sys
import unittest
from pathlib import Path


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

from gitops.gitops_merge_request import is_auto_mergeable, next_stage_after_merge  # noqa: E402


class GitopsMergeRequestTests(unittest.TestCase):
    def test_auto_mergeable_allows_unset_commit_check_when_not_blocked(self) -> None:
        self.assertTrue(
            is_auto_mergeable(
                {
                    "commit_check_state": None,
                    "commit_check_block": False,
                    "merge_status": "can_be_merged",
                }
            )
        )

    def test_auto_mergeable_allows_successful_commit_check(self) -> None:
        self.assertTrue(
            is_auto_mergeable(
                {
                    "commit_check_state": "success",
                    "commit_check_block": False,
                    "merge_status": "can_be_merged",
                }
            )
        )

    def test_auto_mergeable_rejects_blocked_or_unclean_mr(self) -> None:
        self.assertFalse(
            is_auto_mergeable(
                {
                    "commit_check_state": None,
                    "commit_check_block": True,
                    "merge_status": "can_be_merged",
                }
            )
        )
        self.assertFalse(
            is_auto_mergeable(
                {
                    "commit_check_state": None,
                    "commit_check_block": False,
                    "merge_status": "cannot_be_merged",
                }
            )
        )

    def test_auto_mergeable_rejects_failed_commit_check(self) -> None:
        self.assertFalse(
            is_auto_mergeable(
                {
                    "commit_check_state": "failure",
                    "commit_check_block": False,
                    "merge_status": "can_be_merged",
                }
            )
        )

    def test_shprod_auto_merge_note_points_to_manual_sync(self) -> None:
        self.assertIn("待同步状态", next_stage_after_merge("promote-shprod-frontend-abc"))
        self.assertIn("人工确认 DB readiness", next_stage_after_merge("promote-shprod-frontend-abc"))
        self.assertIn("等待 Argo CD 收敛", next_stage_after_merge("promote-beijing-sandbox-frontend-abc"))


if __name__ == "__main__":
    unittest.main()
