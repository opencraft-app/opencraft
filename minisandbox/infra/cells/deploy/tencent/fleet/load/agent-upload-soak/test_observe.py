import importlib.util
import contextlib
import json
import subprocess
import tempfile
import threading
import unittest
import urllib.parse
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("agent_upload_observe", ROOT / "observe.py")
assert SPEC is not None and SPEC.loader is not None
OBSERVE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(OBSERVE)


class OptionalKubernetesObjectTest(unittest.TestCase):
    @mock.patch.object(OBSERVE.subprocess, "run")
    def test_exact_not_found_is_returned_as_absent(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, stdout="", stderr="")
        self.assertIsNone(OBSERVE.kube_optional(Path("/tmp/config"), "get", "machineset", "retired"))
        self.assertIn("--ignore-not-found=true", run.call_args.args[0])
        self.assertTrue(run.call_args.kwargs["check"])

    @mock.patch.object(OBSERVE.subprocess, "run")
    def test_present_object_is_decoded(self, run):
        value = {"metadata": {"uid": "machine-set-uid"}, "spec": {"replicas": 0}}
        run.return_value = subprocess.CompletedProcess(
            [], 0, stdout=json.dumps(value) + "\n", stderr="",
        )
        self.assertEqual(
            OBSERVE.kube_optional(Path("/tmp/config"), "get", "machineset", "retired"),
            value,
        )

    @mock.patch.object(OBSERVE.subprocess, "run")
    def test_transport_failure_is_not_reclassified_as_absent(self, run):
        run.side_effect = subprocess.CalledProcessError(1, ["kubectl"], stderr="timeout")
        with self.assertRaises(subprocess.CalledProcessError):
            OBSERVE.kube_optional(Path("/tmp/config"), "get", "machineset", "retired")


class DiagnosticMetricTest(unittest.TestCase):
    def test_capacity_trace_preserves_depot_pressure(self):
        queries = OBSERVE.metric_queries("actor-fdb-cell-system", "actor-bj-a01")
        self.assertEqual(
            set(queries),
            {
                "activeActors", "hostRssBytes", "udbPending", "gasolineWorkflows",
                "depotManagerRefreshInflight", "depotManagerRefreshWaiters",
                "depotCompactionInflight", "depotCompactionWaiters",
            },
        )
        self.assertIn('class="manager_refresh"', queries["depotManagerRefreshInflight"])
        self.assertIn('class="compaction"', queries["depotCompactionWaiters"])
        self.assertTrue(all('pod=~"actor-bj-a01-' in query for query in queries.values()))

    def test_rates_precede_aggregation_and_ledger_is_not_summed(self):
        queries = OBSERVE.diagnostic_queries("actor-fdb-cell-system", "actor-bj-a01")
        self.assertIn('sum by (operation,result)(rate(', queries["compactionJobsPerSecond"])
        self.assertIn('sum by (operation)(rate(', queries["compactionBytesPerSecond"])
        self.assertTrue(queries["coldStorageBytesMin"].startswith('min by (class)('))
        self.assertTrue(queries["coldStorageBytesMax"].startswith('max by (class)('))
        self.assertTrue(all('pod=~"actor-bj-a01-' in query for query in queries.values()))

    def test_scope_cannot_inject_another_cell(self):
        for namespace, cell in [('default"}', "actor-bj-a01"), ("default", ".*")]:
            with self.assertRaises(ValueError):
                OBSERVE.diagnostic_queries(namespace, cell)


@contextlib.contextmanager
def prometheus_response(payload, status=200):
    calls = []
    raw = payload if isinstance(payload, bytes) else json.dumps(payload).encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            calls.append(self.path)
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            try:
                self.wfile.write(raw)
            except (BrokenPipeError, ConnectionResetError):
                pass

        def log_message(self, *_):
            pass

    server = HTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.01})
    thread.start()
    try:
        yield "http://127.0.0.1:" + str(server.server_port), calls
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        if thread.is_alive():
            raise AssertionError("HTTP fixture did not shut down")


def sample(name, value="1", **dimensions):
    return {"metric": dict(trace=name, **dimensions), "value": [1790964960.25, value]}


def vector(*samples):
    return {"status": "success", "data": {"resultType": "vector", "result": list(samples)}}


