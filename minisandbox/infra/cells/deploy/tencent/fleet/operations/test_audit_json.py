"""Strict JSON and unavailable observations at the real audit/control boundary."""

import hashlib
import importlib.util
import json
import math
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
import unittest


OPERATIONS = Path(__file__).parent
SPEC = importlib.util.spec_from_file_location("audit_json_subject", OPERATIONS / "autonomy_audit.py")
assert SPEC and SPEC.loader
audit = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(audit)
EVIDENCE = OPERATIONS.parent / "runtime/evidence/beijing-point-read-c631f554-a01-audit-20261003.json"


def reject_constant(value):
    raise ValueError("non-JSON numeric token: " + value)


def strict_load(payload):
    return json.loads(payload, parse_constant=reject_constant)


class AuditJsonTests(unittest.TestCase):
    def test_nested_nonfinite_diagnostics_are_strings_without_mutating_input(self):
        source = {"nested": [float("inf"), {"negative": float("-inf"), "unknown": float("nan")}],
                  "tuple": (True, None, 2, 1.5), "text": "NaN"}
        parsed = strict_load(audit.receipt_json_bytes(source))
        self.assertEqual(parsed["nested"], ["+Inf", {"negative": "-Inf", "unknown": "NaN"}])
        self.assertEqual(parsed["tuple"], [True, None, 2, 1.5])
        self.assertTrue(math.isinf(source["nested"][0]))
        self.assertTrue(math.isnan(source["nested"][1]["unknown"]))
        self.assertIsInstance(source["tuple"], tuple)

    def test_finite_receipts_preserve_exact_bytes(self):
        source = {"zero": 0, "negative_zero": -0.0, "finite": 1.2345,
                  "flag": False, "none": None, "string": "中文", "list": [1, True]}
        self.assertEqual(audit.receipt_json_bytes(source),
                         json.dumps(source, indent=2, sort_keys=True).encode())

    def test_scalar_nan_is_unavailable_not_zero_and_infinite_eta_is_preserved(self):
        rows = [{"value": [0, value]} for value in ["NaN", None, "invalid", "0", "1.5", "+Inf"]]
        self.assertEqual(audit.extract_scalar(rows), [0.0, 1.5, float("inf")])
        self.assertEqual(audit.extract_scalar(rows[:3]), [])

    def test_native_audit_becomes_strict_json_and_cli_hashes_written_bytes(self):
        original = EVIDENCE.read_bytes()
        original_digest = hashlib.sha256(original).hexdigest()
        self.assertEqual(original_digest,
                         "9b100d943e11a9992d9e46002ebb96e8b62a67f1e78948e9127e686b492f286a")
        with self.assertRaises(ValueError):
            strict_load(original)
        source = json.loads(original)
        payload = audit.receipt_json_bytes(source)
        parsed = strict_load(payload)
        expected = json.loads(original)
        for name in ("container_memory_headroom_eta_seconds", "fdb_storage_headroom_eta_seconds"):
            expected["prometheus"]["forecast"][name]["value"] = "+Inf"
            expected["prometheus"]["forecast"][name]["allValues"] = ["+Inf"]
        self.assertEqual(parsed, expected)
        self.assertEqual(parsed["verdict"], "passed")
        with tempfile.TemporaryDirectory(dir="/data/tmp") as directory:
            path = Path(directory) / "audit.json"
            path.write_bytes(payload)
            result = subprocess.run([sys.executable, str(OPERATIONS / "evaluate-autonomy-receipt.py"),
                                     str(path)], capture_output=True, text=True, check=False)
            self.assertEqual(result.returncode, 0, result.stderr)
            decision = strict_load(result.stdout)
            self.assertEqual(decision["control"], "allow")
            self.assertEqual(decision["sourceIdentity"], parsed["sourceIdentity"])
            self.assertEqual(decision["source_receipt_sha256"], hashlib.sha256(payload).hexdigest())
        self.assertEqual(EVIDENCE.read_bytes(), original)

    def test_real_prometheus_transport_classifies_nan_as_missing(self):
        class Prometheus(BaseHTTPRequestHandler):
            def do_GET(self):
                result = [] if "ALERTS" in self.path else [{"value": [0, "NaN"]}]
                payload = json.dumps({"status": "success", "data": {"result": result}}).encode()
                self.send_response(200)
                self.end_headers()
                self.wfile.write(payload)

            def log_message(self, *args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Prometheus)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            _, _, forecast = audit.collect_prometheus_state(
                "http://127.0.0.1:" + str(server.server_port), "namespace", "engine", "host", "cell")
        finally:
            server.shutdown()
            thread.join(timeout=5)
            server.server_close()
        for metric in forecast.values():
            self.assertEqual(metric["samples"], 0)
            self.assertIsNone(metric["value"])
        health = dict.fromkeys(["available", "healthy", "fullReplication", "reconcileAligned",
                              "backupRunning", "backupRestorable"], True)
        topology = {"engineReadyReplicas": 6, "engineReplicas": 6,
                    "runtimeHostStatefulSetReadyReplicas": 4, "runtimeHostStatefulSetReplicas": 4,
                    "engineZones": [1, 2, 3], "runtimeHostZones": [1, 2, 3],
                    "fdbPodReady": 9, "fdbZones": [1, 2, 3]}
        autoscaling = {"mode": "Automatic", "threeWayProcessAlignment": True,
                       "volumeGCMode": "ObserveOnly", "retentionAtLeast30Days": True}
        state = {name: metric["value"] for name, metric in forecast.items()}
        state.update(critical_count=0, warning_count=0)
        verdict, failures, warnings = audit.build_verdict(
            health, topology, autoscaling, state, [], {"ready": True})
        self.assertEqual(verdict, "failed")
        self.assertIn("engine_metrics_targets_missing", failures)
        self.assertIn("runtime_metrics_targets_missing", failures)
        self.assertTrue(any("prometheus_attribution_metrics_missing=" in warning for warning in warnings))


if __name__ == "__main__":
    unittest.main()
