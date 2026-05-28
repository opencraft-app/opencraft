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
TENANT_ID="${TENANT_ID:-tenant-live}"
PROJECT_ID="${PROJECT_ID:-project-live}"
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

if [ ! -f "$COSCMD_CONFIG" ]; then
  printf 'missing COSCMD_CONFIG file: %s\n' "$COSCMD_CONFIG" >&2
  exit 2
fi

require_cmd "$COSCMD_BIN"

WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/agent-sidecar-e2e.XXXXXX")"
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
  printf '[e2e] %s\n' "$*"
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

json_payload() {
  local output="$1"
  local prompt="$2"
  PROMPT="$prompt" python3 - "$output" <<'PY'
import json
import os
import sys
payload = {
    "model": os.environ.get("REQUEST_MODEL", "agent-sidecar-e2e"),
    "stream": True,
    "input": os.environ["PROMPT"],
}
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False)
PY
}

json_file_payload() {
  local output="$1"
  local file_id="$2"
  local prompt="$3"
  FILE_ID="$file_id" PROMPT="$prompt" python3 - "$output" <<'PY'
import json
import os
import sys
payload = {
    "model": os.environ.get("REQUEST_MODEL", "agent-sidecar-e2e-file"),
    "stream": True,
    "input": [
        {"type": "input_text", "text": os.environ["PROMPT"]},
        {"type": "input_file", "file_id": os.environ["FILE_ID"]},
    ],
}
with open(sys.argv[1], "w", encoding="utf-8") as f:
    json.dump(payload, f, ensure_ascii=False)
PY
}

parse_sse() {
  python3 - "$1" <<'PY'
import json
import sys

text = ""
response_id = ""
artifact_ids = []
errors = []
for line in open(sys.argv[1], encoding="utf-8"):
    line = line.rstrip("\n")
    if not line.startswith("data: "):
        continue
    payload = json.loads(line[6:])
    typ = payload.get("type")
    if typ == "error":
        errors.append(payload.get("error", {}).get("message", "unknown error"))
    elif typ == "response.output_text.done":
        text = payload.get("text", "")
    elif typ == "response.completed":
        response_id = payload.get("response_id", "")
        artifact_ids = payload.get("artifact_file_ids", [])
if errors:
    raise SystemExit("sse error: " + "; ".join(errors))
if not response_id:
    raise SystemExit("missing response.completed")
print(json.dumps({"response_id": response_id, "artifact_ids": artifact_ids, "text": text}, ensure_ascii=False))
PY
}

post_response() {
  local payload="$1"
  local out="$2"
  local metrics="$3"
  curl -sS -N -X POST "http://127.0.0.1:${PORT}/v1/responses" \
    -H 'Content-Type: application/json' \
    -H "X-Tenant-ID: ${TENANT_ID}" \
    -H "X-Project-ID: ${PROJECT_ID}" \
    --data-binary @"$payload" \
    -o "$out" \
    -w 'http_code=%{http_code}\ntime_total=%{time_total}\n' >"$metrics"
  grep -q '^http_code=200$' "$metrics"
}

download_first_artifact() {
  local parsed="$1"
  local out="$2"
  local artifact_id
  artifact_id="$(PARSED="$parsed" python3 - <<'PY'
import json, os
ids = json.loads(os.environ["PARSED"]).get("artifact_ids", [])
if not ids:
    raise SystemExit("missing artifact file id")
print(ids[0])
PY
)"
  curl -sS "http://127.0.0.1:${PORT}/v1/files/${artifact_id}/content" \
    -H "X-Tenant-ID: ${TENANT_ID}" \
    -H "X-Project-ID: ${PROJECT_ID}" \
    -o "$out"
  test -s "$out"
}

assert_log_since() {
  local start_line="$1"
  local pattern="$2"
  awk -v start="$start_line" -v pattern="$pattern" '
    NR >= start && index($0, pattern) { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$SERVER_LOG"
}

assert_log_since_not() {
  local start_line="$1"
  local pattern="$2"
  if awk -v start="$start_line" -v pattern="$pattern" '
    NR >= start && index($0, pattern) { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$SERVER_LOG"; then
    printf 'unexpected log pattern after line %s: %s\n' "$start_line" "$pattern" >&2
    exit 1
  fi
}

assert_log_since_inner_sandbox_id() {
  local start_line="$1"
  awk -v start="$start_line" '
    NR >= start && index($0, "inner_sandbox_id=\"") && !index($0, "inner_sandbox_id=\"\"") { found = 1 }
    END { exit found ? 0 : 1 }
  ' "$SERVER_LOG"
}

log "build server and CloudAgent sidecar"
make cloudagent-sidecar-linux server
make test

SIDECAR_SHA="$(shasum -a 256 dist/cloudagent-sidecar-linux-amd64 | awk '{print $1}')"
SIDECAR_OBJECT="${COS_OBJECT_PREFIX%/}/cloudagent-sidecar-linux-amd64-${SIDECAR_SHA:0:12}"
PUBLIC_URL_FILE="$WORK_DIR/sidecar-url.clean"

COS_BUCKET="${COS_BUCKET:-$(awk -F '=' '/^[[:space:]]*bucket[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$COSCMD_CONFIG")}"
COS_REGION="${COS_REGION:-$(awk -F '=' '/^[[:space:]]*region[[:space:]]*=/{gsub(/^[[:space:]]+|[[:space:]]+$/, "", $2); print $2; exit}' "$COSCMD_CONFIG")}"
if [ -z "$COS_BUCKET" ] || [ -z "$COS_REGION" ]; then
  printf 'missing COS bucket/region in env or COSCMD_CONFIG\n' >&2
  exit 2
