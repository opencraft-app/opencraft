import textwrap
import unittest
import sys
from pathlib import Path


RUNTIME_DIR = next(parent for parent in Path(__file__).resolve().parents if parent.name == "runtime" and parent.parent.name == ".ci")
if str(RUNTIME_DIR) not in sys.path:
    sys.path.insert(0, str(RUNTIME_DIR))

from gitops.release_facts import parse_trailers, release_facts_from_mapping
from gitops.release_view import (
    render_argo_success_note,
    render_failure_note,
    render_merge_only_note,
    render_release_view,
)


class ReleaseViewTests(unittest.TestCase):
    def test_parse_trailers_preserves_known_and_unknown_release_fields(self) -> None:
        trailers = parse_trailers(
            textwrap.dedent(
                """\
                发布到北京测试：ctl

                Release-id: beijing-sandbox/ctl/abcdef123456/ctl-tag
                Release-bundle: ctl
                Release-target-env: beijing-sandbox
                Release-extra-field: preserved
                Source-revision: abcdef1234567890
                Other: ignored
                """
            )
        )

        self.assertEqual(trailers["Release-id"], "beijing-sandbox/ctl/abcdef123456/ctl-tag")
        self.assertEqual(trailers["Release-extra-field"], "preserved")
        self.assertEqual(trailers["Source-revision"], "abcdef1234567890")
        self.assertNotIn("Other", trailers)

    def test_release_view_renders_release_mr_gate_and_next_action(self) -> None:
        facts = release_facts_from_mapping(
            {
                "Release-id": "beijing-sandbox/ctl/abcdef123456/ctl-tag",
                "Release-bundle": "ctl",
                "Release-target-env": "beijing-sandbox",
                "Release-pin-targets": "ctl",
                "Release-image": "example.com/ctl:tag",
                "Release-image-pin": "example.com/ctl@sha256:abc",
                "Release-gate-image-status": "passed",
                "Source-revision": "abcdef1234567890",
            }
        )

        body = render_release_view(
            headline="GitOps 进度：已进入 MR 自动合并阶段。",
            facts=facts,
            mr={"iid": 209, "source_branch": "promote-beijing-sandbox-ctl-tag", "target_branch": "gitops"},
            next_action="等待 commit checks 通过。",
        )

        self.assertIn("Release ID", body)
        self.assertIn("beijing-sandbox/ctl/abcdef123456/ctl-tag", body)
        self.assertIn("镜像存在性", body)
        self.assertIn("!209", body)
        self.assertIn("等待 commit checks 通过", body)

    def test_merge_only_view_mentions_manual_sync(self) -> None:
        body = render_merge_only_note(
            release_facts_from_mapping({"Release-target-env": "shprod", "Release-pin-targets": "frontend"}),
            {"iid": 220, "merge_commit_sha": "abcdef123456"},
            ["frontend-shprod"],
        )

        self.assertIn("待同步状态", body)
        self.assertIn("生产环境不自动同步", body)
        self.assertIn("frontend-shprod", body)

    def test_argo_success_and_failure_views_include_argo_table_and_error_action(self) -> None:
        facts = release_facts_from_mapping({"Release-target-env": "beijing-sandbox", "Release-pin-targets": "ctl"})
        result = {
            "app_name": "ctl-beijing-sandbox",
            "revision": "abcdef123456",
            "sync_status": "Synced",
            "health_status": "Healthy",
            "expected_images": ["example.com/ctl:v2"],
            "images": ["example.com/ctl:v2"],
        }

        success = render_argo_success_note(facts, {"iid": 221, "merge_commit_sha": "abcdef123456"}, [result])
        failure = render_failure_note(
            facts,
            {"iid": 221, "merge_commit_sha": "abcdef123456"},
            "application ctl-beijing-sandbox did not converge",
            [result],
        )

        self.assertIn("ctl-beijing-sandbox", success)
        self.assertIn("example.com/ctl:v2", success)
        self.assertIn("自动验收失败", failure)
        self.assertIn("打开 Argo app", failure)


if __name__ == "__main__":
    unittest.main()