class MetricHttpTest(unittest.TestCase):
    def collect(self, endpoint):
        return OBSERVE.collect_metrics(endpoint, "actor-fdb-cell-system", "actor-bj-a01")

    def test_one_request_preserves_query_timestamps_and_result_dimensions(self):
        rows = [sample("activeActors", "32"),
                sample("compactionJobsPerSecond", "0.2", operation="reclaim_fdb", result="retryable"),
                sample("compactionBytesPerSecond", "8192", operation="reclaim_fdb"),
                sample("coldStorageBytesMin", "16384", **{"class": "fdb_authoritative"}),
                sample("coldStorageBytesMax", "20480", **{"class": "fdb_authoritative"})]
        with prometheus_response(vector(*rows)) as (endpoint, calls):
            result = self.collect(endpoint)
        self.assertEqual(len(calls), 1)
        parameters = urllib.parse.parse_qs(urllib.parse.urlsplit(calls[0]).query)
        self.assertEqual(parameters["query"], [result["query"]])
        self.assertEqual(float(parameters["time"][0]), result["requestedAtEpochSeconds"])
        self.assertEqual(result["rateWindowSeconds"], 300)
        self.assertEqual(result["samples"][1]["labels"]["result"], "retryable")
        self.assertEqual(result["samples"][0]["timestamp"], 1790964960.25)
        self.assertEqual(result["samples"][0]["value"], "32")
        self.assertIn("depotCompactionWaiters", result["missingSignals"])
        self.assertNotIn("activeActors", result["missingSignals"])

    def test_missing_and_nonfinite_are_not_zero(self):
        with prometheus_response(vector(sample("activeActors", "NaN"),
                                        sample("hostRssBytes", "+Inf"))) as (endpoint, _):
            result = self.collect(endpoint)
        self.assertTrue(all(not item["finite"] for item in result["samples"]))
        self.assertEqual(result["samples"][0]["value"], "NaN")
        self.assertIn("activeActors", result["missingSignals"])
        self.assertIn("udbPending", result["missingSignals"])

    def test_warnings_are_preserved(self):
        payload = vector(sample("udbPending", "0"))
        payload["warnings"] = ["partial data"]
        with prometheus_response(payload) as (endpoint, _):
            result = self.collect(endpoint)
        self.assertEqual(result["warnings"], ["partial data"])

    def test_failed_response_is_not_retried(self):
        with prometheus_response({"status": "error"}) as (endpoint, calls):
            with self.assertRaises(ValueError):
                self.collect(endpoint)
        self.assertEqual(len(calls), 1)

    def test_http_failure_is_not_retried(self):
        with prometheus_response(b"unavailable", status=503) as (endpoint, calls):
            with self.assertRaises(OBSERVE.urllib.error.HTTPError):
                self.collect(endpoint)
        self.assertEqual(len(calls), 1)

    def test_nonvector_and_excess_rows_fail_closed(self):
        for payload in ({"status": "success", "data": {"resultType": "scalar", "result": [0, "0"]}},
                        vector(*[sample("activeActors") for _ in range(257)])):
            with prometheus_response(payload) as (endpoint, _):
                with self.assertRaises(ValueError):
                    self.collect(endpoint)

    def test_unbounded_or_unknown_dimensions_fail_closed(self):
        for row in (sample("activeActors", actor_id="unbounded"), sample("unknown")):
            with prometheus_response(vector(row)) as (endpoint, _):
                with self.assertRaises(ValueError):
                    self.collect(endpoint)

    def test_excess_response_bytes_fail_closed(self):
        with prometheus_response(b" " * 1048577) as (endpoint, calls):
            with self.assertRaisesRegex(ValueError, "1 MiB"):
                self.collect(endpoint)
        self.assertEqual(len(calls), 1)

    def test_malformed_json_is_not_a_zero_sample(self):
        with prometheus_response(b"{") as (endpoint, _):
            with self.assertRaises(ValueError):
                self.collect(endpoint)

    def test_invalid_timestamps_fail_closed(self):
        for timestamp in (float("nan"), True, "not-a-timestamp"):
            row = sample("activeActors")
            row["value"][0] = timestamp
            with prometheus_response(vector(row)) as (endpoint, _):
                with self.assertRaises(ValueError):
                    self.collect(endpoint)

    @mock.patch.object(OBSERVE, "kube", side_effect=RuntimeError("unavailable"))
    @mock.patch.object(OBSERVE, "kube_optional", side_effect=RuntimeError("unavailable"))
    def test_observe_preserves_existing_fields_without_more_http_calls(self, *_):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            base = Path(directory)
            endpoint_file = base / "endpoint.json"
            with prometheus_response(vector(sample("activeActors", "32"))) as (endpoint, calls):
                endpoint_file.write_text(json.dumps({"endpoint": endpoint}))
                result = OBSERVE.observe(base, "actor-bj-a01", endpoint_file)
            self.assertEqual(len(calls), 1)
            self.assertEqual(result["activeActors"], ["32"])
            self.assertEqual(result["udbPending"], [])
            self.assertIn("udbPending", result["metricsSnapshot"]["missingSignals"])
            self.assertTrue(result["errors"])


if __name__ == "__main__":
    unittest.main()
