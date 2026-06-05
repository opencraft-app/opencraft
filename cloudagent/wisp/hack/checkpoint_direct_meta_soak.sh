#!/usr/bin/env bash
set -euo pipefail

server="${1:-http://127.0.0.1:8520}"
iterations="${2:-3}"

meta_base="/tmp/jfs-smount-meta"
prefix="workspace"
bucket="${COS_BUCKET:-workspace-1388575217}"
region="${COS_REGION:-ap-singapore}"
endpoint="${COS_ENDPOINT:-http://cos.ap-singapore.myqcloud.com}"
sync_interval="3s"
barrier_timeout="60s"
runtime_maintenance="full"
snapshot_interval="1m"
helper="/tmp/direct-meta-op"
go_bin="${GO125_BIN:-/tmp/go1.25/go/bin/go}"

pass_count=0
fail_count=0

log_pass() {
  local iter="$1" name="$2"
  pass_count=$((pass_count + 1))
  printf 'PASS scenario=direct_meta iter=%s wisp=%s\n' "$iter" "$name"
}

log_fail() {
  local iter="$1" name="$2" msg="$3"
  fail_count=$((fail_count + 1))
  printf 'FAIL scenario=direct_meta iter=%s wisp=%s msg=%s\n' "$iter" "$name" "$msg"
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

path_exists() {
  local name="$1" path="$2"
  if /root/myworkspace/dist/wispclient -server "$server" fs stat "$name" "$path" >/dev/null 2>&1; then
    echo yes
  else
    echo no
  fi
}

build_meta_url() {
  local workspace="$1"
  local local_meta_path="${meta_base}/${workspace}/meta.db"
  python3 - <<'PY' "$local_meta_path" "$bucket" "$prefix" "$workspace" "$endpoint" "$region" "$sync_interval" "$barrier_timeout" "$runtime_maintenance" "$snapshot_interval"
import sys, urllib.parse
local_meta_path, bucket, prefix, workspace, endpoint, region, sync_interval, barrier_timeout, runtime_maintenance, snapshot_interval = sys.argv[1:]
replica_url = "s3://%s/%s/%s/meta.db?endpoint=%s&region=%s&force-path-style=false&sign-payload=true" % (
    bucket,
    prefix,
    workspace,
    endpoint,
    region,
)
query = urllib.parse.urlencode({
    "litestream_write": "true",
    "litestream_replica_url": replica_url,
    "litestream_sync_interval": sync_interval,
    "litestream_barrier_timeout": barrier_timeout,
    "litestream_runtime_maintenance": runtime_maintenance,
    "litestream_snapshot_interval": snapshot_interval,
    "litestream_hydration": "true",
})
print(f"sqlite3://{local_meta_path}?{query}")
PY
}

(
  cd /root/myworkspace/juicefs
  "$go_bin" build -tags 'litestreamvfs vfs' -o "$helper" ./hack/direct_meta_op.go
)

for i in $(seq 1 "$iterations"); do
  name="soak-direct-meta-${i}-$(date +%s%N | tail -c 6)"
  ckid="ck$(printf '%04d' "$i")"
  trap 'cleanup_wisp "$name"' RETURN

  prepare_wisp "$name"
  meta_url="$(build_meta_url "$name")"

  "$helper" "$meta_url" create "direct-pre-$i.txt"
  /root/myworkspace/dist/wispclient -server "$server" checkpoint create "$name" "$ckid" >/dev/null
  "$helper" "$meta_url" rename "direct-pre-$i.txt" "direct-renamed-$i.txt"
  "$helper" "$meta_url" create "direct-post-$i.txt"

  restore_ck "$name" "$ckid"

  pre_exists="$(path_exists "$name" "/direct-pre-$i.txt")"
  renamed_exists="$(path_exists "$name" "/direct-renamed-$i.txt")"
  post_exists="$(path_exists "$name" "/direct-post-$i.txt")"

  if [[ "$pre_exists" == "yes" && "$renamed_exists" == "no" && "$post_exists" == "no" ]]; then
    log_pass "$i" "$name"
  else
    log_fail "$i" "$name" "pre=$pre_exists renamed=$renamed_exists post=$post_exists"
  fi

  cleanup_wisp "$name"
  trap - RETURN
done

printf '\nSUMMARY pass=%d fail=%d total=%d\n' "$pass_count" "$fail_count" "$((pass_count + fail_count))"
if [[ "$fail_count" -ne 0 ]]; then
  exit 1
fi
