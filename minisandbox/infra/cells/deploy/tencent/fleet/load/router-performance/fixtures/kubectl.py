#!/usr/bin/env python3
"""Run a real Registry HTTP server and expose deterministic Cell inventory."""

import http.server
import json
import sys


args = sys.argv[1:]
if len(args) == 7 and args[0] == "--kubeconfig" and args[2:] == [
    "get", "rivetcells", "-A", "-o", "json"
]:
    print(json.dumps({"items": [
        {"metadata": {"name": name}, "status": {
            "readyForPlacement": True, "spokeCellRef": {"uid": "uid-" + name}
        }} for name in ("a", "b")
    ]}))
elif len(args) == 7 and args[0] == "--kubeconfig" and args[2:6] == [
    "-n", "worker-registry-system", "port-forward", "service/worker-registry"
]:
    local, remote = args[6].split(":")
    if remote != "8080":
        raise SystemExit("unexpected Registry port")

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = b'{"ready":true}'
            self.send_response(200 if self.path == "/readyz" else 404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *unused):
            pass

    http.server.ThreadingHTTPServer(("127.0.0.1", int(local)), Handler).serve_forever()
else:
    raise SystemExit("unexpected kubectl contract")
