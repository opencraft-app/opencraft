#!/usr/bin/env bash
set -euo pipefail

server="${1:-http://127.0.0.1:8520}"
iterations="${2:-10}"

tmpdir="$(mktemp -d /tmp/checkpoint-soak.XXXXXX)"
trap 'rm -rf "$tmpdir"' EXIT

pass_count=0
fail_count=0

log_fail() {
  local scenario="$1"
  local iteration="$2"
  local name="$3"
  local message="$4"
  fail_count=$((fail_count + 1))
  printf 'FAIL scenario=%s iter=%s wisp=%s msg=%s\n' "$scenario" "$iteration" "$name" "$message"
}

log_pass() {
  local scenario="$1"
  local iteration="$2"
  local name="$3"
  pass_count=$((pass_count + 1))
  printf 'PASS scenario=%s iter=%s wisp=%s\n' "$scenario" "$iteration" "$name"
}

cleanup_wisp() {
  local name="$1"
  /root/myworkspace/dist/wispclient -server "$server" stop "$name" >/dev/null 2>&1 || true
  /root/myworkspace/dist/wispclient -server "$server" destroy "$name" >/dev/null 2>&1 || true
}

read_file() {
  local name="$1"
  local path="$2"
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
    content = data["file"]["content"]
    print(base64.b64decode(content).decode("utf-8"), end="")
except Exception:
    pass
PY
}

path_exists() {
  local name="$1"
  local path="$2"
  if /root/myworkspace/dist/wispclient -server "$server" fs stat "$name" "$path" >/dev/null 2>&1; then
    echo yes
  else
    echo no
  fi
}

run_restore() {
  local name="$1"
  local ckid="$2"
  /root/myworkspace/dist/wispclient -server "$server" checkpoint restore "$name" "$ckid" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" start "$name" >/dev/null
}

prepare_wisp() {
  local name="$1"
  /root/myworkspace/dist/wispclient -server "$server" create "$name" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" start "$name" >/dev/null
}

scenario_overwrite_file() {
  local i="$1"
  local name="soak-overwrite-${i}-$(date +%s%N | tail -c 6)"
  local ckid="ck$(printf '%04d' "$i")"
  local before="before-$i"
  local after="after-$i"
  trap 'cleanup_wisp "$name"' RETURN
  prepare_wisp "$name"
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/value.txt "$before" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/value.txt "$after" >/dev/null
  run_restore "$name" "$ckid"
  local got
  got="$(read_file "$name" /root/value.txt)"
  if printf '%s' "$got" | grep -q "$before"; then
    log_pass overwrite_file "$i" "$name"
  else
    log_fail overwrite_file "$i" "$name" "$got"
  fi
  cleanup_wisp "$name"
  trap - RETURN
}

scenario_create_after_restore_absent() {
  local i="$1"
  local name="soak-create-after-${i}-$(date +%s%N | tail -c 6)"
  local ckid="ck$(printf '%04d' "$i")"
  trap 'cleanup_wisp "$name"' RETURN
  prepare_wisp "$name"
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/base.txt "base-$i" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/after.txt "after-$i" >/dev/null
  run_restore "$name" "$ckid"
  local exists
  exists="$(path_exists "$name" /root/after.txt)"
  if [[ "$exists" == "no" ]]; then
    log_pass create_after_restore_absent "$i" "$name"
  else
    log_fail create_after_restore_absent "$i" "$name" "after.txt still exists"
  fi
  cleanup_wisp "$name"
  trap - RETURN
}

scenario_delete_after_restore_present() {
  local i="$1"
  local name="soak-delete-after-${i}-$(date +%s%N | tail -c 6)"
  local ckid="ck$(printf '%04d' "$i")"
  local before="keep-$i"
  trap 'cleanup_wisp "$name"' RETURN
  prepare_wisp "$name"
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/keep.txt "$before" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs rm "$name" /root/keep.txt >/dev/null
  run_restore "$name" "$ckid"
  local got
  got="$(read_file "$name" /root/keep.txt)"
  if printf '%s' "$got" | grep -q "$before"; then
    log_pass delete_after_restore_present "$i" "$name"
  else
    log_fail delete_after_restore_present "$i" "$name" "$got"
  fi
  cleanup_wisp "$name"
  trap - RETURN
}

