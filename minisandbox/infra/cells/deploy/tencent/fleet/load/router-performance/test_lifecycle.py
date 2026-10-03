import contextlib
import http.server
import importlib.util
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import threading
from types import SimpleNamespace
import unittest
import urllib.parse
import urllib.request


ROOT = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("router_lifecycle", ROOT / "run.py")
RUN = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(RUN)


@contextlib.contextmanager
def kubectl_fixture():
    with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
        executable = Path(temporary) / "kubectl"
        executable.write_bytes((ROOT / "fixtures/kubectl.py").read_bytes())
        executable.chmod(0o700)
        old_path = os.environ["PATH"]
        os.environ["PATH"] = temporary + os.pathsep + old_path
        try:
            yield
        finally:
            os.environ["PATH"] = old_path


@contextlib.contextmanager
def protocol_server(scenario):
    events = []
    objects = RUN.balanced_names("default", "worker", "a" * 32,
                                 {"a": "uid-a", "b": "uid-b"}, 2)
    cells = {item["objectId"]: "uid-" + item["cell"] for item in objects}
    dispatches = []

    class Handler(http.server.BaseHTTPRequestHandler):
        def reply(self, status, value):
            body = json.dumps(value).encode() if value is not None else b""
            self.send_response(status)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def do_GET(self):
            events.append(("GET", self.path))
            if self.path == "/readyz":
                self.reply(503 if scenario == "unready" else 200, {"ready": True})
            else:
                uid = cells[self.path.rsplit("/", 1)[-1]]
                self.reply(200, {"placement": {"cell_uid": "wrong" if scenario == "placement" else uid}})

        def do_POST(self):
            events.append(("POST", self.path))
            self.rfile.read(int(self.headers.get("content-length", "0")))
            if self.path.endswith("/versions"):
                self.reply(201, {"id": "version"})
            elif self.path.endswith("/deployments"):
                self.reply(201, {"id": "deployment"})
            else:
                name = urllib.parse.parse_qs(urllib.parse.urlparse(
                    self.headers["X-Workers-Original-URL"]).query)["name"][0]
                dispatches.append(name)
                failed = (scenario in {"partial", "cleanup", "missing-delete"} and len(dispatches) == 2
                          or scenario == "load" and len(dispatches) == 3)
                self.reply(503 if failed else 200, {"name": name, "value": 1})

        def do_DELETE(self):
            events.append(("DELETE", self.path))
            status = 503 if scenario == "cleanup" else 404 if scenario == "missing-delete" else 204
            self.reply(status, None)

        def log_message(self, *unused):
            pass

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        yield f"http://127.0.0.1:{server.server_port}", events, objects
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)


def arguments(base):
    return SimpleNamespace(
        endpoint=base + "/v1", registry_endpoint=base, registry_service=None,
        registry_namespace="worker-registry-system", hub_kubeconfig=Path("fixture"),
        cell=["a", "b"], namespace="default", worker="worker", run_id="a" * 32,
        objects=2, duration_seconds=300, rate=40, concurrency=4,
        timeout_seconds=2, compatibility_date="2026-08-14",
    )


