import argparse
import importlib.util
import json
import pathlib
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


PATH = pathlib.Path(__file__).with_name("cleanup.py")
SPEC = importlib.util.spec_from_file_location("shared_agent_cleanup", PATH)
cleanup = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(cleanup)


class Handler(BaseHTTPRequestHandler):
    deleted = set()
    failures = 2
    lock = threading.Lock()

    def do_DELETE(self):
        with self.lock:
            if type(self).failures:
                type(self).failures -= 1
                self.send_response(503)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(b'{"error":{"code":"capacity_pending"}}')
                return
            type(self).deleted.add(self.path)
        self.send_response(204)
        self.end_headers()

    def log_message(self, *_):
        pass


class CleanupTests(unittest.TestCase):
    def authority(self, root, run_id="a" * 32, count=5, workers=2):
        run = root / "run"
        run.mkdir()
        (run / "config.json").write_text(json.dumps({"runId": run_id, "workers": workers}))
        (run / "receipt.json").write_text(json.dumps({
            "schema": cleanup.LOAD_SCHEMA, "runId": run_id, "target": count,
            "counters": {"scheduled": count, "objectsCreated": count},
        }))
        return run / "receipt.json"

    def args(self, root, endpoint):
        return argparse.Namespace(
            endpoint=endpoint, root=None, receipt=[self.authority(root)],
            manifest=root / "cleanup.sqlite", output=root / "receipt.json",
            concurrency=4, batch_size=3, rate=0, retries=3,
            retry_base_seconds=0.001, timeout_seconds=2,
        )

    def test_exact_resumable_cleanup(self):
        Handler.deleted = set()
        Handler.failures = 2
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
                root = pathlib.Path(temporary)
                args = self.args(root, "http://127.0.0.1:{}/v1".format(server.server_port))
                authorities = cleanup.discover(args)
                db = cleanup.connect(args.manifest)
                cleanup.initialize(db, args, authorities)
                completed = cleanup.cleanup(db, args)
                receipt = cleanup.write_receipt(db, args, completed)
                db.close()
                self.assertEqual(receipt["verdict"], "passed")
                self.assertEqual(receipt["objects"]["deleted"], 5)
                self.assertEqual(receipt["retries"], 2)
                self.assertEqual(len(Handler.deleted), 5)
                worker, object_id = cleanup.identity("a" * 32, 0, 2)
                self.assertIn("/v1/workers/{}/objects/Agent/{}".format(worker, object_id), Handler.deleted)
        finally:
            server.shutdown()
            server.server_close()

    def test_changed_receipt_authority_is_rejected(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = pathlib.Path(temporary)
            args = self.args(root, "http://127.0.0.1:1/v1")
            authority = cleanup.discover(args)
            db = cleanup.connect(args.manifest)
            cleanup.initialize(db, args, authority)
            args.receipt[0].write_text(json.dumps({
                "schema": cleanup.LOAD_SCHEMA, "runId": "a" * 32, "target": 6,
                "counters": {"scheduled": 6, "objectsCreated": 6},
            }))
            with self.assertRaises(ValueError):
                cleanup.initialize(db, args, cleanup.discover(args))
            db.close()

    def test_agent_upload_identity_is_discovered_without_guessing_objects(self):
        with tempfile.TemporaryDirectory(dir="/data/tmp") as temporary:
            root = pathlib.Path(temporary)
            run = root / "upload"
            run.mkdir()
            run_id = "b" * 32
            (run / "config.json").write_text(json.dumps({"runId": run_id, "count": 3}))
            receipt = run / "receipt.json"
            receipt.write_text(json.dumps({
                "schema": cleanup.AGENT_UPLOAD_SCHEMA, "runId": run_id, "target": 3,
                "counters": {"scheduled": 3, "agentsReady": 1},
            }))
            args = argparse.Namespace(root=None, receipt=[receipt])
            authority = cleanup.discover(args)
            self.assertEqual(authority[0]["kind"], "agent-upload")
            self.assertEqual(authority[0]["workers"], 0)
            worker, object_id = cleanup.identity(run_id, 2, 0, "agent-upload")
            self.assertEqual(worker, "soak-{}-2".format(run_id))
            self.assertEqual(len(object_id), 64)


if __name__ == "__main__":
    unittest.main()
