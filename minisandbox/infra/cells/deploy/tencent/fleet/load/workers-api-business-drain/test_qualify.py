#!/usr/bin/env python3
"""Real HTTP, filesystem and subprocess checks for the business drain gate."""

import argparse
import base64
import concurrent.futures
import http.server
import importlib.util
import json
import os
import pathlib
import shutil
import subprocess
import tempfile
import threading
import unittest
import urllib.request


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("business_drain", ROOT / "qualify.py")
gate = importlib.util.module_from_spec(spec)
spec.loader.exec_module(gate)
RUN_ID = "0123456789abcdef0123456789abcdef"


class DrainTests(unittest.TestCase):
    def test_stream_requires_complete_exact_bytes_and_admission_order(self):
        first, last = gate.chunks(RUN_ID)
        gate.validate_stream(first, last, RUN_ID, 30, 35, True)
        for suffix, stopped, completed, pending in (
            (last[:-1], 30, 35, True), (last + b"x", 30, 35, True),
            (last, None, 35, True), (last, 35, 30, True), (last, 30, 35, False),
        ):
            with self.subTest(size=len(suffix), stopped=stopped, pending=pending):
                with self.assertRaises(RuntimeError):
                    gate.validate_stream(first, suffix, RUN_ID, stopped, completed, pending)

    def test_real_http_stream_is_held_until_release_and_truncation_rejected(self):
        for truncate in (False, True):
            with self.subTest(truncate=truncate):
                release = threading.Event()
                first, last = gate.chunks(RUN_ID)

                class Handler(http.server.BaseHTTPRequestHandler):
                    def do_GET(self):
                        self.send_response(200)
                        self.send_header("content-length", str(len(first) + len(last)))
                        self.end_headers()
                        self.wfile.write(first)
                        self.wfile.flush()
                        release.wait(5)
                        self.wfile.write(last[:-1] if truncate else last)
                        self.wfile.flush()
                        self.close_connection = True

                    def log_message(self, *args):
                        pass

                server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
                thread = threading.Thread(target=server.serve_forever, daemon=True)
                thread.start()
                try:
                    with urllib.request.urlopen(f"http://127.0.0.1:{server.server_port}", timeout=5) as response:
                        prefix = response.read(gate.CHUNK_BYTES)
                        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
                            reading = pool.submit(response.read, gate.CHUNK_BYTES + 1)
                            self.assertFalse(reading.done())
                            release.set()
                            suffix = reading.result(timeout=5)
                        if truncate:
                            with self.assertRaises(RuntimeError):
                                gate.validate_stream(prefix, suffix, RUN_ID, 30, 35, True)
                        else:
                            gate.validate_stream(prefix, suffix, RUN_ID, 30, 35, True)
                finally:
                    release.set()
                    server.shutdown()
                    server.server_close()
                    thread.join()

    def test_uid_delete_uses_real_subprocess_and_never_changes_grace(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = pathlib.Path(temporary)
            executable = root / "kubectl"
            shutil.copyfile(ROOT / "fixtures/kubectl", executable)
            executable.chmod(0o700)
            capture = root / "capture.json"
            names = ("PATH", "MINI_DRAIN_TEST_DELETE_CAPTURE", "MINI_DRAIN_TEST_CURRENT_UID")
            before = {name: os.environ.get(name) for name in names}
            os.environ.update({"PATH": str(root) + os.pathsep + os.environ["PATH"],
                "MINI_DRAIN_TEST_DELETE_CAPTURE": str(capture), "MINI_DRAIN_TEST_CURRENT_UID": "selected-uid"})
            try:
                pod = {"metadata": {"name": "workers-api-selected", "uid": "selected-uid"}}
                gate.delete_exact_pod(root / "owned-kubeconfig", pod, root)
                wire = json.loads(capture.read_text())
                self.assertEqual(wire["path"], "/api/v1/namespaces/workers-api-system/pods/workers-api-selected")
                self.assertEqual(wire["body"]["preconditions"], {"uid": "selected-uid"})
                self.assertNotIn("gracePeriodSeconds", wire["body"])
                os.environ["MINI_DRAIN_TEST_CURRENT_UID"] = "replacement-uid"
                with self.assertRaises(subprocess.CalledProcessError):
                    gate.delete_exact_pod(root / "owned-kubeconfig", pod, root)
            finally:
                for name, value in before.items():
                    if value is None:
                        os.environ.pop(name, None)
                    else:
                        os.environ[name] = value

    def test_source_has_distinct_forwarding_sessions_for_held_stream_and_probe(self):
        source = (ROOT / "qualify.py").read_text()
        self.assertIn('f"{port}:8080"', source)
        self.assertIn('f"{probe_port}:8080"', source)
        self.assertIn('request("GET", probe_direct + "/readyz"', source)
        self.assertIn('refusal_observed.wait(2)', source)

    def test_failed_policy_identity_is_distinct(self):
        deployment = {"metadata": {"uid": "d"}, "spec": {"replicas": 3}}
        hpa = {"metadata": {"uid": "h"}, "spec": {"minReplicas": 3}}
        initial = gate.identity(deployment, hpa)
        hpa["spec"]["minReplicas"] = 4
        self.assertNotEqual(initial, gate.identity(deployment, hpa))
        hpa["spec"]["minReplicas"] = 3
        deployment["metadata"]["uid"] = "replacement"
        self.assertNotEqual(initial, gate.identity(deployment, hpa))

    def test_receipt_cannot_overwrite_existing_file(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            path = pathlib.Path(temporary) / "receipt.json"
            gate.ha.publish_new(path, {"verdict": "failed"})
            with self.assertRaises(ValueError):
                gate.ha.publish_new(path, {"verdict": "passed"})
            self.assertEqual(json.loads(path.read_text())["verdict"], "failed")

    def test_cleanup_process_failure_preserves_failed_receipt(self):
        result = {"verdict": "passed", "cleanup": {}}
        gate.cleanup_step(result, "owned_process", lambda: subprocess.run(
            ["sh", "-c", "exit 7"], check=True))
        self.assertEqual(result["verdict"], "failed")
        self.assertEqual(result["cleanup"]["helperFailures"], [{
            "operation": "owned_process", "type": "CalledProcessError"}])
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            receipt = pathlib.Path(temporary) / "receipt.json"
            gate.ha.publish_new(receipt, result)
            self.assertEqual(json.loads(receipt.read_text()), result)

    def test_generated_worker_parses_and_streams_the_exact_first_chunk(self):
        node = shutil.which("node")
        if node is None:
            self.skipTest("Node is unavailable; cloud workerd validation remains mandatory")
        source = base64.b64encode(gate.worker_source(RUN_ID).encode()).decode()
        program = f'''
          const {{default: worker}} = await import("data:text/javascript;base64,{source}");
          const response = worker.fetch(new Request("https://api-drain.example/stream"));
          const {{value}} = await response.body.getReader().read();
          const expected = ("started:{RUN_ID}\\n").padEnd(65536, "x");
          if (new TextDecoder().decode(value) !== expected || response.headers.get("content-length") !== "131072") process.exit(1);
          const fast = await worker.fetch(new Request("https://api-drain.example/instant?sequence=7")).json();
          if (fast.run !== "{RUN_ID}" || fast.sequence !== "7") process.exit(1);
          process.exit(0);
        '''
        subprocess.run([node, "--input-type=module", "-e", program], check=True, timeout=5)

    def test_arguments_reject_existing_receipt_unpinned_image_and_public_endpoint(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = pathlib.Path(temporary)
            kubeconfig = root / "owned-kubeconfig"
            kubeconfig.write_text("owned test file")
            args = argparse.Namespace(kubeconfig=kubeconfig, endpoint="http://10.160.0.3:6688",
                expected_image="example/runtime@sha256:" + "a" * 64,
                source_revision="b" * 40, source_manifest_sha256="c" * 64,
                run_id=RUN_ID, receipt=root / "receipt.json", timeout=180)
            prior = os.environ.get("AUTONOMY_OPERATION_LOCK_HELD")
            os.environ["AUTONOMY_OPERATION_LOCK_HELD"] = "1"
            try:
                gate.validate_args(args)
                for field, value in (("endpoint", "http://8.8.8.8:6688"),
                    ("endpoint", "http://user:password@10.160.0.3:6688"),
                    ("expected_image", "example/runtime:latest"), ("run_id", "invalid"),
                    ("source_revision", "incomplete"), ("source_manifest_sha256", "incomplete"),
                    ("receipt", pathlib.Path("relative.json"))):
                    with self.subTest(field=field):
                        original = getattr(args, field)
                        setattr(args, field, value)
                        with self.assertRaises(ValueError):
                            gate.validate_args(args)
                        setattr(args, field, original)
                args.receipt.write_text("preserved")
                with self.assertRaises(ValueError):
                    gate.validate_args(args)
                self.assertEqual(args.receipt.read_text(), "preserved")
            finally:
                if prior is None:
                    os.environ.pop("AUTONOMY_OPERATION_LOCK_HELD", None)
                else:
                    os.environ["AUTONOMY_OPERATION_LOCK_HELD"] = prior


if __name__ == "__main__":
    unittest.main()
