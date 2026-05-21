#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

# shellcheck disable=SC1091
. "$ROOT_DIR/scripts/lib/load_env.sh"
load_cloudagent_env "$ROOT_DIR"

COSCMD_BIN="${COSCMD_BIN:-coscmd}"
COSCMD_CONFIG="${COSCMD_CONFIG:-/tmp/cos-agent-sidecar.conf}"
COS_OBJECT_PREFIX="${COS_OBJECT_PREFIX:-/agent-sidecar/$(date +%Y%m%d)}"
OUTER_TEMPLATE="${OUTER_SANDBOX_TEMPLATE:-${GATEWAY_AGS_TEMPLATE:-sdt-90h9gdig}}"
INNER_TEMPLATE="${INNER_SANDBOX_TEMPLATE:-$OUTER_TEMPLATE}"
AGS_DOMAIN="${GATEWAY_AGS_DOMAIN:-${E2B_DOMAIN:-ap-beijing.tencentags.com}}"
TOKENHUB_MODEL="${TOKENHUB_MODEL:-minimax-m2.7}"
API_KEY="${GATEWAY_API_KEY:-acp-session-runtime-smoke}"
KEEP_SERVER="${KEEP_SERVER:-0}"

require_env() {
  local name="$1"
  if [ -z "${!name:-}" ]; then
    printf 'missing required env: %s\n' "$name" >&2
    exit 2
  fi
}

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    printf 'missing required command: %s\n' "$1" >&2
    exit 2
  fi
}

require_env E2B_API_KEY
require_env TOKENHUB_API_KEY
require_cmd curl
require_cmd python3
require_cmd shasum
require_cmd make
require_cmd "$COSCMD_BIN"

if [ ! -f "$COSCMD_CONFIG" ]; then
  printf 'missing COSCMD_CONFIG file: %s\n' "$COSCMD_CONFIG" >&2
  exit 2
fi

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/acp-session-runtime-e2e.XXXXXX")"
SERVER_LOG="$WORK_DIR/server.log"
SERVER_DATA="$WORK_DIR/data"
SERVER_PID=""

cleanup() {
  if [ -n "$SERVER_PID" ] && [ "$KEEP_SERVER" != "1" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

log() {
  printf '[acp-e2e] %s\n' "$*"
}

pick_port() {
  python3 - <<'PY'
import socket
s = socket.socket()
s.bind(("127.0.0.1", 0))
print(s.getsockname()[1])
s.close()
PY
}

log "build server and Hermes sidecar"
make hermes-sidecar-linux server test

SIDECAR_SHA="$(shasum -a 256 dist/hermes-sidecar-linux-amd64 | awk '{print $1}')"
SIDECAR_OBJECT="${COS_OBJECT_PREFIX%/}/hermes-sidecar-linux-amd64-${SIDECAR_SHA:0:12}"

COS_BUCKET="${COS_BUCKET:-$(awk -F '=' '/^[[:space:]]*bucket[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$COSCMD_CONFIG")}"
COS_REGION="${COS_REGION:-$(awk -F '=' '/^[[:space:]]*region[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$COSCMD_CONFIG")}"
if [ -z "$COS_BUCKET" ] || [ -z "$COS_REGION" ]; then
  printf 'missing COS bucket/region in env or COSCMD_CONFIG\n' >&2
  exit 2
fi
PUBLIC_BASE_URL="${COS_PUBLIC_BASE_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com}"
PUBLIC_URL="${PUBLIC_BASE_URL%/}/${SIDECAR_OBJECT#/}"

log "upload Hermes sidecar to COS object=${SIDECAR_OBJECT}"
"$COSCMD_BIN" -c "$COSCMD_CONFIG" upload -f -y dist/hermes-sidecar-linux-amd64 "$SIDECAR_OBJECT" >/dev/null
"$COSCMD_BIN" -c "$COSCMD_CONFIG" putobjectacl "$SIDECAR_OBJECT" --grant-read anyone >/dev/null
curl -fsSI --connect-timeout 10 --max-time 30 "$PUBLIC_URL" >/dev/null

