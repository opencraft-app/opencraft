#!/usr/bin/env bash
set -euo pipefail

server="${1:-http://127.0.0.1:8520}"
iterations="${2:-3}"
workers="${3:-8}"
files_per_worker="${4:-10}"

pass_count=0
fail_count=0

log_pass() {
  local iter="$1" name="$2"
  pass_count=$((pass_count + 1))
  printf 'PASS scenario=concurrent_write iter=%s wisp=%s\n' "$iter" "$name"
}

log_fail() {
  local iter="$1" name="$2" msg="$3"
  fail_count=$((fail_count + 1))
  printf 'FAIL scenario=concurrent_write iter=%s wisp=%s msg=%s\n' "$iter" "$name" "$msg"
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

run_parallel_preload() {
  local name="$1" iter="$2"
  /root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc "
set -eu
mkdir -p /root/concurrent
workers=$workers
files=$files_per_worker
seq 1 \$workers | xargs -I{} -P\$workers sh -c '
  w=\"\$1\"
  i=\"\$2\"
  fcount=\"\$3\"
  j=1
  while [ \$j -le \$fcount ]; do
    printf \"before-%s-\$w-\$j\" \"\$i\" > \"/root/concurrent/w\$w-\$j.txt\"
    j=\$((j+1))
  done
' _ {} '$iter' \$files
" >/dev/null
}

run_parallel_postmutate() {
  local name="$1" iter="$2"
  /root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc "
set -eu
workers=$workers
files=$files_per_worker
seq 1 \$workers | xargs -I{} -P\$workers sh -c '
  w=\"\$1\"
  i=\"\$2\"
  fcount=\"\$3\"
  j=1
  while [ \$j -le \$fcount ]; do
    printf \"after-%s-\$w-\$j\" \"\$i\" > \"/root/concurrent/w\$w-\$j.txt\"
    printf \"new-%s-\$w-\$j\" \"\$i\" > \"/root/concurrent/new-\$w-\$j.txt\"
    j=\$((j+1))
  done
' _ {} '$iter' \$files
" >/dev/null
}

for i in $(seq 1 "$iterations"); do
  name="soak-concurrent-${i}-$(date +%s%N | tail -c 6)"
  ckid="ck$(printf '%04d' "$i")"
  trap 'cleanup_wisp "$name"' RETURN

  prepare_wisp "$name"
  run_parallel_preload "$name" "$i"
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  run_parallel_postmutate "$name" "$i"
  restore_ck "$name" "$ckid"

  ok=yes
  msg=""
  for w in 1 "$workers"; do
    for j in 1 "$files_per_worker"; do
      path="/root/concurrent/w${w}-${j}.txt"
      got="$(read_file "$name" "$path")"
      want="before-${i}-${w}-${j}"
      if [[ "$got" != "$want" ]]; then
        ok=no
        msg="${path}=[$got], want=[$want]"
        break 2
      fi
      new_path="/root/concurrent/new-${w}-${j}.txt"
      exists_new="$(path_exists "$name" "$new_path")"
      if [[ "$exists_new" != no ]]; then
        ok=no
        msg="${new_path} still exists"
        break 2
      fi
    done
  done

  if [[ "$ok" == yes ]]; then
    log_pass "$i" "$name"
  else
    log_fail "$i" "$name" "$msg"
  fi

  cleanup_wisp "$name"
  trap - RETURN
done

printf '\nSUMMARY pass=%d fail=%d total=%d workers=%d files_per_worker=%d\n' \
  "$pass_count" "$fail_count" "$((pass_count + fail_count))" "$workers" "$files_per_worker"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
