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

wait_gateway_listening() {
  local start_line="$1"
  for _ in $(seq 1 80); do
    if awk -v start="$start_line" -v old_pattern="listening on 127.0.0.1:${PORT}" -v addr="127.0.0.1:${PORT}" '
      NR >= start && index($0, old_pattern) { found = 1 }
      NR >= start && index($0, "gateway.listening") && index($0, addr) { found = 1 }
      END { exit found ? 0 : 1 }
    ' "$SERVER_LOG"; then
      return 0
    fi
    sleep 0.1
  done
  printf 'gateway did not start on 127.0.0.1:%s\n' "$PORT" >&2
  tail -n 200 "$SERVER_LOG" >&2 || true
  exit 1
}

start_gateway() {
  local start_line
  start_line="$(($(wc -l <"$SERVER_LOG" 2>/dev/null || echo 0) + 1))"
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
  ./dist/gateway-server >>"$SERVER_LOG" 2>&1 &
  SERVER_PID="$!"
  wait_gateway_listening "$start_line"
}

stop_gateway() {
  if [ -n "$SERVER_PID" ]; then
    kill "$SERVER_PID" >/dev/null 2>&1 || true
    wait "$SERVER_PID" >/dev/null 2>&1 || true
    SERVER_PID=""
  fi
}

log "build server and CloudAgent sidecar"
make cloudagent-sidecar-linux server test

SIDECAR_SHA="$(shasum -a 256 dist/cloudagent-sidecar-linux-amd64 | awk '{print $1}')"
SIDECAR_OBJECT="${COS_OBJECT_PREFIX%/}/cloudagent-sidecar-linux-amd64-${SIDECAR_SHA:0:12}"

COS_BUCKET="${COS_BUCKET:-$(awk -F '=' '/^[[:space:]]*bucket[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$COSCMD_CONFIG")}"
COS_REGION="${COS_REGION:-$(awk -F '=' '/^[[:space:]]*region[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$COSCMD_CONFIG")}"
if [ -z "$COS_BUCKET" ] || [ -z "$COS_REGION" ]; then
  printf 'missing COS bucket/region in env or COSCMD_CONFIG\n' >&2
  exit 2
fi
PUBLIC_BASE_URL="${COS_PUBLIC_BASE_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com}"
PUBLIC_URL="${PUBLIC_BASE_URL%/}/${SIDECAR_OBJECT#/}"

log "upload CloudAgent sidecar to COS object=${SIDECAR_OBJECT}"
"$COSCMD_BIN" -c "$COSCMD_CONFIG" upload -f -y dist/cloudagent-sidecar-linux-amd64 "$SIDECAR_OBJECT" >/dev/null
"$COSCMD_BIN" -c "$COSCMD_CONFIG" putobjectacl "$SIDECAR_OBJECT" --grant-read anyone >/dev/null
curl -fsSI --connect-timeout 10 --max-time 30 "$PUBLIC_URL" >/dev/null

PORT="$(pick_port)"
log "start wrapper on 127.0.0.1:${PORT}"
: >"$SERVER_LOG"
start_gateway

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
send(sock, {"jsonrpc": "2.0", "method": "session/cancel", "params": {"sessionId": session_id}})
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
rpc(9, "session/delete", {"sessionId": session_id})

restore_session_id = rpc(10, "session/new", {"cwd": "/workspace"})["sessionId"]
restore_marker = "cloudagent-restart-restore-" + restore_session_id.replace("_", "-")
rpc(11, "session/prompt", {
    "sessionId": restore_session_id,
    "prompt": [{"type": "text", "text": "这是重启恢复前的准备消息。请只用一句话回答：准备完成。为了恢复校验，这条用户消息包含唯一标记 " + restore_marker + "。"}],
})
before_close_status = rpc(12, "_cloudagent.session.status", {"session_id": restore_session_id})
before_close_sandbox = before_close_status.get("sandbox", {})
old_outer_sandbox_id = before_close_sandbox.get("outer_sandbox_id") or ""
old_wisp_space_id = before_close_sandbox.get("wisp_smh_space_id") or ""
if not old_outer_sandbox_id:
    raise RuntimeError(f"restore source session has no outer sandbox: {before_close_status}")
if not old_wisp_space_id:
    raise RuntimeError(f"restore source session has no workspace/SMH space: {before_close_status}")
if not before_close_status.get("workspace_persistent") or not before_close_status.get("runtime_restorable"):
    raise RuntimeError(f"restore source session is not workspace-persistent/restorable: {before_close_status}")
rpc(13, "session/close", {"sessionId": restore_session_id})
after_close_status = rpc(14, "_cloudagent.session.status", {"session_id": restore_session_id})
after_close_sandbox = after_close_status.get("sandbox", {})
if not after_close_status.get("closed") or not after_close_status.get("runtime_restorable"):
    raise RuntimeError(f"closed restore session is not restorable: {after_close_status}")
