import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("router_performance_capture", ROOT / "capture.py")
CAPTURE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(CAPTURE)


def response(labels=None, values=None):
    return {
        "status": "success",
        "data": {
            "resultType": "matrix",
            "result": [{
                "metric": labels or {},
                "values": values or [[1, "1"], [2, "2"]],
            }],
        },
    }


class Client:
    def __init__(self, missing=None, same_cell=False):
        self.missing = missing
        self.same_cell = same_cell
        self.calls = []

    def get(self, query, start, end, step):
        self.calls.append((query, start, end, step))
        name = next(name for name, value in CAPTURE.QUERIES.items() if value == query)
        if name == self.missing:
            return {"status": "success", "data": {"resultType": "matrix", "result": []}}
        if name.startswith("crossCell") or name == "routesByCell":
            target = "actor-bj-a01" if self.same_cell else "actor-bj-b01"
            return response({"source_cell": "actor-bj-a01", "target_cell": target},
                            [[start, "1"], [end, "2"]])
        return response(values=[[start, "1"], [end, "2"]])


def load_receipt():
    return {
        "schema": "actor-router-binding-performance-load/v2",
        "mode": "stateless-worker-durable-object-binding",
        "verdict": "passed",
        "startedAt": "2026-09-25T00:00:00Z",
        "finishedAt": "2026-09-25T00:10:00Z",
        "offeredWindowFinishedAt": "2026-09-25T00:10:00Z",
        "durationTargetSeconds": 600,
        "rateTargetPerSecond": 20,
        "requestTarget": 12000,
        "objectTarget": 100,
        "dispatchWindow": {"startedWithinWindow": 12000, "startedAfterWindow": 0},
        "counters": {
            "objectsPrepared": 100,
            "objectsDeleted": 100,
            "requestsScheduled": 12000,
            "requestsSucceeded": 12000,
            "requestsFailed": 0,
            "requestRetries": 0,
        },
        "placements": {
            "actor-bj-a01": {"objects": 50},
            "actor-bj-b01": {"objects": 50},
        },
        **{name: {"count": 12000, "p50UpperBoundMs": 1, "p95UpperBoundMs": 2,
                  "p99UpperBoundMs": 3, "p999UpperBoundMs": 4, "maxMs": 4}
           for name in ("latency", "scheduleLatency", "arrivalLatency")},
    }