fi
PUBLIC_BASE_URL="${COS_PUBLIC_BASE_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com}"
PUBLIC_URL="${PUBLIC_BASE_URL%/}/${SIDECAR_OBJECT#/}"

log "upload CloudAgent sidecar to COS object=${SIDECAR_OBJECT}"
"$COSCMD_BIN" -c "$COSCMD_CONFIG" upload -f -y dist/cloudagent-sidecar-linux-amd64 "$SIDECAR_OBJECT"
"$COSCMD_BIN" -c "$COSCMD_CONFIG" putobjectacl "$SIDECAR_OBJECT" --grant-read anyone
printf '%s\n' "$PUBLIC_URL" >"$PUBLIC_URL_FILE"
curl -fsSI --connect-timeout 10 --max-time 30 "$PUBLIC_URL" >/dev/null

log "build and upload sandbox-host"
SANDBOX_HOST_URL="$("$ROOT_DIR/../sandbox-host/scripts/publish_sandbox_host.sh")"
SANDBOX_HOST_SHA256="$(tr -d '\r' <"${SANDBOX_HOST_SHA256_FILE:-/tmp/sandbox-host-sha256.clean}")"

PORT="$(pick_port)"
log "start wrapper on 127.0.0.1:${PORT}"
GATEWAY_WORKER_MODE=agent_injected \
GATEWAY_ADDR="127.0.0.1:${PORT}" \
GATEWAY_DATA_DIR="$SERVER_DATA" \
E2B_DOMAIN="$AGS_DOMAIN" \
E2B_API_KEY="$E2B_API_KEY" \
GATEWAY_AGS_TEMPLATE="$OUTER_TEMPLATE" \
INNER_SANDBOX_TEMPLATE="$INNER_TEMPLATE" \
TOKENHUB_API_KEY="$TOKENHUB_API_KEY" \
TOKENHUB_MODEL="$TOKENHUB_MODEL" \
GATEWAY_AGS_REQUEST_TIMEOUT_SECONDS=300 \
GATEWAY_AGENT_SIDECAR_BINARY="$ROOT_DIR/dist/cloudagent-sidecar-linux-amd64" \
GATEWAY_AGENT_SIDECAR_URL="$(cat "$PUBLIC_URL_FILE")" \
GATEWAY_AGENT_SIDECAR_SHA256="$SIDECAR_SHA" \
GATEWAY_SANDBOX_HOST_URL="$SANDBOX_HOST_URL" \
GATEWAY_SANDBOX_HOST_SHA256="$SANDBOX_HOST_SHA256" \
./dist/gateway-server >"$SERVER_LOG" 2>&1 &
SERVER_PID="$!"

for _ in $(seq 1 50); do
  if grep -q "gateway.listening" "$SERVER_LOG"; then
    break
  fi
  sleep 0.1
done
grep -q "gateway.listening" "$SERVER_LOG"

log "test 1/4: missing artifact download must fail, not return empty 200"
missing_download_start="$(($(wc -l <"$SERVER_LOG") + 1))"
missing_body="$WORK_DIR/missing-download.json"
missing_code="$(curl -sS "http://127.0.0.1:${PORT}/v1/files/file_missing_live_e2e/content" \
  -H "X-Tenant-ID: ${TENANT_ID}" \
  -H "X-Project-ID: ${PROJECT_ID}" \
  -o "$missing_body" \
  -w '%{http_code}')"
if [ "$missing_code" = "200" ]; then
  printf 'missing file download unexpectedly returned HTTP 200\n' >&2
  exit 1
fi
test -s "$missing_body"
grep -Eq 'file_not_found|not found' "$missing_body"
assert_log_since "$missing_download_start" "event=file_download_failed"