if not after_close_status.get("workspace_persistent"):
    raise RuntimeError(f"closed restore session lost workspace persistence: {after_close_status}")
if after_close_sandbox.get("outer_sandbox_id"):
    raise RuntimeError(f"closed restore session still has outer sandbox id: {after_close_status}")
if after_close_sandbox.get("wisp_smh_space_id") != old_wisp_space_id:
    raise RuntimeError(f"closed restore session changed workspace id: before={old_wisp_space_id} after={after_close_sandbox.get('wisp_smh_space_id')}")

with open(out_path, "w", encoding="utf-8") as f:
    json.dump({
        "session_id": session_id,
        "restore_session_id": restore_session_id,
        "restore_marker": restore_marker,
        "old_outer_sandbox_id": old_outer_sandbox_id,
        "old_wisp_space_id": old_wisp_space_id,
        "before_close_status": before_close_status,
        "after_close_status": after_close_status,
        "responses": responses,
        "updates": updates,
    }, f, ensure_ascii=False, indent=2)
print(json.dumps({"session_id": session_id, "restore_session_id": restore_session_id, "old_outer_sandbox_id": old_outer_sandbox_id, "old_wisp_space_id": old_wisp_space_id, "updates": len(updates)}, ensure_ascii=False))
PY

SESSION_ID="$(python3 - "$WORK_DIR/acp.json" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["restore_session_id"])
PY
)"

log "restart wrapper and load persisted session session_id=${SESSION_ID}"
stop_gateway
start_gateway

python3 - "$PORT" "$API_KEY" "$WORK_DIR/acp-restore.json" "$SESSION_ID" "$WORK_DIR/acp.json" <<'PY'
import base64
import json
import os
import socket
import struct
import sys
import time

port = int(sys.argv[1])
api_key = sys.argv[2]
out_path = sys.argv[3]
session_id = sys.argv[4]
source_path = sys.argv[5]
with open(source_path, encoding="utf-8") as f:
    source = json.load(f)
old_outer_sandbox_id = source["old_outer_sandbox_id"]
old_wisp_space_id = source["old_wisp_space_id"]
restore_marker = source["restore_marker"]

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
    deadline = time.time() + timeout
    while time.time() < deadline:
        msg = read_frame(sock)
        if msg.get("method") == "session/update":
            updates.append(msg)
            continue
        if msg.get("id") == target:
            if "error" in msg:
                raise RuntimeError(f"rpc {target} failed: {msg}")
            return msg["result"]
        if "id" in msg:
            responses[msg["id"]] = msg
    raise RuntimeError(f"timeout waiting for id {target}")

def rpc(id, method, params=None):
    send(sock, {"jsonrpc": "2.0", "id": id, "method": method, "params": params or {}})
    result = wait_id(id)
    responses[id] = result
    return result

def streamed_text():
    parts = []
    for msg in updates:
        update = msg.get("params", {}).get("update", {})
        if update.get("sessionUpdate") != "agent_message_chunk":
            continue
        content = update.get("content")
        if isinstance(content, dict) and isinstance(content.get("text"), str):
            parts.append(content["text"])
    return "".join(parts)

rpc(1, "initialize", {})
loaded = rpc(2, "session/load", {"sessionId": session_id, "cwd": "/workspace"})
loaded_cloud = (loaded.get("_meta") or {}).get("cloudagent") or {}
if "sessionId" in loaded or "readOnly" in loaded or "readOnlyReason" in loaded:
    raise RuntimeError(f"session/load returned non-standard root fields: {loaded}")
if loaded_cloud.get("read_only"):
    raise RuntimeError(f"unexpected load result after restart: {loaded}")
after_load_status = rpc(3, "_cloudagent.session.status", {"session_id": session_id})
after_load_sandbox = after_load_status.get("sandbox", {})
if after_load_status.get("read_only"):
    raise RuntimeError(f"loaded restorable session should not be read-only: {after_load_status}")
if not after_load_status.get("workspace_persistent") or not after_load_status.get("runtime_restorable"):
    raise RuntimeError(f"loaded session lost workspace persistence/restorability: {after_load_status}")
if after_load_sandbox.get("outer_sandbox_id"):
    raise RuntimeError(f"session/load should not eagerly recreate outer sandbox: {after_load_status}")
if after_load_sandbox.get("wisp_smh_space_id") != old_wisp_space_id:
    raise RuntimeError(f"loaded session changed workspace id: before={old_wisp_space_id} after={after_load_sandbox.get('wisp_smh_space_id')}")
