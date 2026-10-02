import importlib.util
import pathlib
import unittest


SCRIPT = pathlib.Path(__file__).with_name("qualify-real-cos-outage.py")
SPEC = importlib.util.spec_from_file_location("qualify_real_cos_outage", SCRIPT)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class MetricSumTest(unittest.TestCase):
    def test_sums_matching_series(self):
        payload = """\
rivet_sqlite_compaction_backlog_bytes{operation="cold_upload"} 4096
rivet_sqlite_compaction_backlog_bytes{operation="cold_publish"} 8192
rivet_sqlite_compaction_backlog_objects{operation="cold_upload"} 2
"""
        self.assertEqual(
            MODULE.metric_sum(payload, "rivet_sqlite_compaction_backlog_bytes"),
            12288,
        )
        self.assertEqual(
            MODULE.metric_sum(
                payload,
                "rivet_sqlite_compaction_backlog_bytes",
                {"operation": "cold_upload"},
            ),
            4096,
        )

    def test_absent_metric_fails_closed(self):
        with self.assertRaisesRegex(RuntimeError, "was absent"):
            MODULE.metric_sum("unrelated_metric 1\n", "missing_metric")


class RecoveredStateTest(unittest.TestCase):
    def state(self, *, branch="branch-a", head=12, cold=12, hot=12, ready=True):
        return {
            "branch_id": branch,
            "cold_ready": ready,
            "head": {"head_txid": head},
            "compaction_root": {
                "cold_watermark_txid": cold,
                "hot_watermark_txid": hot,
            },
        }

    def test_post_checkpoint_writes_are_covered_exactly(self):
        MODULE.validate_recovered_state(
            {"target_head_txid": 3},
            self.state(head=11, cold=0, hot=0, ready=False),
            self.state(head=12),
        )

    def test_rejects_wrong_branch_and_stale_cold_watermark(self):
        checkpoint = {"target_head_txid": 3}
        outage = self.state(head=11, cold=0, hot=0, ready=False)
        with self.assertRaisesRegex(RuntimeError, "branch identity"):
            MODULE.validate_recovered_state(
                checkpoint, outage, self.state(branch="branch-b")
            )
        with self.assertRaisesRegex(RuntimeError, "omitted acknowledged"):
            MODULE.validate_recovered_state(
                checkpoint, outage, self.state(head=12, cold=10, hot=12)
            )


if __name__ == "__main__":
    unittest.main()