log "test 2/4: Chinese chat should not start inner sandbox"
chat_start="$(($(wc -l <"$SERVER_LOG") + 1))"
json_payload "$WORK_DIR/chat.json" "你是哪个模型？用一句话回答。"
post_response "$WORK_DIR/chat.json" "$WORK_DIR/chat.sse" "$WORK_DIR/chat.metrics"
CHAT_PARSED="$(parse_sse "$WORK_DIR/chat.sse")"
chat_download_start="$(($(wc -l <"$SERVER_LOG") + 1))"
download_first_artifact "$CHAT_PARSED" "$WORK_DIR/chat-artifact.txt"
assert_log_since "$chat_start" "event=response_completed"
assert_log_since "$chat_start" "inner_sandbox_id=\"\""
assert_log_since_not "$chat_start" "kind=tool_call"
assert_log_since_not "$chat_start" "runtime_event=inner_shutdown_done"
assert_log_since "$chat_download_start" "event=file_download_done"
assert_log_since "$chat_start" "event=sidecar_download_start"
assert_log_since "$chat_start" "event=sidecar_download_done"
log "chat metrics: $(tr '\n' ' ' <"$WORK_DIR/chat.metrics")"

log "test 3/4: terminal tool should execute inside Hermes workspace"
tool_start="$(($(wc -l <"$SERVER_LOG") + 1))"
json_payload "$WORK_DIR/tool.json" "请使用 terminal 工具执行：pwd && printf '你好！' > hello.txt && cat hello.txt。然后用简洁中文说明你做了什么。"
post_response "$WORK_DIR/tool.json" "$WORK_DIR/tool.sse" "$WORK_DIR/tool.metrics"
TOOL_PARSED="$(parse_sse "$WORK_DIR/tool.sse")"
tool_download_start="$(($(wc -l <"$SERVER_LOG") + 1))"
download_first_artifact "$TOOL_PARSED" "$WORK_DIR/tool-artifact.txt"
grep -q "你好！" "$WORK_DIR/tool-artifact.txt"
assert_log_since "$tool_start" "event=response_completed"
assert_log_since "$tool_start" "kind=tool_call"
assert_log_since "$tool_start" "kind=tool_call_update"
assert_log_since "$tool_start" "runtime_event=inner_shutdown_done"
assert_log_since_inner_sandbox_id "$tool_start"
assert_log_since "$tool_download_start" "event=file_download_done"
assert_log_since "$tool_start" "event=sidecar_download_start"
assert_log_since "$tool_start" "event=sidecar_download_done"
log "tool metrics: $(tr '\n' ' ' <"$WORK_DIR/tool.metrics")"

log "test 4/4: upload file, inspect via sandbox tool, and download artifact"
printf 'FILE_KIND_AGENT_SANDBOX_NOTE\nhello from uploaded file\n' >"$WORK_DIR/input-note.txt"
UPLOAD_JSON="$WORK_DIR/upload.json"
upload_start="$(($(wc -l <"$SERVER_LOG") + 1))"
curl -sS -X POST "http://127.0.0.1:${PORT}/v1/files" \
  -H "X-Tenant-ID: ${TENANT_ID}" \
  -H "X-Project-ID: ${PROJECT_ID}" \
  -F purpose=assistants \
  -F "file=@${WORK_DIR}/input-note.txt;filename=input-note.txt" \
  -o "$UPLOAD_JSON"
assert_log_since "$upload_start" "event=file_upload_done"
FILE_ID="$(python3 - "$UPLOAD_JSON" <<'PY'
import json, sys
print(json.load(open(sys.argv[1], encoding="utf-8"))["id"])
PY
)"
file_start="$(($(wc -l <"$SERVER_LOG") + 1))"
json_file_payload "$WORK_DIR/file.json" "$FILE_ID" "请读取上传文件，并说明这个文件是什么。"
post_response "$WORK_DIR/file.json" "$WORK_DIR/file.sse" "$WORK_DIR/file.metrics"
FILE_PARSED="$(parse_sse "$WORK_DIR/file.sse")"
file_download_start="$(($(wc -l <"$SERVER_LOG") + 1))"
download_first_artifact "$FILE_PARSED" "$WORK_DIR/file-artifact.txt"
grep -q "hello from uploaded file" "$WORK_DIR/file-artifact.txt"
assert_log_since "$file_start" "event=response_completed"
assert_log_since "$file_start" "event=stage_inputs_done"
assert_log_since "$file_start" "count=1"
assert_log_since "$file_start" "kind=tool_call"
assert_log_since "$file_start" "kind=tool_call_update"
assert_log_since "$file_start" "runtime_event=inner_shutdown_done"
assert_log_since_inner_sandbox_id "$file_start"
assert_log_since "$file_download_start" "event=file_download_done"
assert_log_since "$file_start" "event=sidecar_download_start"
assert_log_since "$file_start" "event=sidecar_download_done"
log "file metrics: $(tr '\n' ' ' <"$WORK_DIR/file.metrics")"

cat <<EOF
[e2e] ok
[e2e] work_dir=$WORK_DIR
[e2e] sidecar_object=$SIDECAR_OBJECT
[e2e] sidecar_sha256=$SIDECAR_SHA
[e2e] sandbox_host_url=$SANDBOX_HOST_URL
[e2e] sandbox_host_sha256=$SANDBOX_HOST_SHA256
[e2e] server_log=$SERVER_LOG
EOF
