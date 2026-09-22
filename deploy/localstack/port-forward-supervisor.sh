#!/usr/bin/env bash
set -u

if (($# < 2)); then
  printf 'usage: %s <log-file> <command> [args...]\n' "$0" >&2
  exit 2
fi

log_file="$1"
shift
restart_delay="${LOCALSTACK_PORT_FORWARD_RESTART_DELAY_SECONDS:-2}"
child_pid=""

mkdir -p "$(dirname "$log_file")"
touch "$log_file"

stop() {
  if [[ -n "$child_pid" ]]; then
    kill "$child_pid" >/dev/null 2>&1 || true
    wait "$child_pid" >/dev/null 2>&1 || true
  fi
  exit 0
}

trap stop HUP INT TERM

while true; do
  "$@" >>"$log_file" 2>&1 &
  child_pid=$!
  if wait "$child_pid"; then
    rc=0
  else
    rc=$?
  fi
  child_pid=""
  printf '[localstack] port-forward exited rc=%s; restarting in %ss\n' "$rc" "$restart_delay" >>"$log_file"
  sleep "$restart_delay" &
  child_pid=$!
  wait "$child_pid" >/dev/null 2>&1 || true
  child_pid=""
done
