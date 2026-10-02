#!/usr/bin/env python3
"""Exercise actual HTTP/auth/wire boundaries without real credentials."""
import importlib.util
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import threading
import unittest

SPEC = importlib.util.spec_from_file_location("dsh_config_rpc", Path(__file__).parents[1] / "helpers/configure-deepseek-harness.py")
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class RpcBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.mode = "modern"
        self.auth = True
        self.denied = False
        self.invalid_id = False
        self.redirect = False
        outer = self

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                outer.calls.append(("GET", self.path, None))
                self.send_response(200)
                if not outer.denied:
                    self.send_header("Set-Cookie", "dsh-test=yes; Path=/; HttpOnly; SameSite=Strict")
                self.end_headers()
                self.wfile.write(b"<html>DSH</html>")

            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                outer.calls.append(("POST", self.path, body))
                if outer.redirect:
                    self.send_response(302)
                    self.send_header("Location", "http://127.0.0.1:1/never-send-credentials")
                    self.end_headers()
                    return
                if outer.auth and self.headers.get("Cookie") != "dsh-test=yes":
                    self.send_response(401)
                    self.end_headers()
                    return
                method = body["method"]
                payload = body["payload"]
                if outer.mode == "legacy":
                    if method == "llm.providers":
                        value = {"providers": [{"provider": "deepseek-official", "active": True}]}
                    else:
                        value = {"credentials": {ref: {"configured": True} for ref in payload["refs"]}}
                else:
                    if "." in method:
                        self.send_response(404)
                        self.end_headers()
                        return
                    if set(payload) != {"args"}:
                        self.send_response(400)
                        self.end_headers()
                        return
                    args = payload["args"]
                    if method == "llm/listConfigurableProviders":
                        value = [
                            {"provider": "deepseek-official", "displayName": "DeepSeek", "settingsNs": "deepseek", "settingsPath": []},
                            {"provider": "minimax-cn", "displayName": "MiniMax CN", "settingsNs": "pi-ai", "settingsPath": ["providers", "minimax-cn"]},
                        ]
                    elif method == "llm/listProviders":
                        value = [{"id": "deepseek-official"}]
                    elif method == "credentials/describe":
                        value = {ref: {"configured": True, "writable": True} for ref in args["refs"]}
                    elif method == "settings/describe":
                        value = {"writable": True, "namespaces": [{"ns": "deepseek", "value": {}, "revision": 1}, {"ns": "pi-ai", "value": {"providers": {}}, "revision": 7}]}
                    else:
                        value = None
                envelope = {"type": "server-response", "rpcId": "wrong" if outer.invalid_id else body["rpcId"], "result": {"ok": True, "value": value}}
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.end_headers()
                self.wfile.write(json.dumps(envelope).encode())

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.client = MODULE.RpcClient(f"http://127.0.0.1:{self.server.server_port}")

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()

    def test_modern_auth_and_provider_shapes(self):
        result = MODULE.list_providers("cn", self.client.call)
        self.assertEqual([row["id"] for row in result["providers"]], ["deepseek", "minimax-cn"])
        self.assertTrue(result["providers"][0]["configured"])
        self.assertTrue(result["providers"][0]["active"])
        self.assertFalse(result["providers"][1]["active"])
        self.assertEqual(sum(method == "GET" for method, _, _ in self.calls), 1)
        self.assertFalse(any(method == "GET" and path != "/" for method, path, _ in self.calls))

    def test_legacy_runtime_still_works_without_browser_auth(self):
        self.mode = "legacy"
        self.auth = False
        result = self.client.call("llm.providers", {})
        self.assertTrue(result["providers"][0]["active"])
        self.assertFalse(any(method == "GET" for method, _, _ in self.calls))
        self.assertEqual(self.client.call("credentials.describe", {"refs": ["TEST_API_KEY"]}), {"credentials": {"TEST_API_KEY": {"configured": True}}})

    def test_modern_save_and_remove_are_not_replayed(self):
        MODULE.configure_provider("minimax-cn", "fixture-key", self.client.call)
        MODULE.remove_provider("deepseek", self.client.call)
        writes = [(path, body["payload"]) for method, path, body in self.calls if method == "POST" and path in ("/api/settings/mutate", "/api/credentials/set", "/api/credentials/unset")]
        self.assertEqual(writes, [
            ("/api/settings/mutate", {"args": {"ns": "pi-ai", "ops": [{"op": "set", "path": ["providers", "minimax-cn", "apiKeyEnv"], "value": "MINIMAX_CN_API_KEY"}], "expectedRevision": 7}}),
            ("/api/credentials/set", {"args": {"ref": "MINIMAX_CN_API_KEY", "value": "fixture-key"}}),
            ("/api/credentials/unset", {"args": {"ref": "DEEPSEEK_API_KEY"}}),
        ])

    def test_authentication_failure_is_bounded_and_actionable(self):
        self.denied = True
        with self.assertRaisesRegex(RuntimeError, "authentication"):
            self.client.call("llm.providers", {})
        self.assertEqual(len(self.calls), 2)

    def test_response_id_is_validated(self):
        self.invalid_id = True
        with self.assertRaisesRegex(RuntimeError, "invalid DSH RPC response"):
            self.client.call("llm.providers", {})

    def test_redirects_are_not_followed(self):
        self.redirect = True
        with self.assertRaisesRegex(RuntimeError, "HTTP 302"):
            self.client.call("credentials.set", {"ref": "TEST_API_KEY", "value": "fixture-key"})
        self.assertEqual(len(self.calls), 1)


if __name__ == "__main__":
    unittest.main()
