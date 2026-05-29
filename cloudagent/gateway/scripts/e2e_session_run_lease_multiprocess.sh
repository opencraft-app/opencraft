#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

API_KEY="${GATEWAY_API_KEY:-session-run-lease-e2e}"
ALLOW_KNOWN_BUG="${CLOUDAGENT_ALLOW_SESSION_RUN_LEASE_BUG:-${CLOUDAGENT_ALLOW_WORKSPACE_LEASE_BUG:-0}}"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/session-run-lease-multiprocess-e2e.XXXXXX")"
DATA_DIR="$WORK_DIR/data"
LOG_A="$WORK_DIR/gateway-a.log"
LOG_B="$WORK_DIR/gateway-b.log"
PID_A=""
PID_B=""
PORT_A=""
PORT_B=""

log() {
  printf '[session-run-lease-e2e] %s\n' "$*"
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

dump_logs() {
  log "work_dir=$WORK_DIR"
  if [ -f "$LOG_A" ]; then
    log "gateway A log tail"
    tail -n 120 "$LOG_A" >&2 || true
  fi
  if [ -f "$LOG_B" ]; then
    log "gateway B log tail"
    tail -n 120 "$LOG_B" >&2 || true
  fi
}

stop_pid() {
  local pid="$1"
  if [ -n "$pid" ]; then
    kill "$pid" >/dev/null 2>&1 || true
    wait "$pid" >/dev/null 2>&1 || true
  fi
}

cleanup() {
  stop_pid "$PID_A"
  stop_pid "$PID_B"
  if [ "${KEEP_SESSION_RUN_LEASE_E2E_DIR:-${KEEP_WORKSPACE_LEASE_E2E_DIR:-0}}" != "1" ]; then
    rm -rf "$WORK_DIR"
  else
    log "kept work_dir=$WORK_DIR"
  fi
}
trap cleanup EXIT

wait_health() {
  local port="$1"
  local name="$2"
  local deadline=$((SECONDS + 20))
  while [ "$SECONDS" -lt "$deadline" ]; do
    if curl -fsS "http://127.0.0.1:${port}/healthz" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.2
  done
  log "$name did not become healthy on port $port"
  dump_logs
  return 1
}

start_gateway_a() {
  PORT_A="${PORT_A:-$(pick_port)}"
  log "starting gateway A port=$PORT_A data_dir=$DATA_DIR"
  GATEWAY_WORKER_MODE=fake \
    GATEWAY_ADDR="127.0.0.1:${PORT_A}" \
    GATEWAY_DATA_DIR="$DATA_DIR" \
    GATEWAY_API_KEY="$API_KEY" \
    GATEWAY_ACP_RUNTIME_REFRESH_IDLE_SECONDS=1 \
    GATEWAY_ACP_RUNTIME_REFRESH_TIMEOUT_SECONDS=2 \
    GATEWAY_FAKE_RUNTIME_ENSURE_DELAY_MS="${GATEWAY_FAKE_RUNTIME_ENSURE_DELAY_MS:-1000}" \
    ./dist/gateway-server >"$LOG_A" 2>&1 &
  PID_A="$!"
  wait_health "$PORT_A" "gateway A"
}

start_gateway_b() {
  PORT_B="${PORT_B:-$(pick_port)}"
  log "starting gateway B port=$PORT_B data_dir=$DATA_DIR"
  GATEWAY_WORKER_MODE=fake \
    GATEWAY_ADDR="127.0.0.1:${PORT_B}" \
    GATEWAY_DATA_DIR="$DATA_DIR" \
    GATEWAY_API_KEY="$API_KEY" \
    GATEWAY_ACP_RUNTIME_REFRESH_IDLE_SECONDS=1 \
    GATEWAY_ACP_RUNTIME_REFRESH_TIMEOUT_SECONDS=2 \
    GATEWAY_FAKE_RUNTIME_ENSURE_DELAY_MS="${GATEWAY_FAKE_RUNTIME_ENSURE_DELAY_MS:-1000}" \
    ./dist/gateway-server >"$LOG_B" 2>&1 &
  PID_B="$!"
  wait_health "$PORT_B" "gateway B"
}

tool() {
  go run ./internal/tools/workspace_lease_repro "$@"
}

log "building gateway-server"
make server >/dev/null

mkdir -p "$DATA_DIR"
start_gateway_a
start_gateway_b

SESSION_ID="$(tool -mode create-session -acp-url "http://127.0.0.1:${PORT_A}" -api-key "$API_KEY")"
log "created session on gateway A session_id=$SESSION_ID"

tool -mode list-session -acp-url "http://127.0.0.1:${PORT_B}" -api-key "$API_KEY" -session-id "$SESSION_ID" >/dev/null
log "gateway B can see session from shared sqlite store"

log "restarting gateway A so seeded lease/history are reloaded from disk"
stop_pid "$PID_A"
PID_A=""
tool -mode seed-lease -data-dir "$DATA_DIR" -session-id "$SESSION_ID" -ttl 2s
start_gateway_a

sleep 1
tool -mode prompt -acp-url "http://127.0.0.1:${PORT_A}" -api-key "$API_KEY" -session-id "$SESSION_ID" >/dev/null
log "prompt completed after idle refresh"

sleep 1.3
set +e
ASSERT_OUTPUT="$(tool -mode assert-held -data-dir "$DATA_DIR" -session-id "$SESSION_ID" 2>&1)"
ASSERT_STATUS=$?
set -e

if [ "$ASSERT_STATUS" -ne 0 ]; then
  printf '%s\n' "$ASSERT_OUTPUT" >&2
  if [ "$ALLOW_KNOWN_BUG" = "1" ]; then
    log "known bug reproduced: runtime refresh did not renew session run lease"
    exit 0
  fi
  dump_logs
  exit "$ASSERT_STATUS"
fi

printf '%s\n' "$ASSERT_OUTPUT"
log "session run lease remained held after runtime refresh"

CLOSE_SESSION_ID="$(tool -mode create-session -acp-url "http://127.0.0.1:${PORT_A}" -api-key "$API_KEY")"
log "created close-release session on gateway A session_id=$CLOSE_SESSION_ID"
tool -mode seed-lease -data-dir "$DATA_DIR" -session-id "$CLOSE_SESSION_ID" -ttl 60s >/dev/null
tool -mode close-session -acp-url "http://127.0.0.1:${PORT_B}" -api-key "$API_KEY" -session-id "$CLOSE_SESSION_ID" >/dev/null
tool -mode assert-stealable -data-dir "$DATA_DIR" -session-id "$CLOSE_SESSION_ID" >/dev/null
log "session close released session run lease"

DISCONNECT_SESSION_ID="$(tool -mode create-session -acp-url "http://127.0.0.1:${PORT_A}" -api-key "$API_KEY")"
log "created disconnect session on gateway A session_id=$DISCONNECT_SESSION_ID"
tool -mode seed-lease -data-dir "$DATA_DIR" -session-id "$DISCONNECT_SESSION_ID" -ttl 60s >/dev/null
tool -mode load-disconnect -acp-url "http://127.0.0.1:${PORT_B}" -api-key "$API_KEY" -session-id "$DISCONNECT_SESSION_ID" >/dev/null
tool -mode assert-held -data-dir "$DATA_DIR" -session-id "$DISCONNECT_SESSION_ID" >/dev/null
log "websocket load/disconnect did not release session run lease"

ENSURE_SESSION_ID="$(tool -mode create-session -acp-url "http://127.0.0.1:${PORT_A}" -api-key "$API_KEY")"
log "created concurrent ensure_ready session on gateway A session_id=$ENSURE_SESSION_ID"
tool -mode seed-lease -data-dir "$DATA_DIR" -session-id "$ENSURE_SESSION_ID" -ttl 60s >/dev/null
log "restarting both gateways so concurrent ensure_ready reads seeded lease state"
stop_pid "$PID_A"
stop_pid "$PID_B"
PID_A=""
PID_B=""
start_gateway_a
start_gateway_b
tool -mode concurrent-ensure-ready \
  -acp-url "http://127.0.0.1:${PORT_A}" \
  -acp-url-b "http://127.0.0.1:${PORT_B}" \
  -api-key "$API_KEY" \
  -session-id "$ENSURE_SESSION_ID" >/dev/null
log "concurrent ensure_ready admitted a single session run owner"
