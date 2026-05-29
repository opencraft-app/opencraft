#!/usr/bin/env bash
set -euo pipefail

server="${1:-http://127.0.0.1:8520}"
iterations="${2:-3}"

pass_count=0
fail_count=0

log_pass() {
  local iter="$1" name="$2"
  pass_count=$((pass_count + 1))
  printf 'PASS scenario=churn iter=%s wisp=%s\n' "$iter" "$name"
}

log_fail() {
  local iter="$1" name="$2" msg="$3"
  fail_count=$((fail_count + 1))
  printf 'FAIL scenario=churn iter=%s wisp=%s msg=%s\n' "$iter" "$name" "$msg"
}

cleanup_wisp() {
  local name="$1"
  /root/myworkspace/dist/wispclient -server "$server" stop "$name" >/dev/null 2>&1 || true
  /root/myworkspace/dist/wispclient -server "$server" destroy "$name" >/dev/null 2>&1 || true
}

prepare_wisp() {
  local name="$1"
  /root/myworkspace/dist/wispclient -server "$server" create "$name" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" start "$name" >/dev/null
}

restore_ck() {
  local name="$1" ckid="$2"
  /root/myworkspace/dist/wispclient -server "$server" checkpoint restore "$name" "$ckid" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" start "$name" >/dev/null
}

read_file() {
  local name="$1" path="$2"
  local raw
  raw=$(/root/myworkspace/dist/wispclient -server "$server" fs read "$name" "$path" 2>/dev/null || true)
  if [[ -z "$raw" ]]; then
    return 0
  fi
  python3 - <<'PY' "$raw"
import sys, json, base64
raw = sys.argv[1]
try:
    data = json.loads(raw)
    print(base64.b64decode(data["file"]["content"]).decode("utf-8"), end="")
except Exception:
    pass
PY
}

path_exists() {
  local name="$1" path="$2"
  if /root/myworkspace/dist/wispclient -server "$server" fs stat "$name" "$path" >/dev/null 2>&1; then
    echo yes
  else
    echo no
  fi
}

for i in $(seq 1 "$iterations"); do
  name="soak-churn-${i}-$(date +%s%N | tail -c 6)"
  ckid="ck$(printf '%04d' "$i")"
  trap 'cleanup_wisp "$name"' RETURN

  prepare_wisp "$name"

  # Build a mixed tree before checkpoint.
  for n in $(seq 1 20); do
    /root/myworkspace/dist/wispclient -server "$server" fs mkdir "$name" "/root/tree/$n" >/dev/null
    /root/myworkspace/dist/wispclient -server "$server" fs write "$name" "/root/tree/$n/value.txt" "before-$i-$n" >/dev/null
  done

  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null

  # Heavy churn after checkpoint.
  for n in $(seq 1 20); do
    /root/myworkspace/dist/wispclient -server "$server" fs write "$name" "/root/tree/$n/value.txt" "after-$i-$n" >/dev/null
    /root/myworkspace/dist/wispclient -server "$server" fs mv "$name" "/root/tree/$n" "/root/tree-renamed-$n" >/dev/null
    /root/myworkspace/dist/wispclient -server "$server" fs write "$name" "/root/new-$n.txt" "new-$i-$n" >/dev/null
  done

  restore_ck "$name" "$ckid"

  ok=yes
  msg=""
  for n in 1 10 20; do
    got="$(read_file "$name" "/root/tree/$n/value.txt")"
    if [[ "$got" != "before-$i-$n" ]]; then
      ok=no
      msg="tree/$n/value.txt=[$got]"
      break
    fi
    exists_new="$(path_exists "$name" "/root/new-$n.txt")"
    if [[ "$exists_new" != no ]]; then
      ok=no
      msg="new-$n.txt still exists"
      break
    fi
    exists_renamed="$(path_exists "$name" "/root/tree-renamed-$n/value.txt")"
    if [[ "$exists_renamed" != no ]]; then
      ok=no
      msg="tree-renamed-$n still exists"
      break
    fi
  done

  if [[ "$ok" == yes ]]; then
    log_pass "$i" "$name"
  else
    log_fail "$i" "$name" "$msg"
  fi

  cleanup_wisp "$name"
  trap - RETURN
done

printf '\nSUMMARY pass=%d fail=%d total=%d\n' "$pass_count" "$fail_count" "$((pass_count + fail_count))"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