PORT="$(pick_port)"
log "start wrapper on 127.0.0.1:${PORT}"
GATEWAY_WORKER_MODE=agent_injected \
GATEWAY_ADDR="127.0.0.1:${PORT}" \
GATEWAY_DATA_DIR="$SERVER_DATA" \
GATEWAY_API_KEY="$API_KEY" \
E2B_DOMAIN="$AGS_DOMAIN" \
E2B_API_KEY="$E2B_API_KEY" \
GATEWAY_AGS_TEMPLATE="$OUTER_TEMPLATE" \
INNER_SANDBOX_TEMPLATE="$INNER_TEMPLATE" \
TOKENHUB_API_KEY="$TOKENHUB_API_KEY" \
TOKENHUB_MODEL="$TOKENHUB_MODEL" \
GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS=300 \
GATEWAY_AGENT_SIDECAR_URL="$PUBLIC_URL" \
GATEWAY_AGENT_SIDECAR_SHA256="$SIDECAR_SHA" \
./dist/gateway-server >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 80); do
  if grep -q "listening on 127.0.0.1:${PORT}" "$SERVER_LOG"; then
    break
  fi
  sleep 0.1
done
grep -q "listening on 127.0.0.1:${PORT}" "$SERVER_LOG"

log "drive ACP websocket lifecycle"
python3 - "$PORT" "$API_KEY" "$WORK_DIR/acp.json" <<'PY'
import base64
import hashlib
import json
import os
import socket
import struct
import sys
import time

port = int(sys.argv[1])
api_key = sys.argv[2]
out_path = sys.argv[3]

def frame(payload):
    data = json.dumps(payload, ensure_ascii=False).encode()
    mask = os.urandom(4)
    header = bytearray([0x81])
    size = len(data)
    if size < 126:
        header.append(0x80 | size)
    elif size < 65536:
        header.extend([0x80 | 126, size >> 8, size & 0xff])
    else:
        header.append(0x80 | 127)
        header.extend(struct.pack(">Q", size))
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    return bytes(header) + mask + masked

def read_frame(sock):
    first = sock.recv(2)
    if len(first) != 2:
        raise RuntimeError("websocket closed")
    opcode = first[0] & 0x0f
    size = first[1] & 0x7f
    if size == 126:
        size = struct.unpack(">H", sock.recv(2))[0]
    elif size == 127:
        size = struct.unpack(">Q", sock.recv(8))[0]
    payload = b""
    while len(payload) < size:
        chunk = sock.recv(size - len(payload))
        if not chunk:
            raise RuntimeError("websocket closed mid-frame")
        payload += chunk
    if opcode == 8:
        raise RuntimeError("websocket closed")
    return json.loads(payload.decode())

def send(sock, payload):
    sock.sendall(frame(payload))

key = base64.b64encode(os.urandom(16)).decode()
sock = socket.create_connection(("127.0.0.1", port), timeout=10)
request = (
    "GET /acp HTTP/1.1\r\n"
    f"Host: 127.0.0.1:{port}\r\n"
    "Upgrade: websocket\r\n"
    "Connection: Upgrade\r\n"
    f"Sec-WebSocket-Key: {key}\r\n"
    "Sec-WebSocket-Version: 13\r\n"
    f"Authorization: Bearer {api_key}\r\n"
    "\r\n"
)
sock.sendall(request.encode())
response = sock.recv(4096)
if b"101 Switching Protocols" not in response:
    raise SystemExit(response.decode(errors="replace"))
sock.settimeout(420)

responses = {}
updates = []

