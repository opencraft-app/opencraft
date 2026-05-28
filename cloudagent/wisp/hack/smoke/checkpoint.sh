#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  hack/smoke/checkpoint.sh [server-url]

Examples:
  hack/smoke/checkpoint.sh
  hack/smoke/checkpoint.sh http://127.0.0.1:8520

Behavior:
  - creates a temporary wisp
  - starts it
  - writes /root/ck.txt = before
  - creates checkpoint ck1
  - writes /root/ck.txt = after
  - restores checkpoint ck1
  - starts again
  - verifies both exec and fs read return "before"
  - stops and destroys the wisp
EOF
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

server="${1:-http://127.0.0.1:8520}"
name="smoke-ckpt-$(date +%s)"

cleanup() {
  ./dist/wispclient -server "$server" stop "$name" >/dev/null 2>&1 || true
  ./dist/wispclient -server "$server" destroy "$name" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() {
  printf '\n[%s]\n' "$1"
}

step "create"
./dist/wispclient -server "$server" create "$name"

step "start"
./dist/wispclient -server "$server" start "$name"

step "write before"
./dist/wispclient -server "$server" fs write "$name" /root/ck.txt before

step "checkpoint create"
./dist/wispclient -server "$server" checkpoint create "$name" ck1

step "write after"
./dist/wispclient -server "$server" fs write "$name" /root/ck.txt after

step "restore"
./dist/wispclient -server "$server" checkpoint restore "$name" ck1

step "restart"
./dist/wispclient -server "$server" start "$name"

step "verify exec"
exec_out="$(./dist/wispclient -server "$server" exec "$name" -- /bin/cat /root/ck.txt)"
printf '%s\n' "$exec_out"

step "verify fs"
fs_out="$(./dist/wispclient -server "$server" fs read "$name" /root/ck.txt)"
printf '%s\n' "$fs_out"

if ! printf '%s' "$exec_out" | grep -q 'before'; then
  echo "smoke failed: exec output did not contain expected content" >&2
  exit 1
fi

if ! printf '%s' "$fs_out" | grep -q 'YmVmb3Jl'; then
  echo "smoke failed: fs output did not contain expected base64 content" >&2
  exit 1
fi

step "success"
echo "checkpoint smoke passed for $name via $server"