class CaptureTest(unittest.TestCase):
    def test_collects_every_bounded_measurement(self):
        client = Client()
        raw, summary = CAPTURE.collect(client, load_receipt(), 15, 10000)
        self.assertEqual(set(summary), set(CAPTURE.QUERIES))
        self.assertEqual(set(raw["queries"]), set(CAPTURE.QUERIES))
        self.assertEqual(len(client.calls), len(CAPTURE.QUERIES))
        self.assertEqual(summary["objectQps"]["sampleCount"], 2)
        self.assertEqual(summary["objectQps"]["mean"], 1.5)

    def test_rejects_missing_series(self):
        with self.assertRaisesRegex(ValueError, "has no finite samples"):
            CAPTURE.collect(Client(missing="registryTps"), load_receipt(), 15, 10000)

    def test_rejects_same_cell_only_latency(self):
        with self.assertRaisesRegex(ValueError, "distinct bounded source/target"):
            CAPTURE.collect(Client(same_cell=True), load_receipt(), 15, 10000)

    def test_rejects_unpassed_or_short_load(self):
        load = load_receipt()
        load["verdict"] = "failed"
        with self.assertRaisesRegex(ValueError, "not a passed"):
            CAPTURE.collect(Client(), load, 15, 10000)
        load = load_receipt()
        load["finishedAt"] = "2026-09-25T00:01:00Z"
        load["offeredWindowFinishedAt"] = load["finishedAt"]
        with self.assertRaisesRegex(ValueError, "too short"):
            CAPTURE.collect(Client(), load, 15, 10000)

    def test_rejects_too_few_or_unclean_object_requests(self):
        load = load_receipt()
        load["counters"]["requestsSucceeded"] = 9999
        with self.assertRaisesRegex(ValueError, "enough clean binding requests"):
            CAPTURE.collect(Client(), load, 15, 10000)
        load = load_receipt()
        load["counters"]["requestRetries"] = 1
        with self.assertRaisesRegex(ValueError, "enough clean binding requests"):
            CAPTURE.collect(Client(), load, 15, 10000)

    def test_rejects_direct_objectref_or_one_cell_load(self):
        load = load_receipt()
        load["schema"] = "actor-shared-agent-scale/v1"
        with self.assertRaisesRegex(ValueError, "stateless Worker binding"):
            CAPTURE.collect(Client(), load, 15, 10000)
        load = load_receipt()
        load["placements"].pop("actor-bj-b01")
        with self.assertRaisesRegex(ValueError, "at least two Cells"):
            CAPTURE.collect(Client(), load, 15, 10000)

    def test_atomic_publish_refuses_overwrite(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            target = Path(temporary) / "receipt.json"
            CAPTURE.publish(target, {"answer": 42})
            self.assertEqual(json.loads(target.read_text()), {"answer": 42})
            with self.assertRaisesRegex(ValueError, "new file"):
                CAPTURE.publish(target, {"answer": 43})

    def test_every_rolling_selector_excludes_preparation_and_response_drain(self):
        client = Client()
        load = load_receipt()
        load["finishedAt"] = "2026-09-25T00:10:30Z"
        raw, unused = CAPTURE.collect(client, load, 15, 10000)
        started = CAPTURE.parse_time(load["startedAt"], "startedAt").timestamp()
        offered_end = CAPTURE.parse_time(load["offeredWindowFinishedAt"], "end").timestamp()
        for query, first, last, step in client.calls:
            self.assertGreaterEqual(first - CAPTURE.ROLLING_WINDOW_SECONDS, started)
            self.assertEqual(last, offered_end)
        self.assertEqual(raw["loadWindow"]["start"], "2026-09-25T00:00:00+00:00")
        self.assertEqual(raw["timeRange"]["start"], "2026-09-25T00:05:00+00:00")

    def test_partial_schedule_and_incomplete_timing_fail_before_metrics_access(self):
        for field in ("requestsScheduled", "requestsSucceeded", "objectsDeleted"):
            client = Client()
            load = load_receipt()
            load["counters"][field] -= 1
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "clean binding"):
                CAPTURE.collect(client, load, 15, 10000)
            self.assertFalse(client.calls)
        for field in ("latency", "scheduleLatency", "arrivalLatency"):
            client = Client()
            load = load_receipt()
            load[field]["count"] -= 1
            with self.subTest(field=field), self.assertRaisesRegex(ValueError, "arrival/dispatch evidence"):
                CAPTURE.collect(client, load, 15, 10000)
            self.assertFalse(client.calls)

    def test_invalid_shape_and_old_schema_are_not_accepted(self):
        for field, value in (("rateTargetPerSecond", True), ("requestTarget", 12001),
                             ("objectTarget", 101), ("durationTargetSeconds", float("inf")),
                             ("schema", "actor-router-binding-performance-load/v1")):
            client = Client()
            load = load_receipt()
            load[field] = value
            with self.subTest(field=field), self.assertRaises(ValueError):
                CAPTURE.collect(client, load, 15, 10000)
            self.assertFalse(client.calls)

    def test_late_dispatch_cannot_be_mistaken_for_a_clean_offered_window(self):
        client = Client()
        load = load_receipt()
        load["dispatchWindow"] = {"startedWithinWindow": 11999, "startedAfterWindow": 1}
        with self.assertRaisesRegex(ValueError, "outside the offered-load window"):
            CAPTURE.collect(client, load, 15, 10000)
        self.assertFalse(client.calls)


if __name__ == "__main__":
    unittest.main()
