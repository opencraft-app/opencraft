#!/usr/bin/env bash
set -euo pipefail

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
temporary=$(mktemp -d)
server_pid=
cleanup(){
	if [[ -n ${server_pid:-} ]]; then kill "$server_pid" 2>/dev/null || true; wait "$server_pid" 2>/dev/null || true; fi
	rm -rf -- "$temporary"
}
trap cleanup EXIT INT TERM

cat >"$temporary/server.py" <<'PY'
import json
import re
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from socketserver import ThreadingMixIn
from urllib.parse import urlsplit

objects = {}
lock = threading.Lock()

class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def send(self, status, payload=None):
        body = b"" if payload is None else json.dumps(payload).encode()
        self.send_response(status)
        if body:
            self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self):
        path = urlsplit(self.path).path
        if re.fullmatch(r"/v1/workers/[^/]+/versions", path):
            self.send(201, {"id": "v-" + "a" * 32})
            return
        if re.fullmatch(r"/v1/workers/[^/]+/deployments", path):
            self.send(201, {"id": "d-" + "b" * 32})
            return
        match = re.fullmatch(r"/v1/workers/([^/]+)/objects/Agent/([0-9a-f]{64})/fetch", path)
        if match:
            key = match.groups()
            route = urlsplit(self.headers.get("X-Workers-Original-URL", "")).path
            with lock:
                if key not in objects:
                    self.send(404, {"error": "missing"})
                    return
                if route == "/increment":
                    objects[key] += 1
                count = objects[key]
            self.send(200, {"ready": True, "count": count})
            return
        self.send(404, {"error": "unexpected POST", "path": path})

    def do_PUT(self):
        match = re.fullmatch(r"/v1/workers/([^/]+)/objects/Agent/([0-9a-f]{64})", urlsplit(self.path).path)
        if not match:
            self.send(404, {"error": "unexpected PUT"})
            return
        with lock:
            objects.setdefault(match.groups(), 0)
        self.send(200, {"object": "object", "id": match.group(2)})

    def do_DELETE(self):
        path = urlsplit(self.path).path
        match = re.fullmatch(r"/v1/workers/([^/]+)/objects/Agent/([0-9a-f]{64})", path)
        if match:
            with lock:
                objects.pop(match.groups(), None)
            self.send(204)
            return
        match = re.fullmatch(r"/v1/workers/([^/]+)", path)
        if match:
            with lock:
                still_live = any(worker == match.group(1) for worker, _ in objects)
            self.send(409 if still_live else 204, {"error": "objects remain"} if still_live else None)
            return
        self.send(404, {"error": "unexpected DELETE"})

class ThreadingHTTPServer(ThreadingMixIn, HTTPServer):
    daemon_threads = True

server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
open(sys.argv[1], "w").write(str(server.server_port))
server.serve_forever()
PY
python3 "$temporary/server.py" "$temporary/port" &
server_pid=$!
for _ in $(seq 1 100); do [[ -s $temporary/port ]] && break; sleep 0.02; done
[[ -s $temporary/port ]]
port=$(<"$temporary/port")

TMPDIR=$temporary \
WORKERS_URL=http://127.0.0.1:$port \
RUN_ID=public-api-test \
REQUEST_COUNT=20 \
REQUEST_CONCURRENCY=2 \
REQUEST_INTERVAL_SECONDS=0 \
REQUEST_TIMEOUT_SECONDS=2 \
	"$script_dir/engine-ha-probe.sh" >"$temporary/result.json"

python3 - "$temporary/result.json" <<'PY'
import json
import sys

payload = None
for line in reversed(open(sys.argv[1]).read().splitlines()):
    try:
        candidate = json.loads(line)
    except json.JSONDecodeError:
        continue
    if candidate.get("verdict"):
        payload = candidate
        break
assert payload is not None
assert payload["verdict"] == "passed", payload
assert payload["public_api"] == "/v1", payload
assert payload["object_count"] == 2, payload
assert payload["requests"] == 20, payload
assert payload["failures"] == 0, payload
assert payload["traffic_started_at_ms"] < payload["traffic_finished_at_ms"], payload
assert payload["post_failure_write_count"] == 1, payload
assert payload["cleanup"] == "passed", payload
assert payload["worker"] == "q01-engine-ha-gate", payload
assert payload["worker_fixture_retained"] is True, payload
print("Engine HA public /v1 probe test: pass")
PY
