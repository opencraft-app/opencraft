import argparse
import base64
import hashlib
import importlib.util
import json
import pathlib
import sys
import threading
import unittest
from unittest import mock
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


MODULE_PATH = pathlib.Path(__file__).with_name("qualify_fdb_footprint.py")
SPEC = importlib.util.spec_from_file_location("qualify_fdb_footprint", MODULE_PATH)
assert SPEC is not None and SPEC.loader is not None
footprint = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = footprint
SPEC.loader.exec_module(footprint)


def key(value):
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def page_hash(rows):
    digest = hashlib.sha256()
    for raw_key, raw_value in rows:
        digest.update(len(raw_key).to_bytes(8, "big"))
        digest.update(raw_key)
        digest.update(len(raw_value).to_bytes(8, "big"))
        digest.update(raw_value)
    return digest.hexdigest()


class FootprintHandler(BaseHTTPRequestHandler):
    rows = {
        "application": [(b"a", b"1"), (b"b", b"22"), (b"c", b"333")],
        "depot": [(b"a", b"1"), (b"b", b"22")],
        "gasoline": [(b"c", b"333")],
    }
    moving = False
    calls = 0

    def do_GET(self):
        parsed = footprint.urllib.parse.urlparse(self.path)
        query = footprint.urllib.parse.parse_qs(parsed.query)
        scope = query["scope"][0]
        limit = int(query["limit"][0])
        start_after = query.get("start_after", [None])[0]
        values = list(type(self).rows[scope])
        if type(self).moving and scope == "application" and type(self).calls >= 1:
            values[-1] = (b"c", b"changed-same-pass")
        type(self).calls += 1
        if start_after is not None:
            raw_cursor = footprint.decode_key(start_after)
            values = [row for row in values if row[0] > raw_cursor]
        selected = values[:limit]
        has_more = len(values) > limit
        first = key(selected[0][0]) if selected else None
        last = key(selected[-1][0]) if selected else None
        response = {
            "node_id": "node-a",
            "generated_at_ms": 1,
            "scope": scope,
            "row_count": len(selected),
            "key_bytes": sum(len(row[0]) for row in selected),
            "value_bytes": sum(len(row[1]) for row in selected),
            "raw_bytes": sum(len(row[0]) + len(row[1]) for row in selected),
            "page_sha256": page_hash(selected),
            "first_key": first,
            "last_key": last,
            "next_cursor": last if has_more else None,
        }
        encoded = json.dumps(response).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_):
        pass


class FootprintQualificationTests(unittest.TestCase):
    def setUp(self):
        FootprintHandler.moving = False
        FootprintHandler.calls = 0
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), FootprintHandler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)

    def args(self):
        return argparse.Namespace(
            api_url="http://127.0.0.1:{}".format(self.server.server_port),
            scope=None,
            passes=2,
            limit=2,
            pause_seconds=0,
            request_timeout_seconds=5,
            auth_token_env=None,
            engine_bin=None,
            config=None,
            baseline=None,
            actor_count=None,
            cell_id=None,
        )

    def test_two_passes_count_disjoint_scopes_and_match_digest(self):
        result = footprint.run_qualification(self.args())

        self.assertEqual(result["verdict"], "passed")
        self.assertEqual(result["stable"]["application"]["keys"], 3)
        self.assertEqual(result["stable"]["depot"]["raw_bytes"], 5)
        self.assertEqual(result["stable"]["gasoline"]["raw_bytes"], 4)
        self.assertEqual(len(result["scopes"]["application"]), 2)
        self.assertEqual(result["scopes"]["application"][0]["pages"], 2)

    def test_moving_keyspace_fails_closed(self):
        FootprintHandler.moving = True
        args = self.args()
        args.scope = ["application"]
        args.limit = 10

        with self.assertRaisesRegex(RuntimeError, "changed between passes"):
            footprint.run_qualification(args)

    def test_invalid_or_nonqualifying_bounds_are_rejected(self):
        args = self.args()
        args.passes = 1
        with self.assertRaisesRegex(ValueError, "at least 2"):
            footprint.run_qualification(args)
        args.passes = 2
        args.limit = 1001
        with self.assertRaisesRegex(ValueError, "between 1 and 1000"):
            footprint.run_qualification(args)

    def test_baseline_delta_reports_per_actor_and_rejects_shrink(self):
        import tempfile

        stable = {
            "application": {
                "keys": 30,
                "key_bytes": 40,
                "value_bytes": 60,
                "raw_bytes": 100,
            }
        }
        with tempfile.TemporaryDirectory() as directory:
            path = pathlib.Path(directory) / "baseline.json"
            path.write_text(
                json.dumps(
                    {
                        "verdict": "passed",
                        "stable": {
                            "application": {
                                "keys": 10,
                                "key_bytes": 20,
                                "value_bytes": 30,
                                "raw_bytes": 50,
                            }
                        },
                    }
                )
            )
            delta = footprint.baseline_delta(path, stable, 10)
            self.assertEqual(delta["scopes"]["application"]["delta"]["keys"], 20)
            self.assertEqual(
                delta["scopes"]["application"]["per_actor"]["raw_bytes"], 5
            )
            stable["application"]["keys"] = 9
            with self.assertRaisesRegex(RuntimeError, "shrank"):
                footprint.baseline_delta(path, stable, 10)

    def test_offline_gate_rejects_an_active_engine(self):
        import tempfile

        args = self.args()
        args.cell_id = "actor-bj-b01"
        args.engine_service = "actor-rivet-engine.service"
        with tempfile.TemporaryDirectory() as directory:
            args.execution_site_file = pathlib.Path(directory) / "cell-id"
            args.execution_site_file.write_text("actor-bj-b01\n")
            completed = footprint.subprocess.CompletedProcess(
                [], 0, stdout="active\n", stderr=""
            )
            with mock.patch.object(footprint.subprocess, "run", return_value=completed):
                with self.assertRaisesRegex(RuntimeError, "cleanly inactive"):
                    footprint.require_offline_engine(args)


if __name__ == "__main__":
    unittest.main()