scenario_rename_file() {
  local i="$1"
  local name="soak-rename-file-${i}-$(date +%s%N | tail -c 6)"
  local ckid="ck$(printf '%04d' "$i")"
  local before="rename-$i"
  trap 'cleanup_wisp "$name"' RETURN
  prepare_wisp "$name"
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/original.txt "$before" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs mv "$name" /root/original.txt /root/renamed.txt >/dev/null
  run_restore "$name" "$ckid"
  local orig renamed
  orig="$(read_file "$name" /root/original.txt)"
  renamed="$(path_exists "$name" /root/renamed.txt)"
  if printf '%s' "$orig" | grep -q "$before" && [[ "$renamed" == "no" ]]; then
    log_pass rename_file "$i" "$name"
  else
    log_fail rename_file "$i" "$name" "orig=[$orig] renamed_exists=$renamed"
  fi
  cleanup_wisp "$name"
  trap - RETURN
}

scenario_nested_directory() {
  local i="$1"
  local name="soak-nested-${i}-$(date +%s%N | tail -c 6)"
  local ckid="ck$(printf '%04d' "$i")"
  local before="nested-$i"
  trap 'cleanup_wisp "$name"' RETURN
  prepare_wisp "$name"
  /root/myworkspace/dist/wispclient -server "$server" fs mkdir "$name" /root/a >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs mkdir "$name" /root/a/b >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/a/b/file.txt "$before" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs rm "$name" /root/a >/dev/null
  run_restore "$name" "$ckid"
  local got
  got="$(read_file "$name" /root/a/b/file.txt)"
  if printf '%s' "$got" | grep -q "$before"; then
    log_pass nested_directory "$i" "$name"
  else
    log_fail nested_directory "$i" "$name" "$got"
  fi
  cleanup_wisp "$name"
  trap - RETURN
}

scenario_multi_file_mix() {
  local i="$1"
  local name="soak-multifile-${i}-$(date +%s%N | tail -c 6)"
  local ckid="ck$(printf '%04d' "$i")"
  trap 'cleanup_wisp "$name"' RETURN
  prepare_wisp "$name"
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/a.txt "A-$i" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/b.txt "B-$i" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/a.txt "A2-$i" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs rm "$name" /root/b.txt >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/c.txt "C-$i" >/dev/null
  run_restore "$name" "$ckid"
  local a b c
  a="$(read_file "$name" /root/a.txt)"
  b="$(read_file "$name" /root/b.txt)"
  c="$(path_exists "$name" /root/c.txt)"
  if printf '%s' "$a" | grep -q "A-$i" && printf '%s' "$b" | grep -q "B-$i" && [[ "$c" == "no" ]]; then
    log_pass multi_file_mix "$i" "$name"
  else
    log_fail multi_file_mix "$i" "$name" "a=[$a] b=[$b] c_exists=$c"
  fi
  cleanup_wisp "$name"
  trap - RETURN
}

scenario_directory_rename() {
  local i="$1"
  local name="soak-dir-rename-${i}-$(date +%s%N | tail -c 6)"
  local ckid="ck$(printf '%04d' "$i")"
  local before="dir-$i"
  trap 'cleanup_wisp "$name"' RETURN
  prepare_wisp "$name"
  /root/myworkspace/dist/wispclient -server "$server" fs mkdir "$name" /root/dir1 >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs write "$name" /root/dir1/file.txt "$before" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  /root/myworkspace/dist/wispclient -server "$server" fs mv "$name" /root/dir1 /root/dir2 >/dev/null
  run_restore "$name" "$ckid"
  local old new
  old="$(read_file "$name" /root/dir1/file.txt)"
  new="$(path_exists "$name" /root/dir2/file.txt)"
  if printf '%s' "$old" | grep -q "$before" && [[ "$new" == "no" ]]; then
    log_pass directory_rename "$i" "$name"
  else
    log_fail directory_rename "$i" "$name" "old=[$old] new_exists=$new"
  fi
  cleanup_wisp "$name"
  trap - RETURN
}

for i in $(seq 1 "$iterations"); do
  scenario_overwrite_file "$i"
  scenario_create_after_restore_absent "$i"
  scenario_delete_after_restore_present "$i"
  scenario_rename_file "$i"
  scenario_nested_directory "$i"
  scenario_multi_file_mix "$i"
  scenario_directory_rename "$i"
done

printf '\nSUMMARY pass=%d fail=%d total=%d\n' "$pass_count" "$fail_count" "$((pass_count + fail_count))"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
