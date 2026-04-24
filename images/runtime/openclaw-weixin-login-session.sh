#!/usr/bin/env bash

set -euo pipefail

DEFAULT_STATE_DIR="/tmp/lightclaw-weixin-login"
DEFAULT_TIMEOUT_SECONDS=300
TAIL_MAX_BYTES=4096

SUBCOMMAND="${1:-}"
if [ $# -gt 0 ]; then
  shift
fi

STATE_DIR="${DEFAULT_STATE_DIR}"
SESSION_ID=""
TIMEOUT_SECONDS="${DEFAULT_TIMEOUT_SECONDS}"

usage() {
  cat <<'EOF'
Usage:
  openclaw-weixin-login-session <subcommand> [options]

Subcommands:
  start    Start a background weixin login worker
  status   Read structured session state
  cancel   Stop a running session worker
  gc       Remove expired session directories

Options:
  --session-id <id>         Session identifier
  --timeout-seconds <sec>   Session timeout in seconds (default: 300)
  --state-dir <dir>         State root directory (default: /tmp/lightclaw-weixin-login)
  -h, --help                Show help

Notes:
  All subcommands print a single-line JSON payload to stdout.
EOF
}

json_string() {
  python3 - <<'PY' "$1"
import json
import sys

print(json.dumps(sys.argv[1], ensure_ascii=False))
PY
}

utc_now_iso() {
  python3 - <<'PY'
from datetime import datetime, timezone

print(datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z"))
PY
}

compute_expires_at() {
  python3 - <<'PY' "$1"
from datetime import datetime, timedelta, timezone
import sys

timeout_seconds = int(sys.argv[1])
value = datetime.now(timezone.utc) + timedelta(seconds=timeout_seconds)
print(value.isoformat(timespec="seconds").replace("+00:00", "Z"))
PY
}

is_positive_int() {
  [[ "$1" =~ ^[0-9]+$ ]] && [ "$1" -gt 0 ]
}

session_dir() {
  printf '%s/%s' "${STATE_DIR}" "${SESSION_ID}"
}

state_file_path() {
  printf '%s/state.json' "$(session_dir)"
}

output_log_path() {
  printf '%s/output.log' "$(session_dir)"
}

worker_pid_path() {
  printf '%s/worker.pid' "$(session_dir)"
}

ensure_state_root() {
  mkdir -p "${STATE_DIR}"
}

parse_common_flags() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --session-id)
        SESSION_ID="${2:-}"
        shift 2
        ;;
      --timeout-seconds)
        TIMEOUT_SECONDS="${2:-}"
        shift 2
        ;;
      --state-dir)
        STATE_DIR="${2:-}"
        shift 2
        ;;
      -h|--help)
        usage
        exit 0
        ;;
      *)
        emit_error_json "invalid_argument" "unknown argument: $1" 2
        ;;
    esac
  done
}

require_session_id() {
  if [ -z "${SESSION_ID}" ]; then
    emit_error_json "invalid_argument" "--session-id is required" 2
  fi
}

require_timeout_seconds() {
  if ! is_positive_int "${TIMEOUT_SECONDS}"; then
    emit_error_json "invalid_argument" "--timeout-seconds must be a positive integer" 2
  fi
}

emit_json() {
  python3 - "$@" <<'PY'
import json
import sys

payload = {}
for item in sys.argv[1:]:
    key, value = item.split('=', 1)
    payload[key] = json.loads(value)
print(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
PY
}

emit_error_json() {
  local error_code="$1"
  local error_message="$2"
  local exit_code="${3:-1}"
  emit_json \
    "ok=false" \
    "session_id=$(json_string "${SESSION_ID}")" \
    "status=$(json_string "")" \
    "error=$(json_string "${error_message}")" \
    "error_code=$(json_string "${error_code}")"
  exit "${exit_code}"
}

emit_session_json_from_state() {
  local state_file="$1"
  if [ ! -f "${state_file}" ]; then
    emit_error_json "session_not_found" "session state not found" 1
  fi
  python3 - "$state_file" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as f:
    payload = json.load(f)
print(json.dumps(payload, ensure_ascii=False, separators=(',', ':')))
PY
}

write_state() {
  local state_file="$1"
  local tmp_file="${state_file}.tmp"
  shift
  emit_json "$@" >"${tmp_file}"
  mv -f "${tmp_file}" "${state_file}"
}

read_state_field() {
  local state_file="$1"
  local field="$2"
  python3 - "$state_file" "$field" <<'PY'
import json
import sys

with open(sys.argv[1], 'r', encoding='utf-8') as f:
    payload = json.load(f)
value = payload.get(sys.argv[2], '')
if value is None:
    value = ''
if isinstance(value, bool):
    print('true' if value else 'false')
else:
    print(value)
PY
}

session_is_active() {
  case "$1" in
    starting|waiting_qr)
      return 0
      ;;
    *)
      return 1
      ;;
  esac
}