class RouterLifecycleTest(unittest.TestCase):
    def test_registry_unready_prevents_all_mutation(self):
        with protocol_server("unready") as (base, events, unused):
            with self.assertRaisesRegex(RuntimeError, "HTTP 503"):
                RUN.run(arguments(base))
            self.assertEqual(events, [("GET", "/readyz")])

    def test_partial_dispatch_failure_cleans_both_attempted_objects_and_writes_failure(self):
        with kubectl_fixture(), protocol_server("partial") as (base, events, objects):
            receipt = RUN.run(arguments(base))
            self.assertEqual(receipt["verdict"], "failed")
            self.assertEqual(receipt["stopReason"], "preparation_failed")
            self.assertEqual(receipt["counters"]["objectsPrepared"], 1)
            self.assertEqual(receipt["counters"]["objectsDeleted"], 2)
            self.assertEqual(receipt["counters"]["requestRetries"], 0)
            self.assertEqual(receipt["latency"]["count"], 0)
            deleted = [path.rsplit("/", 1)[-1] for method, path in events if method == "DELETE"]
            self.assertEqual(deleted, [item["objectId"] for item in objects])
            with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
                target = Path(temporary) / "receipt.json"
                RUN.publish(target, receipt)
                self.assertEqual(json.loads(target.read_text())["stopReason"], "preparation_failed")

    def test_placement_mismatch_cleans_only_the_attempted_object(self):
        with kubectl_fixture(), protocol_server("placement") as (base, events, objects):
            receipt = RUN.run(arguments(base))
            self.assertEqual(receipt["stopReason"], "preparation_failed")
            self.assertEqual(receipt["counters"]["objectsPrepared"], 0)
            self.assertEqual(receipt["counters"]["objectsDeleted"], 1)
            self.assertEqual([path.rsplit("/", 1)[-1] for method, path in events if method == "DELETE"],
                             [objects[0]["objectId"]])

    def test_cleanup_failure_is_visible_and_does_not_mask_preparation_failure(self):
        with kubectl_fixture(), protocol_server("cleanup") as (base, events, unused):
            receipt = RUN.run(arguments(base))
            self.assertEqual(receipt["stopReason"], "preparation_failed")
            self.assertEqual(receipt["errors"]["cleanup"], 2)
            self.assertEqual(len(receipt["cleanup"]["errors"]), 2)
            self.assertEqual(receipt["counters"]["objectsDeleted"], 0)
            self.assertEqual(receipt["verdict"], "failed")

    def test_forward_stops_on_normal_and_exceptional_exit(self):
        for fail in (False, True):
            with self.subTest(fail=fail), kubectl_fixture():
                args = arguments("http://unused")
                args.registry_endpoint = None
                args.registry_service = "worker-registry"
                url = None
                try:
                    with RUN.reachable_registry(args) as url:
                        with urllib.request.urlopen(url + "/readyz", timeout=2) as response:
                            self.assertEqual(response.status, 200)
                        if fail:
                            raise ValueError("intentional boundary")
                except ValueError as error:
                    self.assertTrue(fail)
                    self.assertIn("intentional boundary", str(error))
                with self.assertRaises(OSError):
                    urllib.request.urlopen(url + "/readyz", timeout=2)

    def test_missing_delete_is_only_accepted_for_unconfirmed_attempt(self):
        with kubectl_fixture(), protocol_server("missing-delete") as (base, events, objects):
            receipt = RUN.run(arguments(base))
            self.assertEqual(receipt["verdict"], "failed")
            self.assertEqual(receipt["errors"]["cleanup"], 1)
            self.assertEqual(receipt["cleanup"]["errors"][0]["objectId"], objects[0]["objectId"])
            self.assertEqual(receipt["cleanup"]["deletedObjectIds"], [objects[1]["objectId"]])

    def test_real_successful_load_measures_only_load_requests(self):
        with kubectl_fixture(), protocol_server("healthy") as (base, events, unused):
            args = arguments(base)
            # The local protocol fixture has a short window, not production eligibility.
            args.duration_seconds = 1
            args.rate = 2
            receipt = RUN.run(args)
            self.assertEqual(receipt["verdict"], "passed")
            self.assertEqual(receipt["counters"]["requestsSucceeded"], 2)
            self.assertEqual(receipt["latency"]["count"], 2)
            self.assertEqual(receipt["counters"]["objectsDeleted"], 2)
            self.assertFalse(receipt["cleanup"]["errors"])

    def test_load_failure_still_cleans_all_prepared_objects_without_retry(self):
        with kubectl_fixture(), protocol_server("load") as (base, events, unused):
            args = arguments(base)
            args.duration_seconds = 1
            args.rate = 2
            receipt = RUN.run(args)
            self.assertEqual(receipt["verdict"], "failed")
            self.assertEqual(receipt["stopReason"], "request_failed")
            self.assertEqual(receipt["counters"]["requestsFailed"], 1)
            self.assertEqual(receipt["counters"]["objectsDeleted"], 2)
            self.assertEqual(receipt["counters"]["requestRetries"], 0)

    def test_failed_forward_start_is_not_silently_accepted(self):
        with kubectl_fixture():
            args = arguments("http://unused")
            args.registry_endpoint = None
            args.registry_service = "worker-registry"
            args.registry_namespace = "wrong-namespace"
            with self.assertRaisesRegex(RuntimeError, "port-forward exited"):
                with RUN.reachable_registry(args):
                    self.fail("unready forward was accepted")

    def test_cli_rejects_two_registry_owners(self):
        result = subprocess.run([
            sys.executable, str(ROOT / "run.py"), "--endpoint", "http://unused/v1",
            "--registry-endpoint", "http://unused", "--registry-service", "worker-registry",
            "--hub-kubeconfig", "fixture", "--cell", "a", "--cell", "b",
            "--receipt", "/data/tmp/unused-router-receipt.json",
        ], capture_output=True, text=True, timeout=5)
        self.assertEqual(result.returncode, 2)
        self.assertIn("not allowed with argument", result.stderr)


if __name__ == "__main__":
    unittest.main()