def wait_id(target, timeout=420):
    if target in responses:
        return responses[target]
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = read_frame(sock)
        if msg.get("method") == "session/update":
            updates.append(msg)
            continue
        if msg.get("id") == target:
            return msg
        if "id" in msg:
            responses[msg["id"]] = msg
    raise RuntimeError(f"timeout waiting for id {target}")

def rpc(id, method, params=None):
    send(sock, {"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}})
    msg = wait_id(id)
    responses[id] = msg
    if "error" in msg:
        raise RuntimeError(f"{method} failed: {msg}")
    return msg["result"]

rpc(1, "initialize", {})
session_id = rpc(2, "session/new", {"cwd": "/workspace"})["sessionId"]
send(sock, {
    "jsonrpc": "2.0",
    "id": 3,
    "method": "session/prompt",
    "params": {
        "sessionId": session_id,
        "prompt": [{"type": "text", "text": "必须使用 terminal 工具执行 `sleep 20 && echo cancelled-too-late`，不要解释，等命令完成后只输出命令结果。"}],
    },
})
time.sleep(1)
rpc(4, "session/cancel", {"sessionId": session_id})
cancelled_prompt = wait_id(3)
responses[3] = cancelled_prompt
if cancelled_prompt.get("result", {}).get("stopReason") != "cancelled":
    raise RuntimeError(f"expected prompt 3 to be cancelled, got {cancelled_prompt}")
rpc(5, "session/resume", {"sessionId": session_id})
rpc(6, "session/prompt", {
    "sessionId": session_id,
    "prompt": [{"type": "text", "text": "你好，用一句话回答 1+1 等于几。"}],
})
rpc(7, "session/prompt", {
    "sessionId": session_id,
    "prompt": [{"type": "text", "text": "必须使用 terminal 工具执行 `pwd && ls / | head -20 && ps -ef | head -10`，然后用一句话概括你看到的根目录和进程信息。"}],
})
rpc(8, "session/close", {"sessionId": session_id})
try:
    rpc(9, "session/prompt", {
        "sessionId": session_id,
        "prompt": [{"type": "text", "text": "should fail"}],
    })
    raise RuntimeError("prompt after close unexpectedly succeeded")
except RuntimeError as exc:
    if "session/prompt failed" not in str(exc):
        raise
rpc(10, "session/resume", {"sessionId": session_id})
rpc(11, "session/delete", {"sessionId": session_id})

with open(out_path, "w", encoding="utf-8") as f:
    json.dump({"session_id": session_id, "responses": responses, "updates": updates}, f, ensure_ascii=False, indent=2)
print(json.dumps({"session_id": session_id, "updates": len(updates)}, ensure_ascii=False))
PY

require_log() {
  local pattern="$1"
  if ! grep -q "$pattern" "$SERVER_LOG"; then
    printf 'missing log pattern: %s\n' "$pattern" >&2
    tail -n 200 "$SERVER_LOG" >&2
    exit 1
  fi
}

require_log 'event=acp_runtime_outer_create_done'
require_log 'event=acp_runtime_daemon_done'
require_log 'event=acp_runtime_prompt_done'
require_log 'event=acp_runtime_close_start'
require_log 'event=acp_runtime_cancel_start'
require_log 'event=acp_runtime_cancel_done'
if ! grep -Eq 'inner_sandbox_id=[^[:space:]]+' "$SERVER_LOG"; then
  printf 'expected at least one prompt to report a non-empty inner_sandbox_id\n' >&2
  tail -n 240 "$SERVER_LOG" >&2
  exit 1
fi

outer_count="$(grep -c 'event=acp_runtime_outer_create_done' "$SERVER_LOG")"
if [ "$outer_count" -lt 3 ]; then
  printf 'expected at least three outer create events: new + cancel-resume + close-resume, got %s\n' "$outer_count" >&2
  tail -n 200 "$SERVER_LOG" >&2
  exit 1
fi

log "server_log=$SERVER_LOG"
log "artifact=$WORK_DIR/acp.json"
