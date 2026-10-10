#!/usr/bin/env python3
"""Local HTTP protocol double for the real PortForward subprocess lifecycle."""

import http.server
import json
import sys


def main():
    args = sys.argv[1:]
    if len(args) != 7 or args[0] != "--kubeconfig" or args[2:6] != [
        "-n", "worker-registry-system", "port-forward", "service/worker-registry"
    ]:
        raise SystemExit("unexpected Registry port-forward contract")
    local, remote = args[6].split(":")
    if remote != "8080":
        raise SystemExit("unexpected Registry service port")

    class Handler(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            body = json.dumps({"kubeconfig": args[1], "namespace": args[3], "service": args[5]}).encode()
            self.send_response(200 if self.path == "/readyz" else 404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *unused):
            pass

    http.server.ThreadingHTTPServer(("127.0.0.1", int(local)), Handler).serve_forever()


if __name__ == "__main__":
    main()
