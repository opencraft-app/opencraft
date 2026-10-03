"""Exercise collector evidence boundaries through real HTTP and its CLI."""

import hashlib
import http.server
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.parse

from test_capacity_receipt import capacity
from test_capture import CAPTURE, load_receipt


ROOT = Path(__file__).parent


class SampleWindowTest(unittest.TestCase):
    def capture(self, mutation=None, query_name="objectQps", load=None):
        observed = []

        class Handler(http.server.BaseHTTPRequestHandler):
            def do_GET(self):
                params = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                start, end = float(params["start"][0]), float(params["end"][0])
                step = int(params["step"][0])
                query = params["query"][0]
                final = start + int((end - start) // step) * step
                labels = {"source_cell": "actor-bj-a01", "target_cell": "actor-bj-b01"}
                series = [{"metric": labels, "values": [
                    [start, "1"], [start + step, "NaN"], [final, "2"],
                ]}]
                if mutation and query == CAPTURE.QUERIES[query_name]:
                    mutation(series, start, final)
                payload = {"status": "success", "data": {"resultType": "matrix", "result": series}}
                observed.append((query, payload))
                body = json.dumps(payload).encode()
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)

            def log_message(self, *unused):
                pass

        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            folder = Path(temporary)
            for name, value in (("capacity", capacity()), ("load", load_receipt() if load is None else load)):
                (folder / (name + ".json")).write_text(json.dumps(value))
            server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            output = folder / "output"
            try:
                result = subprocess.run([
                    sys.executable, str(ROOT / "capture.py"),
                    "--qualification-receipt", str(folder / "capacity.json"),
                    "--load-receipt", str(folder / "load.json"),
                    "--output-directory", str(output),
                    "--prometheus-url", "http://127.0.0.1:" + str(server.server_port),
                ], capture_output=True, text=True, timeout=10)
                if result.returncode != 0:
                    self.assertFalse(output.exists(), result.stderr)
                receipt_path = output / "receipt.json"
                receipt = json.loads(receipt_path.read_text()) if receipt_path.exists() else None
                raw_path = output / "prometheus-raw.json"
                raw_bytes = raw_path.read_bytes() if raw_path.exists() else None
                return result, receipt, raw_bytes, observed
            finally:
                server.shutdown()
                server.server_close()
                thread.join(timeout=2)

    def test_current_samples_and_nan_are_preserved_in_hashed_raw_evidence(self):
        result, receipt, raw_bytes, observed = self.capture()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(receipt["verdict"], "passed")
        self.assertEqual(receipt["source"]["rawEvidence"]["sha256"],
                         "sha256:" + hashlib.sha256(raw_bytes).hexdigest())
        raw = json.loads(raw_bytes)
        self.assertEqual(len(raw["queries"]), len(observed))
        summary = receipt["measurements"]["objectQps"]
        self.assertEqual(summary["discardedSamples"], 1)
        self.assertEqual(summary["sampleCount"], 2)

    def test_historical_and_future_timestamps_are_rejected_before_output(self):
        for offset in (-1000000, 1000000):
            def mutation(series, start, final):
                for point in series[0]["values"]:
                    point[0] += offset
            with self.subTest(offset=offset):
                result, receipt, raw, _ = self.capture(mutation)
                self.assertNotEqual(result.returncode, 0, result.stdout)
                self.assertIn("sample", result.stderr)
                self.assertIsNone(receipt)
                self.assertIsNone(raw)

    def test_duplicate_and_reverse_timestamps_are_rejected(self):
        for middle in (0, -1):
            def mutation(series, start, final):
                series[0]["values"][1][0] = start + middle
            with self.subTest(middle=middle):
                result, receipt, _, _ = self.capture(mutation)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("sample", result.stderr)
                self.assertIsNone(receipt)

    def test_malformed_sample_and_time_types_are_rejected(self):
        for malformed in ([True, "NaN"], ["1", "NaN"], [float("nan"), "NaN"], [1], None):
            def mutation(series, start, final):
                series[0]["values"][1] = malformed
            with self.subTest(malformed=malformed):
                result, receipt, _, _ = self.capture(mutation)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("sample", result.stderr)
                self.assertIsNone(receipt)

    def test_duplicate_label_series_are_rejected(self):
        def mutation(series, start, final):
            series.append(dict(series[0]))
        result, receipt, _, _ = self.capture(mutation)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("duplicate", result.stderr)
        self.assertIsNone(receipt)

    def test_old_finite_sample_cannot_replace_missing_or_nan_final_evaluation(self):
        for nan in (False, True):
            def mutation(series, start, final):
                if nan:
                    series[0]["values"][-1][1] = "NaN"
                else:
                    series[0]["values"].pop()
            with self.subTest(nan=nan):
                result, receipt, _, _ = self.capture(mutation)
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("final requested evaluation", result.stderr)
                self.assertIsNone(receipt)

    def test_stale_cross_cell_pair_cannot_be_rescued_by_current_same_cell_series(self):
        def mutation(series, start, final):
            series[0]["values"][-1][1] = "NaN"
            series.append({
                "metric": {"source_cell": "actor-bj-a01", "target_cell": "actor-bj-a01"},
                "values": [[final, "1"]],
            })
        result, receipt, _, _ = self.capture(mutation, query_name="crossCellP99Seconds")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("distinct bounded source/target", result.stderr)
        self.assertIsNone(receipt)

    def test_nan_only_series_cannot_become_zero_latency_evidence(self):
        def mutation(series, start, final):
            for sample in series[0]["values"]:
                sample[1] = "NaN"
        result, receipt, _, _ = self.capture(mutation)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("has no finite samples", result.stderr)
        self.assertIsNone(receipt)

    def test_millisecond_boundary_rounding_is_tolerated_but_not_wrong_windows(self):
        def mutation(series, start, final):
            series[0]["values"][0][0] -= 0.0004
            series[0]["values"][-1][0] += 0.0004
        result, receipt, _, _ = self.capture(mutation)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(receipt["measurements"]["objectQps"]["series"][0]["latestEvaluationObserved"])

    def test_inside_window_but_wrong_evaluation_grid_is_rejected(self):
        def mutation(series, start, final):
            series[0]["values"][1][0] = start + 7
        result, receipt, _, _ = self.capture(mutation)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requested evaluation grid", result.stderr)
        self.assertIsNone(receipt)

    def test_subsecond_load_boundary_uses_actual_serialized_query_grid(self):
        load = load_receipt()
        load["startedAt"] = "2026-09-25T00:00:00.123456Z"
        load["finishedAt"] = "2026-09-25T00:10:15.122476Z"
        result, receipt, _, observed = self.capture(load=load)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue(observed)
        self.assertTrue(receipt["measurements"]["objectQps"]["series"][0]["latestEvaluationObserved"])


if __name__ == "__main__":
    unittest.main()