process_exists() {
  local pid="$1"
  is_positive_int "${pid}" && kill -0 "${pid}" 2>/dev/null
}

kill_worker_pid() {
  local pid="$1"
  if ! process_exists "${pid}"; then
    return 0
  fi
  kill "${pid}" 2>/dev/null || true
  for _ in 1 2 3 4 5; do
    if ! process_exists "${pid}"; then
      return 0
    fi
    sleep 1
  done
  kill -9 "${pid}" 2>/dev/null || true
  ! process_exists "${pid}"
}

preflight_plugin_state() {
  local plugin_list plugin_enabled
  if ! command -v openclaw >/dev/null 2>&1; then
    printf 'command_start_failed\nopenclaw binary not found\n'
    return 1
  fi
  plugin_list="$(openclaw plugins list 2>&1 || true)"
  if echo "${plugin_list}" | grep -qi 'failed to load'; then
    printf 'command_start_failed\n%s\n' "${plugin_list}"
    return 1
  fi
  if ! echo "${plugin_list}" | grep -Eqi 'weixin|openclaw-weixin'; then
    printf 'plugin_missing\nopenclaw-weixin plugin missing\n'
    return 1
  fi
  plugin_enabled="$(openclaw config get plugins.entries.openclaw-weixin.enabled 2>/dev/null || true)"
  if ! echo "${plugin_enabled}" | grep -Eiq '^(true|1)$'; then
    printf 'plugin_disabled\nopenclaw-weixin plugin disabled\n'
    return 1
  fi
}