prompt = rpc(4, "session/prompt", {
    "sessionId": session_id,
    "prompt": [{"type": "text", "text": "请查看本对话历史，复制其中以 cloudagent-restart-restore- 开头的唯一标记。不要解释，只输出标记本身。"}],
})
if prompt.get("stopReason") not in (None, "", "end_turn", "stop"):
    raise RuntimeError(f"unexpected prompt result after restore: {prompt}")
if restore_marker not in streamed_text():
    raise RuntimeError(f"restored prompt did not recover runtime transcript marker: want={restore_marker} got={streamed_text()!r}")
after_prompt_status = rpc(5, "_cloudagent.session.status", {"session_id": session_id})
after_prompt_sandbox = after_prompt_status.get("sandbox", {})
new_outer_sandbox_id = after_prompt_sandbox.get("outer_sandbox_id") or ""
if after_prompt_status.get("closed") or after_prompt_status.get("read_only"):
    raise RuntimeError(f"prompt-restored session is not writable: {after_prompt_status}")
if not new_outer_sandbox_id:
    raise RuntimeError(f"prompt-restored session has no new outer sandbox: {after_prompt_status}")
if new_outer_sandbox_id == old_outer_sandbox_id:
    raise RuntimeError(f"prompt restore reused destroyed outer sandbox: old={old_outer_sandbox_id} new={new_outer_sandbox_id}")
if after_prompt_sandbox.get("wisp_smh_space_id") != old_wisp_space_id:
    raise RuntimeError(f"prompt restore changed workspace id: before={old_wisp_space_id} after={after_prompt_sandbox.get('wisp_smh_space_id')}")
rpc(6, "session/delete", {"sessionId": session_id})

with open(out_path, "w", encoding="utf-8") as f:
    json.dump({
        "session_id": session_id,
        "old_outer_sandbox_id": old_outer_sandbox_id,
        "new_outer_sandbox_id": new_outer_sandbox_id,
        "old_wisp_space_id": old_wisp_space_id,
        "restore_marker": restore_marker,
        "after_load_status": after_load_status,
        "after_prompt_status": after_prompt_status,
        "responses": responses,
        "updates": updates,
        "load": loaded,
        "prompt": prompt,
    }, f, ensure_ascii=False, indent=2)
print(json.dumps({"session_id": session_id, "old_outer_sandbox_id": old_outer_sandbox_id, "new_outer_sandbox_id": new_outer_sandbox_id, "old_wisp_space_id": old_wisp_space_id, "updates": len(updates)}, ensure_ascii=False))
PY

require_log() {
  local pattern="$1"
  if ! grep -q "$pattern" "$SERVER_LOG"; then
    printf 'missing log pattern: %s\n' "$pattern" >&2
    tail -n 200 "$SERVER_LOG" >&2
    exit 1
  fi
}

require_log_regex() {
  local pattern="$1"
  if ! grep -Eq "$pattern" "$SERVER_LOG"; then
    printf 'missing log regex: %s\n' "$pattern" >&2
    tail -n 200 "$SERVER_LOG" >&2
    exit 1
  fi
}

require_log 'event=acp_runtime_outer_create_done'
require_log 'event=acp_runtime_daemon_done'
require_log 'event=acp_runtime_prompt_done'
require_log 'event=acp_runtime_cleanup_start reason=closed'
require_log 'event=acp_runtime_cleanup_done reason=closed'
require_log 'event=acp_runtime_restore_outer_create_done'
require_log 'event=acp_runtime_restore_wisp_prepare_done'
require_log 'event=acp_runtime_restore_daemon_done'
require_log 'event=acp_runtime_wisp_stop_start'
require_log_regex 'event=acp_runtime_wisp_stop_(done|failed)'
require_log 'workspace_runtime_shutdown_done'
require_log_regex 'event=session_history_seed_done .*seeded=\\"2\\"'
if grep -q 'event=acp_session_persist_failed' "$SERVER_LOG"; then
  printf 'session persistence failed during restore e2e\n' >&2
  tail -n 240 "$SERVER_LOG" >&2
  exit 1
fi
if ! grep -Eq 'inner_sandbox_id=[^[:space:]]+' "$SERVER_LOG"; then
  printf 'expected at least one prompt to report a non-empty inner_sandbox_id\n' >&2
  tail -n 240 "$SERVER_LOG" >&2
  exit 1
fi

outer_count="$(grep -c 'event=acp_runtime_outer_create_done' "$SERVER_LOG")"
if [ "$outer_count" -lt 2 ]; then
  printf 'expected at least two outer create events: lifecycle session + persisted restore session, got %s\n' "$outer_count" >&2
  tail -n 200 "$SERVER_LOG" >&2
  exit 1
fi

log "server_log=$SERVER_LOG"
log "artifact=$WORK_DIR/acp.json"
log "restore_artifact=$WORK_DIR/acp-restore.json"
