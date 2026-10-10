import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("router_performance_run", ROOT / "run.py")
RUN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUN)


class RouterPerformanceRunTest(unittest.TestCase):
    def test_balanced_names_cover_each_cell_and_are_stable(self):
        cells = {"a": "uid-a", "b": "uid-b", "c": "uid-c"}
        first = RUN.balanced_names("default", "worker", "a" * 32, cells, 17)
        second = RUN.balanced_names("default", "worker", "a" * 32, cells, 17)
        self.assertEqual(first, second)
        counts = {cell: 0 for cell in cells}
        for item in first:
            counts[item["cell"]] += 1
            self.assertEqual(
                RUN.selected_cell("worker", item["objectId"], cells), item["cell"]
            )
        self.assertEqual(sorted(counts.values()), [5, 6, 6])

    def test_passed_requires_exact_clean_window_and_cleanup(self):
        receipt = {
            "stopReason": None,
            "elapsedSeconds": 300,
            "placements": {"a": {}, "b": {}},
            "dispatchWindow": {"startedWithinWindow": 10000, "startedAfterWindow": 0},
            "counters": {
                "requestsScheduled": 10000,
                "requestsSucceeded": 10000,
                "requestsFailed": 0,
                "requestRetries": 0,
                "objectsPrepared": 10,
                "objectsDeleted": 10,
            },
        }
        self.assertTrue(RUN.passed(receipt, 10000, 10, 300, 2))
        receipt["counters"]["requestRetries"] = 1
        self.assertFalse(RUN.passed(receipt, 10000, 10, 300, 2))

    def test_atomic_publish_refuses_overwrite(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            target = Path(temporary) / "receipt.json"
            RUN.publish(target, {"schema": RUN.SCHEMA})
            self.assertEqual(json.loads(target.read_text())["schema"], RUN.SCHEMA)
            with self.assertRaisesRegex(ValueError, "new absolute path"):
                RUN.publish(target, {})

    def test_endpoint_requires_public_v1_shape(self):
        self.assertEqual(RUN.endpoint("https://example.test/v1/"), "https://example.test/v1")
        for value in ("https://example.test", "https://u:p@example.test/v1", "ftp://example.test/v1"):
            with self.assertRaises(Exception):
                RUN.endpoint(value)

    def test_arrival_timing_does_not_hide_dispatch_delay(self):
        timing = RUN.RequestTiming()
        timing.started(10, 10.5, 20)
        timing.completed(10, 10.5, 10.75)
        self.assertEqual(timing.schedule.as_json()["maxMs"], 500)
        self.assertEqual(timing.response.as_json()["maxMs"], 250)
        self.assertEqual(timing.arrival.as_json()["maxMs"], 750)
        timing.started(19.9, 20, 20)
        self.assertEqual(timing.window(), {"startedWithinWindow": 1, "startedAfterWindow": 1})

    def test_arrival_timing_rejects_invalid_monotonic_order(self):
        timing = RUN.RequestTiming()
        for values in ((10, 9, 20), (20, 21, 20), (10, float("nan"), 20)):
            with self.subTest(values=values), self.assertRaises(ValueError):
                timing.started(*values)
        for values in ((10, 9, 20), (10, 11, 9), (10, 11, float("inf"))):
            with self.subTest(values=values), self.assertRaises(ValueError):
                timing.completed(*values)


if __name__ == "__main__":
    unittest.main()
