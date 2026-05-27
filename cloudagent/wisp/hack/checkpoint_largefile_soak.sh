#!/usr/bin/env bash
set -euo pipefail

server="${1:-http://127.0.0.1:8520}"
iterations="${2:-3}"

pass_count=0
fail_count=0

log_pass() {
  local iter="$1" name="$2"
  pass_count=$((pass_count + 1))
  printf 'PASS scenario=large_file_cross_chunk iter=%s wisp=%s\n' "$iter" "$name"
}

log_fail() {
  local iter="$1" name="$2" msg="$3"
  fail_count=$((fail_count + 1))
  printf 'FAIL scenario=large_file_cross_chunk iter=%s wisp=%s msg=%s\n' "$iter" "$name" "$msg"
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

hex_head() {
  local name="$1"
  /root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc "od -An -tx1 -N8 /root/big.bin | tr -d ' \n'" 2>/dev/null || true
}

hex_tail() {
  local name="$1"
  /root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc "tail -c 8 /root/big.bin | od -An -tx1 | tr -d ' \n'" 2>/dev/null || true
}

byte_count() {
  local name="$1"
  /root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc "wc -c </root/big.bin | tr -d ' \n'" 2>/dev/null || true
}

for i in $(seq 1 "$iterations"); do
  name="soak-large-${i}-$(date +%s%N | tail -c 6)"
  ckid="ck$(printf '%04d' "$i")"
  trap 'cleanup_wisp "$name"' RETURN

  prepare_wisp "$name"

  /root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc \
    "dd if=/dev/zero of=/root/big.bin bs=1M count=70 status=none" >/dev/null

  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null

  /root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc \
    "printf 'HEAD$(printf '%04d' "$i")' | dd of=/root/big.bin bs=1 count=8 conv=notrunc status=none && \
     printf 'TAIL$(printf '%04d' "$i")' | dd of=/root/big.bin bs=1 seek=$((70*1024*1024-8)) conv=notrunc status=none" >/dev/null

  restore_ck "$name" "$ckid"

  head_hex="$(hex_head "$name")"
  tail_hex="$(hex_tail "$name")"
  size="$(byte_count "$name")"

  if [[ "$head_hex" == "0000000000000000" && "$tail_hex" == "0000000000000000" && "$size" == "73400320" ]]; then
    log_pass "$i" "$name"
  else
    log_fail "$i" "$name" "head_hex=[$head_hex] tail_hex=[$tail_hex] size=[$size]"
  fi

  cleanup_wisp "$name"
  trap - RETURN
done

printf '\nSUMMARY pass=%d fail=%d total=%d\n' "$pass_count" "$fail_count" "$((pass_count + fail_count))"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
