#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import pathlib
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


ROOT = pathlib.Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("verify_registry_contract", ROOT / "verify-registry-contract.py")
assert spec and spec.loader
MODULE = importlib.util.module_from_spec(spec)
spec.loader.exec_module(MODULE)


class Handler(BaseHTTPRequestHandler):
    status = 200
    body: dict | bytes = {
        "schema": MODULE.SCHEMA,
        "namespace": "default",
        "cursor": "c_0123456789abcdef0123456789abcdef",
    }

    def do_GET(self):
        encoded = self.body if isinstance(self.body, bytes) else json.dumps(self.body).encode()
        self.send_response(self.status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(encoded)))
        self.end_headers()
        self.wfile.write(encoded)

    def log_message(self, *_args):
        pass


class RegistryContractTests(unittest.TestCase):
    def setUp(self):
        Handler.status = 200
        Handler.body = {
            "schema": MODULE.SCHEMA,
            "namespace": "default",
            "cursor": "c_0123456789abcdef0123456789abcdef",
        }
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.endpoint = f"http://127.0.0.1:{self.server.server_port}"

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_accepts_exact_cursor_contract(self):
        result = MODULE.verify(self.endpoint, "default", 2)
        self.assertEqual(result["schema"], MODULE.SCHEMA)

    def test_rejects_old_registry_route(self):
        Handler.status = 404
        Handler.body = b"404 page not found\n"
        with self.assertRaisesRegex(ValueError, "HTTP 404"):
            MODULE.verify(self.endpoint, "default", 2)

    def test_rejects_wrong_schema(self):
        Handler.body = {**Handler.body, "schema": "rivet-worker-deployment-cursor/v0"}
        with self.assertRaisesRegex(ValueError, "violates the serving contract"):
            MODULE.verify(self.endpoint, "default", 2)

    def test_allows_forward_compatible_extra_fields(self):
        Handler.body = {**Handler.body, "extension": {"revision": 2}}
        result = MODULE.verify(self.endpoint, "default", 2)
        self.assertEqual(result["namespace"], "default")

    def test_rejects_endpoint_with_credentials_or_path(self):
        for endpoint in ("http://user:pass@127.0.0.1", self.endpoint + "/v1"):
            with self.subTest(endpoint=endpoint), self.assertRaisesRegex(ValueError, "credential-free"):
                MODULE.verify(endpoint, "default", 2)


if __name__ == "__main__":
    unittest.main()
