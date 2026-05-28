#!/usr/bin/env bash
set -euo pipefail

server="${1:-http://127.0.0.1:8520}"
iterations="${2:-3}"

pass_count=0
fail_count=0

log_pass() {
  local scenario="$1" iter="$2" name="$3"
  pass_count=$((pass_count + 1))
  printf 'PASS scenario=%s iter=%s wisp=%s\n' "$scenario" "$iter" "$name"
}

log_fail() {
  local scenario="$1" iter="$2" name="$3" msg="$4"
  fail_count=$((fail_count + 1))
  printf 'FAIL scenario=%s iter=%s wisp=%s msg=%s\n' "$scenario" "$iter" "$name" "$msg"
}

cleanup_wisp() {
  local name="$1"
  /root/myworkspace/dist/wispclient -server "$server" stop "$name" >/dev/null 2>&1 || true
  /root/myworkspace/dist/wispclient -server "$server" destroy "$name" >/dev/null 2>&1 || true
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

scenario_multi_checkpoint_chain() {
  local i="$1"
  local name="xsoak-chain-${i}-$(date +%s%N | tail -c 6)"
  trap 'cleanup_wisp "$name"' RETURN
  prepare_wisp "$name"

  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/value.txt "v1-$i" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" ck1 >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/value.txt "v2-$i" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" ck2 >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/value.txt "v3-$i" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" ck3 >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/value.txt "v4-$i" >/dev/null

  restore_ck "$name" ck2
  local got2
  got2="$(read_file "$name" /root/value.txt)"
  restore_ck "$name" ck1
  local got1
  got1="$(read_file "$name" /root/value.txt)"
  restore_ck "$name" ck3
  local got3
  got3="$(read_file "$name" /root/value.txt)"

  if [[ "$got2" == "v2-$i" && "$got1" == "v1-$i" && "$got3" == "v3-$i" ]]; then
    log_pass multi_checkpoint_chain "$i" "$name"
  else
    log_fail multi_checkpoint_chain "$i" "$name" "ck2=[$got2] ck1=[$got1] ck3=[$got3]"
  fi

  cleanup_wisp "$name"
  trap - RETURN
}

scenario_large_file_cross_chunk() {
  local i="$1"
  local name="xsoak-large-${i}-$(date +%s%N | tail -c 6)"
  local ckid="ck$(printf '%04d' "$i")"
  local before_file="/tmp/large-before-${name}.bin"
  local after_file="/tmp/large-after-${name}.bin"
  trap 'cleanup_wisp "$name"; rm -f "$before_file" "$after_file"' RETURN
  prepare_wisp "$name"

  python3 - <<'PY' "$before_file" "$after_file" "$i"
import sys, pathlib
before = pathlib.Path(sys.argv[1])
after = pathlib.Path(sys.argv[2])
i = sys.argv[3]
size = 70 * 1024 * 1024
chunk = b"A" * size
before.write_bytes(chunk)
mut = bytearray(chunk)
mut[0:8] = f"HEAD{i:0>4}".encode()
mut[-8:] = f"TAIL{i:0>4}".encode()
after.write_bytes(mut)
PY

  /root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc "cat >/root/big.bin" < "$before_file" >/dev/null 2>&1 || true
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc "cat >/root/big.bin" < "$after_file" >/dev/null 2>&1 || true
  restore_ck "$name" "$ckid"
  local head tail
  head=$(/root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc "head -c 8 /root/big.bin" 2>/dev/null || true)
  tail=$(/root/myworkspace/dist/wispclient -server "$server" exec "$name" -- /bin/sh -lc "tail -c 8 /root/big.bin" 2>/dev/null || true)

  if [[ "$head" == "AAAAAAAA" && "$tail" == "AAAAAAAA" ]]; then
    log_pass large_file_cross_chunk "$i" "$name"
  else
    log_fail large_file_cross_chunk "$i" "$name" "head=[$head] tail=[$tail]"
  fi

  cleanup_wisp "$name"
  trap - RETURN
}

for i in $(seq 1 "$iterations"); do
  scenario_multi_checkpoint_chain "$i"
  scenario_large_file_cross_chunk "$i"
done

printf '\nSUMMARY pass=%d fail=%d total=%d\n' "$pass_count" "$fail_count" "$((pass_count + fail_count))"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
