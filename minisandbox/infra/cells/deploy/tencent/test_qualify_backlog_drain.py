import importlib.util
import pathlib
import sys
import unittest


MODULE_PATH = pathlib.Path(__file__).with_name("qualify_backlog_drain.py")
SPEC = importlib.util.spec_from_file_location("qualify_backlog_drain", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
backlog = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = backlog
SPEC.loader.exec_module(backlog)


class BacklogDrainTests(unittest.TestCase):
    def test_default_requires_every_drain_lane_to_be_observed(self):
        self.assertEqual(backlog.DEFAULT_OBSERVED_LANES, backlog.ZERO_DRAIN_LANES)

    def test_command_receipt_does_not_retain_arguments(self):
        command = ["/usr/local/bin/load", "--token", "do-not-write-this"]
        receipt = backlog.command_receipt(command)

        self.assertEqual(receipt["executable"], "load")
        self.assertEqual(receipt["argument_count"], 2)
        self.assertNotIn("do-not-write-this", str(receipt))
        self.assertEqual(len(receipt["argv_sha256"]), 64)

    def test_future_gc_retention_does_not_block_drain(self):
        sample = {
            "lanes": {
                "hot_compaction_dirty": 0,
                "hot_compaction_jobs": 0,
                "cold_publish": 0,
                "branch_gc_due": 0,
                "cold_gc_due": 0,
                "reconciliation": 0,
                "branch_gc_future_retained": 100,
                "cold_gc_future_retained": 200,
            }
        }
        self.assertTrue(backlog.is_drained(sample))
        sample["lanes"]["cold_publish"] = 1
        self.assertFalse(backlog.is_drained(sample))

    def test_scan_rejects_cursor_cycles(self):
        pages = [
            {"scope": "depot-dirty", "row_count": 1000, "next_cursor": "same"},
            {"scope": "depot-dirty", "row_count": 1000, "next_cursor": "same"},
        ]
        original = backlog.request_json
        backlog.request_json = lambda *_: pages.pop(0)
        try:
            with self.assertRaisesRegex(RuntimeError, "invalid cursor"):
                backlog.scan_pages(
                    "http://engine",
                    "/depot/inspect/footprint",
                    {"scope": "depot-dirty"},
                    "depot-dirty",
                    1,
                    None,
                )
        finally:
            backlog.request_json = original

    def test_due_page_counters_must_partition_rows(self):
        original = backlog.request_json
        backlog.request_json = lambda *_: {
            "scope": "cold-gc",
            "row_count": 2,
            "due_rows": 2,
            "future_retained_rows": 1,
            "next_cursor": None,
        }
        try:
            with self.assertRaisesRegex(RuntimeError, "inconsistent"):
                backlog.scan_pages(
                    "http://engine",
                    "/depot/inspect/due-queue",
                    {"scope": "cold-gc"},
                    "cold-gc",
                    1,
                    None,
                    due_queue=True,
                )
        finally:
            backlog.request_json = original


if __name__ == "__main__":
    unittest.main()