start_session() {
  require_session_id
  require_timeout_seconds
  ensure_state_root

  local session_path state_file output_log pid_file now expires_at
  session_path="$(session_dir)"
  state_file="$(state_file_path)"
  output_log="$(output_log_path)"
  pid_file="$(worker_pid_path)"
  now="$(utc_now_iso)"
  expires_at="$(compute_expires_at "${TIMEOUT_SECONDS}")"

  local preflight
  if ! preflight="$(preflight_plugin_state)"; then
    local error_code error_message
    error_code="$(printf '%s' "${preflight}" | sed -n '1p')"
    error_message="$(printf '%s' "${preflight}" | sed -n '2,$p')"
    emit_json \
      "ok=false" \
      "session_id=$(json_string "${SESSION_ID}")" \
      "status=$(json_string "failed")" \
      "error=$(json_string "${error_message}")" \
      "error_code=$(json_string "${error_code}")"
    return 0
  fi

  if [ -f "${state_file}" ]; then
    local existing_status existing_pid
    existing_status="$(read_state_field "${state_file}" status)"
    existing_pid="$(read_state_field "${state_file}" pid)"
    if session_is_active "${existing_status}"; then
      if process_exists "${existing_pid}"; then
        emit_json \
          "ok=false" \
          "session_id=$(json_string "${SESSION_ID}")" \
          "status=$(json_string "${existing_status}")" \
          "error=$(json_string "session already active")" \
          "error_code=$(json_string "session_conflict")" \
          "pid=$(json_string "${existing_pid}")"
        return 0
      fi
    fi
  fi

  rm -rf "${session_path}"
  mkdir -p "${session_path}"
  : >"${output_log}"

  write_state "${state_file}" \
    "ok=true" \
    "session_id=$(json_string "${SESSION_ID}")" \
    "status=$(json_string "starting")" \
    "qr_url=$(json_string "")" \
    "qr_ascii=$(json_string "")" \
    "error=$(json_string "")" \
    "error_code=$(json_string "")" \
    "started_at=$(json_string "${now}")" \
    "updated_at=$(json_string "${now}")" \
    "expires_at=$(json_string "${expires_at}")" \
    "finished_at=null" \
    "pid=0" \
    "last_output_tail=$(json_string "")" \
    "state_dir=$(json_string "${session_path}")" \
    "state_file=$(json_string "${state_file}")"

  nohup "$0" __worker --session-id "${SESSION_ID}" --timeout-seconds "${TIMEOUT_SECONDS}" --state-dir "${STATE_DIR}" >/dev/null 2>&1 </dev/null &
  local pid=$!
  printf '%s\n' "${pid}" >"${pid_file}"

  write_state "${state_file}" \
    "ok=true" \
    "session_id=$(json_string "${SESSION_ID}")" \
    "status=$(json_string "starting")" \
    "qr_url=$(json_string "")" \
    "qr_ascii=$(json_string "")" \
    "error=$(json_string "")" \
    "error_code=$(json_string "")" \
    "started_at=$(json_string "${now}")" \
    "updated_at=$(json_string "${now}")" \
    "expires_at=$(json_string "${expires_at}")" \
    "finished_at=null" \
    "pid=${pid}" \
    "last_output_tail=$(json_string "")" \
    "state_dir=$(json_string "${session_path}")" \
    "state_file=$(json_string "${state_file}")"

  emit_json \
    "ok=true" \
    "session_id=$(json_string "${SESSION_ID}")" \
    "status=$(json_string "starting")" \
    "state_dir=$(json_string "${session_path}")" \
    "state_file=$(json_string "${state_file}")" \
    "pid=${pid}" \
    "started_at=$(json_string "${now}")" \
    "expires_at=$(json_string "${expires_at}")"
}

read_status() {
  require_session_id
  local state_file
  state_file="$(state_file_path)"
  if [ ! -f "${state_file}" ]; then
    emit_json \
      "ok=false" \
      "session_id=$(json_string "${SESSION_ID}")" \
      "status=$(json_string "")" \
      "error=$(json_string "session state not found")" \
      "error_code=$(json_string "session_not_found")"
    return 0
  fi
  emit_session_json_from_state "${state_file}"
}

cancel_session() {
  require_session_id
  local state_file pid_file now status qr_url qr_ascii started_at expires_at pid output_log last_output error_message error_code
  state_file="$(state_file_path)"
  pid_file="$(worker_pid_path)"
  output_log="$(output_log_path)"
  now="$(utc_now_iso)"

  if [ ! -f "${state_file}" ]; then
    emit_json \
      "ok=false" \
      "session_id=$(json_string "${SESSION_ID}")" \
      "status=$(json_string "")" \
      "error=$(json_string "session state not found")" \
      "error_code=$(json_string "session_not_found")"
    return 0
  fi

  status="$(read_state_field "${state_file}" status)"
  qr_url="$(read_state_field "${state_file}" qr_url)"
  qr_ascii="$(read_state_field "${state_file}" qr_ascii)"
  started_at="$(read_state_field "${state_file}" started_at)"
  expires_at="$(read_state_field "${state_file}" expires_at)"
  error_message="$(read_state_field "${state_file}" error)"
  error_code="$(read_state_field "${state_file}" error_code)"
  pid=""
  if [ -f "${pid_file}" ]; then
    pid="$(tr -d '[:space:]' <"${pid_file}")"
  fi

  if session_is_active "${status}" && [ -n "${pid}" ]; then
    if ! kill_worker_pid "${pid}"; then
      emit_json \
        "ok=false" \
        "session_id=$(json_string "${SESSION_ID}")" \
        "status=$(json_string "${status}")" \
        "error=$(json_string "failed to terminate worker pid ${pid}")" \
        "error_code=$(json_string "cancel_failed")"
      return 0
    fi
  fi

  last_output=""
  if [ -f "${output_log}" ]; then
    last_output="$(tail -c ${TAIL_MAX_BYTES} "${output_log}" 2>/dev/null || true)"
  fi

  write_state "${state_file}" \
    "ok=true" \
    "session_id=$(json_string "${SESSION_ID}")" \
    "status=$(json_string "cancelled")" \
    "qr_url=$(json_string "${qr_url}")" \
    "qr_ascii=$(json_string "${qr_ascii}")" \
    "error=$(json_string "${error_message}")" \
    "error_code=$(json_string "${error_code}")" \
    "started_at=$(json_string "${started_at}")" \
    "updated_at=$(json_string "${now}")" \
    "expires_at=$(json_string "${expires_at}")" \
    "finished_at=$(json_string "${now}")" \
    "pid=$(json_string "${pid}")" \
    "last_output_tail=$(json_string "${last_output}")" \
    "state_dir=$(json_string "$(session_dir)")" \
    "state_file=$(json_string "${state_file}")"
  emit_session_json_from_state "${state_file}"
}

