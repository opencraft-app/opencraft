#!/usr/bin/env python3
"""Exercise real kubectl DELETE requests against a bounded API protocol double."""

import http.server
import importlib.util
import json
import pathlib
import shutil
import tempfile
import threading
import unittest
import urllib.parse


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("qualification_pod_lifecycle", ROOT / "pod_lifecycle.py")
assert spec and spec.loader
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)
runtime_spec = importlib.util.spec_from_file_location(
    "persistent_runtime_e2e", ROOT.parents[6] / "infra/cells/deploy/local/mesh/workerd-persistent-code-e2e/run.py",
)
assert runtime_spec and runtime_spec.loader
runtime = importlib.util.module_from_spec(runtime_spec)
runtime_spec.loader.exec_module(runtime)


class DeleteAPI(http.server.BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_DELETE(self):
        self.connection.settimeout(2)
        if self.headers.get("Transfer-Encoding") == "chunked":
            chunks = []
            total = 0
            while True:
                size = int(self.rfile.readline(32).split(b";", 1)[0].strip(), 16)
                if size == 0:
                    self.rfile.readline(32)
                    break
                total += size
                if total > 8192:
                    self.send_error(413)
                    return
                chunks.append(self.rfile.read(size))
                if self.rfile.read(2) != b"\r\n":
                    self.send_error(400)
                    return
            body = b"".join(chunks)
        else:
            size = int(self.headers.get("Content-Length", "0"))
            if not 0 <= size <= 8192:
                self.send_error(413)
                return
            body = self.rfile.read(size)
        options = json.loads(body or b"{}")
        path = urllib.parse.urlsplit(self.path).path
        self.server.requests.append({"path": path, "options": options})
        uid = options.get("preconditions", {}).get("uid")
        if path != "/api/v1/namespaces/test/pods/same-name":
            self.send_error(404)
            return
        if uid is not None and uid != self.server.current_uid:
            status = 409
            payload = {"apiVersion": "v1", "kind": "Status", "status": "Failure",
                       "reason": "Conflict", "message": "UID precondition mismatch", "code": 409}
        else:
            status = 200
            self.server.deleted = True
            payload = {"apiVersion": "v1", "kind": "Pod", "metadata": {
                "namespace": "test", "name": "same-name",
                "uid": self.server.ack_uid or self.server.current_uid,
            }}
        data = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


@unittest.skipUnless(shutil.which("kubectl"), "real kubectl is required for this protocol gate")
class PodLifecycleTests(unittest.TestCase):
    def setUp(self):
        self.server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), DeleteAPI)
        self.server.requests = []
        self.server.current_uid = "uid-old"
        self.server.ack_uid = None
        self.server.deleted = False
        self.thread = threading.Thread(
            target=self.server.serve_forever, kwargs={"poll_interval": 0.01}, daemon=True,
        )
        self.thread.start()
        self.addCleanup(self.stop_server)
        self.temp = tempfile.TemporaryDirectory(dir="/data/tmp")
        self.addCleanup(self.temp.cleanup)
        self.config = pathlib.Path(self.temp.name) / "loopback.kubeconfig"
        self.config.write_text(json.dumps({
            "apiVersion": "v1", "kind": "Config", "current-context": "loopback",
            "clusters": [{"name": "loopback", "cluster": {
                "server": f"http://127.0.0.1:{self.server.server_port}",
            }}],
            "contexts": [{"name": "loopback", "context": {"cluster": "loopback", "user": "loopback"}}],
            "users": [{"name": "loopback", "user": {}}],
        }))
        self.client = runtime.Kubectl(self.config, "test")
        self.pod = {"metadata": {"namespace": "test", "name": "same-name", "uid": "uid-old"}}

    def stop_server(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=2)

    def test_real_kubectl_uses_uid_and_preserves_default_grace(self):
        MODULE.delete_exact_pod(self.client, self.pod)
        self.assertTrue(self.server.deleted)
        self.assertEqual(self.server.requests, [{
            "path": "/api/v1/namespaces/test/pods/same-name",
            "options": {"apiVersion": "v1", "kind": "DeleteOptions", "preconditions": {"uid": "uid-old"}},
        }])

    def test_unfenced_counterexample_and_replacement_uid_conflict(self):
        self.server.current_uid = "uid-new"
        options = pathlib.Path(self.temp.name) / "unfenced.json"
        options.write_text(json.dumps({"apiVersion": "v1", "kind": "DeleteOptions"}))
        self.client.run("delete", "--raw", "/api/v1/namespaces/test/pods/same-name", "-f", str(options))
        self.assertTrue(self.server.deleted, "unfenced deletion removed the replacement")
        self.server.deleted = False
        self.server.requests.clear()
        with self.assertRaisesRegex(RuntimeError, "Conflict|precondition"):
            MODULE.delete_exact_pod(self.client, self.pod)
        self.assertFalse(self.server.deleted)
        self.assertEqual(len(self.server.requests), 1)
        self.assertEqual(self.server.requests[0]["options"]["preconditions"], {"uid": "uid-old"})

    def test_invalid_identity_never_sends_delete(self):
        for field, value in (("uid", ""), ("name", "../other"), ("namespace", "other")):
            with self.subTest(field=field):
                changed = {"metadata": dict(self.pod["metadata"], **{field: value})}
                with self.assertRaisesRegex(ValueError, "exact namespace"):
                    MODULE.delete_exact_pod(self.client, changed)
        self.assertEqual(self.server.requests, [])
        self.assertFalse(self.server.deleted)

    def test_wrong_acknowledgement_stops_without_repeat(self):
        self.server.ack_uid = "unexpected-uid"
        with self.assertRaisesRegex(RuntimeError, "exact selected Pod UID"):
            MODULE.delete_exact_pod(self.client, self.pod)
        self.assertTrue(self.server.deleted)
        self.assertEqual(len(self.server.requests), 1)


if __name__ == "__main__":
    unittest.main()
