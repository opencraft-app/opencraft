#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  hack/bench/checkpoint.sh [server-url] [iterations]

Examples:
  hack/bench/checkpoint.sh
  hack/bench/checkpoint.sh http://127.0.0.1:8520
  hack/bench/checkpoint.sh http://127.0.0.1:8520 100

Behavior:
  - creates one temporary wisp
  - starts it once
  - repeats checkpoint/restore/restart verification N times
  - prints per-iteration timings and summary statistics

Reported timings:
  checkpoint_create_ms
  restore_only_ms
  restart_only_ms
  resume_total_ms (= restore + restart)
EOF
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" ]]; then
  usage
  exit 0
fi

server="${1:-http://127.0.0.1:8520}"
iterations="${2:-100}"
tmpdir="$(mktemp -d /tmp/bench-ckpt.XXXXXX)"

cleanup() {
  rm -rf "$tmpdir"
}
trap cleanup EXIT

ms() {
  date +%s%3N
}

summary() {
  label="$1"
  file="$2"
  count="$(wc -l < "$file" | tr -d ' ')"
  if [[ "$count" == "0" ]]; then
    echo "$label: no data"
    return 1
  fi
  avg="$(awk '{sum+=$1} END {printf "%.1f", sum/NR}' "$file")"
  min="$(sort -n "$file" | head -n 1)"
  max="$(sort -n "$file" | tail -n 1)"
  p50_index="$(( (count + 1) / 2 ))"
  p95_index="$(( (95 * count + 99) / 100 ))"
  p50="$(sort -n "$file" | sed -n "${p50_index}p")"
  p95="$(sort -n "$file" | sed -n "${p95_index}p")"
  printf "%s: count=%s avg=%sms min=%sms p50=%sms p95=%sms max=%sms\n" \
    "$label" "$count" "$avg" "$min" "$p50" "$p95" "$max"
}

: > "$tmpdir/checkpoint_create_ms"
: > "$tmpdir/restore_only_ms"
: > "$tmpdir/restart_only_ms"
: > "$tmpdir/resume_total_ms"

for i in $(seq 1 "$iterations"); do
  name="bench-ckpt-$i-$(date +%s%N | tail -c 8)"
  ckid="$(printf 'ck%04d' "$i")"
  before="before-$i"
  after="after-$i"
  wisp_cleanup() {
    ./dist/wispclient -server "$server" stop "$name" >/dev/null 2>&1 || true
    ./dist/wispclient -server "$server" destroy "$name" >/dev/null 2>&1 || true
  }
  trap 'wisp_cleanup' RETURN

  ./dist/wispclient -server "$server" create "$name" >/dev/null
  ./dist/wispclient -server "$server" start "$name" >/dev/null

  ./dist/wispclient -server "$server" fs write "$name" /root/ck.txt "$before" >/dev/null

  t0="$(ms)"
  ./dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  t1="$(ms)"
  c_ms="$((t1 - t0))"
  echo "$c_ms" >> "$tmpdir/checkpoint_create_ms"

  ./dist/wispclient -server "$server" fs write "$name" /root/ck.txt "$after" >/dev/null

  t2="$(ms)"
  ./dist/wispclient -server "$server" checkpoint restore "$name" "$ckid" >/dev/null
  t3="$(ms)"
  ./dist/wispclient -server "$server" start "$name" >/dev/null
  t4="$(ms)"

  r_ms="$((t3 - t2))"
  s_ms="$((t4 - t3))"
  rt_ms="$((t4 - t2))"

  echo "$r_ms" >> "$tmpdir/restore_only_ms"
  echo "$s_ms" >> "$tmpdir/restart_only_ms"
  echo "$rt_ms" >> "$tmpdir/resume_total_ms"

  exec_out="$(./dist/wispclient -server "$server" exec "$name" -- /bin/cat /root/ck.txt)"
  if ! printf '%s' "$exec_out" | grep -q "$before"; then
    echo "benchmark failed at iteration $i: expected $before, got: $exec_out" >&2
    exit 1
  fi

  printf "iter=%03d checkpoint=%sms restore=%sms restart=%sms resume=%sms\n" \
    "$i" "$c_ms" "$r_ms" "$s_ms" "$rt_ms"

  wisp_cleanup
  trap - RETURN
done

echo
echo "[summary]"
summary "checkpoint_create_ms" "$tmpdir/checkpoint_create_ms"
summary "restore_only_ms" "$tmpdir/restore_only_ms"
summary "restart_only_ms" "$tmpdir/restart_only_ms"
summary "resume_total_ms" "$tmpdir/resume_total_ms"