gc_sessions() {
  ensure_state_root
  local removed=0 now
  now="$(date -u +%s)"
  local dir state_file expires_at expires_epoch status
  for dir in "${STATE_DIR}"/*; do
    [ -d "${dir}" ] || continue
    state_file="${dir}/state.json"
    if [ ! -f "${state_file}" ]; then
      rm -rf "${dir}"
      removed=$((removed + 1))
      continue
    fi
    status="$(read_state_field "${state_file}" status)"
    expires_at="$(read_state_field "${state_file}" expires_at)"
    expires_epoch="$(python3 - <<'PY' "$expires_at"
from datetime import datetime, timezone
import sys

value = sys.argv[1].strip()
if not value:
    print(0)
    raise SystemExit
if value.endswith('Z'):
    value = value[:-1] + '+00:00'
dt = datetime.fromisoformat(value)
if dt.tzinfo is None:
    dt = dt.replace(tzinfo=timezone.utc)
print(int(dt.timestamp()))
PY
)"
    if [ "${expires_epoch}" -gt 0 ] && [ "${expires_epoch}" -lt "${now}" ] && ! session_is_active "${status}"; then
      rm -rf "${dir}"
      removed=$((removed + 1))
    fi
  done
  emit_json "ok=true" "removed=${removed}" "state_dir=$(json_string "${STATE_DIR}")"
}

extract_fields_from_output() {
  python3 - <<'PY' "$1" "$2"
import re
import sys

path = sys.argv[1]
tail_bytes = int(sys.argv[2])
with open(path, 'r', encoding='utf-8', errors='replace') as f:
    output = f.read()

url_matches = re.findall(r'https?://[^\s"\']+', output)
qr_url = ''
for item in url_matches:
    lower = item.lower()
    if 'weixin.qq.com' in lower:
      qr_url = item.strip()
      break
if not qr_url and url_matches:
    qr_url = url_matches[0].strip()

best = ''
block = []
min_lines = 8
for line in output.splitlines():
    stripped = line.rstrip('\n')
    if any(ch in stripped for ch in ('█', '▀', '▄', '▌', '▐')) and len(stripped.strip()) >= 8:
        block.append(stripped)
        continue
    if len(block) >= min_lines and len('\n'.join(block)) > len(best):
        best = '\n'.join(block)
    block = []
if len(block) >= min_lines and len('\n'.join(block)) > len(best):
    best = '\n'.join(block)

tail = output[-tail_bytes:]
print(qr_url)
print('---SPLIT---')
print(best)
print('---SPLIT---')
print(tail)
PY
}

worker_main() {
  require_session_id
  require_timeout_seconds

  local state_file output_log pid_file started_at expires_at
  state_file="$(state_file_path)"
  output_log="$(output_log_path)"
  pid_file="$(worker_pid_path)"
  started_at="$(read_state_field "${state_file}" started_at)"
  expires_at="$(read_state_field "${state_file}" expires_at)"

  printf '%s\n' "$$" >"${pid_file}"
  write_state "${state_file}" \
    "ok=true" \
    "session_id=$(json_string "${SESSION_ID}")" \
    "status=$(json_string "starting")" \
    "qr_url=$(json_string "")" \
    "qr_ascii=$(json_string "")" \
    "error=$(json_string "")" \
    "error_code=$(json_string "")" \
    "started_at=$(json_string "${started_at}")" \
    "updated_at=$(json_string "$(utc_now_iso)")" \
    "expires_at=$(json_string "${expires_at}")" \
    "finished_at=null" \
    "pid=$$" \
    "last_output_tail=$(json_string "")" \
    "state_dir=$(json_string "$(session_dir)")" \
    "state_file=$(json_string "${state_file}")"

  python3 - "$0" "${SESSION_ID}" "${TIMEOUT_SECONDS}" "${STATE_DIR}" <<'PY' >"${output_log}" 2>&1 &
import os
import pty
import select
import signal
import subprocess
import sys
import time

program, session_id, timeout_seconds, state_dir = sys.argv[1:5]
cmd = ["openclaw", "channels", "login", "--channel", "openclaw-weixin"]
env = os.environ.copy()
deadline = time.time() + int(timeout_seconds)

master_fd, slave_fd = pty.openpty()
proc = subprocess.Popen(
    cmd,
    stdin=slave_fd,
    stdout=slave_fd,
    stderr=slave_fd,
    env=env,
    close_fds=True,
    preexec_fn=os.setsid,
)
os.close(slave_fd)

def terminate_child_group(sig):
    if proc.poll() is not None:
        return
    try:
        os.killpg(proc.pid, sig)
    except ProcessLookupError:
        return

def handle_signal(signum, _frame):
    terminate_child_group(signum)
    raise SystemExit(128 + signum)

signal.signal(signal.SIGTERM, handle_signal)
signal.signal(signal.SIGINT, handle_signal)

try:
    while True:
        timeout = max(0.0, min(1.0, deadline - time.time()))
        ready, _, _ = select.select([master_fd], [], [], timeout)
        if ready:
            try:
                chunk = os.read(master_fd, 4096)
            except OSError:
                chunk = b""
            if chunk:
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
        if proc.poll() is not None:
            while True:
                try:
                    chunk = os.read(master_fd, 4096)
                except OSError:
                    chunk = b""
                if not chunk:
                    break
                sys.stdout.buffer.write(chunk)
                sys.stdout.buffer.flush()
            break
        if time.time() >= deadline:
            terminate_child_group(signal.SIGTERM)
            try:
                proc.wait(timeout=5)
            except subprocess.TimeoutExpired:
                terminate_child_group(signal.SIGKILL)
                proc.wait(timeout=5)
            print(f"\n[timeout] session {session_id} exceeded {timeout_seconds}s", flush=True)
            break
finally:
    os.close(master_fd)

sys.exit(proc.returncode if proc.returncode is not None else 0)
PY
  local command_pid=$!

  local command_rc running_status last_seen_status
  command_rc=0
  running_status="starting"
  last_seen_status="starting"
  printf '%s\n' "${command_pid}" >"${pid_file}"

  while kill -0 "${command_pid}" 2>/dev/null; do
    local qr_parts qr_url qr_ascii last_output now
    qr_parts="$(extract_fields_from_output "${output_log}" "${TAIL_MAX_BYTES}")"
    qr_url="$(printf '%s' "${qr_parts}" | sed -n '1p')"
    qr_ascii="$(printf '%s' "${qr_parts}" | awk 'BEGIN{part=0} /^---SPLIT---$/{part++; next} part==1{print}')"
    last_output="$(printf '%s' "${qr_parts}" | awk 'BEGIN{part=0} /^---SPLIT---$/{part++; next} part==2{print}')"
    now="$(utc_now_iso)"

    if [ -n "${qr_url}" ] || [ -n "${qr_ascii}" ]; then
      running_status="waiting_qr"
    else
      running_status="starting"
    fi

    if [ "${running_status}" != "${last_seen_status}" ] || [ -n "${last_output}" ]; then
	      write_state "${state_file}" \
	        "ok=true" \
	        "session_id=$(json_string "${SESSION_ID}")" \
	        "status=$(json_string "${running_status}")" \
        "qr_url=$(json_string "${qr_url}")" \
        "qr_ascii=$(json_string "${qr_ascii}")" \
        "error=$(json_string "")" \
        "error_code=$(json_string "")" \
        "started_at=$(json_string "${started_at}")" \
        "updated_at=$(json_string "${now}")" \
        "expires_at=$(json_string "${expires_at}")" \
        "finished_at=null" \
	        "pid=${command_pid}" \
	        "last_output_tail=$(json_string "${last_output}")" \
	        "state_dir=$(json_string "$(session_dir)")" \
	        "state_file=$(json_string "${state_file}")"
      last_seen_status="${running_status}"
    fi

    if [ "${running_status}" = "waiting_qr" ]; then
      wait "${command_pid}" || command_rc=$?
      break
    fi

    sleep 1
  done

  if kill -0 "${command_pid}" 2>/dev/null; then
    wait "${command_pid}" || command_rc=$?
  elif [ "${command_rc}" -eq 0 ]; then
    wait "${command_pid}" || command_rc=$?
  fi

  local qr_parts qr_url qr_ascii last_output now status error_message error_code finished_at ok_value
  if [ "$(read_state_field "${state_file}" status)" = "cancelled" ]; then
    return 0
  fi
  qr_parts="$(extract_fields_from_output "${output_log}" "${TAIL_MAX_BYTES}")"
  qr_url="$(printf '%s' "${qr_parts}" | sed -n '1p')"
  qr_ascii="$(printf '%s' "${qr_parts}" | awk 'BEGIN{part=0} /^---SPLIT---$/{part++; next} part==1{print}')"
  last_output="$(printf '%s' "${qr_parts}" | awk 'BEGIN{part=0} /^---SPLIT---$/{part++; next} part==2{print}')"
  now="$(utc_now_iso)"
  finished_at="${now}"
  status="starting"
  error_message=""
  error_code=""
  ok_value=true

  if [ -n "${qr_url}" ] || [ -n "${qr_ascii}" ]; then
    status="waiting_qr"
  elif grep -qi '\[timeout\]' "${output_log}" 2>/dev/null; then
    status="expired"
    error_code="timeout"
    error_message="timed out waiting for qr code"
    ok_value=false
  elif [ "${command_rc}" -ne 0 ]; then
    status="failed"
    error_code="command_start_failed"
    error_message="openclaw login command failed"
    ok_value=false
  else
    status="failed"
    error_code="qr_not_found_before_exit"
    error_message="weixin login command exited without qr evidence"
    ok_value=false
  fi

	  write_state "${state_file}" \
	    "ok=${ok_value}" \
	    "session_id=$(json_string "${SESSION_ID}")" \
	    "status=$(json_string "${status}")" \
    "qr_url=$(json_string "${qr_url}")" \
    "qr_ascii=$(json_string "${qr_ascii}")" \
    "error=$(json_string "${error_message}")" \
    "error_code=$(json_string "${error_code}")" \
    "started_at=$(json_string "${started_at}")" \
    "updated_at=$(json_string "${now}")" \
    "expires_at=$(json_string "${expires_at}")" \
    "finished_at=$(json_string "${finished_at}")" \
	    "pid=${command_pid}" \
	    "last_output_tail=$(json_string "${last_output}")" \
	    "state_dir=$(json_string "$(session_dir)")" \
	    "state_file=$(json_string "${state_file}")"
}

case "${SUBCOMMAND}" in
  start)
    parse_common_flags "$@"
    start_session
    ;;
  status)
    parse_common_flags "$@"
    read_status
    ;;
  cancel)
    parse_common_flags "$@"
    cancel_session
    ;;
  gc)
    parse_common_flags "$@"
    gc_sessions
    ;;
  __worker)
    parse_common_flags "$@"
    worker_main
    ;;
  -h|--help|help|"")
    usage
    ;;
  *)
    emit_error_json "invalid_subcommand" "unknown subcommand: ${SUBCOMMAND}" 2
    ;;
esac
