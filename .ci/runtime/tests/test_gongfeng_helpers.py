import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


RUNTIME_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(RUNTIME_DIR))

from gitops.gongfeng import (  # noqa: E402
    branch_url,
    merge_request_merge_url,
    merge_request_note_url,
    merge_requests_url,
    resolve_private_token,
)


class GongfengHelperTests(unittest.TestCase):
    def test_resolve_private_token_prefers_explicit_value(self) -> None:
        with patch.dict(os.environ, {"GIT_WOA_PRIVATE_TOKEN": "env-token"}):
            self.assertEqual(resolve_private_token(" explicit-token "), "explicit-token")

    def test_resolve_private_token_reads_file_before_env(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            token_file = Path(tmpdir) / "token"
            token_file.write_text("file-token\n")

            with patch.dict(os.environ, {"GIT_WOA_PRIVATE_TOKEN": "env-token"}):
                self.assertEqual(resolve_private_token(None, str(token_file)), "file-token")

    def test_gongfeng_urls_encode_query_and_branch(self) -> None:
        self.assertEqual(
            merge_requests_url(
                "https://git.woa.com/api/v3",
                123,
                state="opened",
                source_branch="promote/a b",
                target_branch="gitops",
            ),
            "https://git.woa.com/api/v3/projects/123/merge_requests"
            "?state=opened&source_branch=promote%2Fa+b&target_branch=gitops",
        )
        self.assertEqual(
            branch_url("https://git.woa.com/api/v3", 123, "promote/a b"),
            "https://git.woa.com/api/v3/projects/123/repository/branches/promote%2Fa%20b",
        )
        self.assertEqual(
            merge_request_note_url("https://git.woa.com/api/v3", 123, 456),
            "https://git.woa.com/api/v3/projects/123/merge_requests/456/notes",
        )
        self.assertEqual(
            merge_request_merge_url("https://git.woa.com/api/v3", 123, 456),
            "https://git.woa.com/api/v3/projects/123/merge_request/456/merge",
        )


if __name__ == "__main__":
    unittest.main()
