#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  hack/ext4readwritedemo.sh init /path/to/juicefs-binary
  hack/ext4readwritedemo.sh run  /path/to/juicefs-binary

Subcommands:
  init    format a JuiceFS volume for the ext4 demo workspace
  run     run ext4readwritedemo against an existing workspace

Required environment:
  COS_BUCKET
  COS_REGION
  COS_ENDPOINT
  TENCENTCLOUD_SECRET_ID
  TENCENTCLOUD_SECRET_KEY

Common optional environment:
  JFS_TMPDIR_BASE       base temp dir, default /tmp
  JFS_CACHE_DIR         JuiceFS cache dir for demo command; default JuiceFS default
  JFS_WORKSPACE         stable workspace name, default ext4demo
  JFS_BLOCK_PATH        ext4 backing file path in JuiceFS, default /block.bin
  JFS_BLOCK_SIZE        block size, default 4096
  JFS_SIZE_GB           logical ext4 size in GiB, default 100
  JFS_SYNC_INTERVAL     writable VFS sync interval, default 3s
  JFS_BARRIER_TIMEOUT   writable VFS barrier timeout, default 60s
  JFS_VOLUME_NAME       format volume name, default ext4democos
  JFS_DATA_STORAGE      data storage backend for format, default s3
  JFS_BUCKET_URL        data bucket URL for object storage; default COS path under the workspace
  JFS_BUCKET_DIR        data bucket dir for --storage file; default $tmpdir/store
  JFS_REPLICA_PREFIX    replica prefix; default juicefs/ext4demo/$JFS_WORKSPACE/meta.db
  JFS_COLD_START        delete local SQLite/Litestream state before each run, default 1
  JFS_RUNS              run count for the run subcommand, default 1
  JFS_SCENARIOS         comma-separated demo scenarios, default append,overwrite,rename,crossrename_raw,crossrename,renamechain,truncate,seekwrite,multiseekwrite,multiappend,manyfiles,crossdirmix,largefile,largefilex,reopen,tree,remove,stats
  JFS_KEEP_TMPDIR       keep temp dir after success, default 0

Examples:
  export COS_BUCKET=agentsessiongz-1388575217
  export COS_REGION=ap-guangzhou
  export COS_ENDPOINT=http://cos.ap-guangzhou.myqcloud.com
  export TENCENTCLOUD_SECRET_ID=...
  export TENCENTCLOUD_SECRET_KEY=...
  export JFS_WORKSPACE=mydemo

  hack/ext4readwritedemo.sh init /tmp/juicefs-ext4demo
  hack/ext4readwritedemo.sh run  /tmp/juicefs-ext4demo
EOF
}

if [[ $# -ne 2 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit $([[ $# -eq 2 ]] && echo 0 || echo 1)
fi

cmd="$1"
JUICEFS_BIN="$2"

if [[ "$cmd" != "init" && "$cmd" != "run" ]]; then
  echo "error: unknown subcommand: $cmd" >&2
  usage
  exit 1
fi

if [[ ! -x "$JUICEFS_BIN" ]]; then
  echo "error: binary not executable: $JUICEFS_BIN" >&2
  exit 1
fi

required_env=(
  COS_BUCKET
  COS_REGION
  COS_ENDPOINT
  TENCENTCLOUD_SECRET_ID
  TENCENTCLOUD_SECRET_KEY
)
for name in "${required_env[@]}"; do
  if [[ -z "${!name:-}" ]]; then
    echo "error: missing environment variable: $name" >&2
    exit 1
  fi
done

export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-$TENCENTCLOUD_SECRET_ID}"
export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-$TENCENTCLOUD_SECRET_KEY}"
export AWS_SESSION_TOKEN="${AWS_SESSION_TOKEN:-${TENCENTCLOUD_SESSION_TOKEN:-}}"
export AWS_REGION="${AWS_REGION:-$COS_REGION}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$COS_REGION}"
export LITESTREAM_S3_ENDPOINT="${LITESTREAM_S3_ENDPOINT:-$COS_ENDPOINT}"

tmp_base="${JFS_TMPDIR_BASE:-/tmp}"
cache_dir="${JFS_CACHE_DIR:-}"
workspace="${JFS_WORKSPACE:-ext4demo}"
tmpdir="$tmp_base/jfs-ext4demo-$workspace"
block_path="${JFS_BLOCK_PATH:-/block.bin}"
block_size="${JFS_BLOCK_SIZE:-4096}"
size_gb="${JFS_SIZE_GB:-100}"
sync_interval="${JFS_SYNC_INTERVAL:-3s}"
barrier_timeout="${JFS_BARRIER_TIMEOUT:-60s}"
volume_name="${JFS_VOLUME_NAME:-ext4democos}"
data_storage="${JFS_DATA_STORAGE:-s3}"
bucket_dir="${JFS_BUCKET_DIR:-$tmpdir/store}"
replica_prefix="${JFS_REPLICA_PREFIX:-juicefs/ext4demo/$workspace/meta.db}"
bucket_url="${JFS_BUCKET_URL:-https://${COS_BUCKET}.cos.${COS_REGION}.myqcloud.com/juicefs/ext4demo/$workspace/data}"
cold_start="${JFS_COLD_START:-1}"
runs="${JFS_RUNS:-1}"
scenarios="${JFS_SCENARIOS:-append,overwrite,rename,crossrename_raw,crossrename,renamechain,truncate,seekwrite,multiseekwrite,multiappend,manyfiles,crossdirmix,largefile,largefilex,reopen,tree,remove,stats}"

if [[ "$data_storage" == "file" ]]; then
  mkdir -p "$bucket_dir"
fi

cleanup() {
  if [[ "${JFS_KEEP_TMPDIR:-0}" == "1" ]]; then
    return
  fi
  if [[ "$cmd" == "init" ]]; then
    return
  fi
  rm -rf "$tmpdir"
}
trap cleanup EXIT

export LITESTREAM_REPLICA_URL="s3://${COS_BUCKET}/${replica_prefix}?endpoint=${COS_ENDPOINT}&region=${COS_REGION}&force-path-style=false&sign-payload=true"
replica_url_enc="$(python3 - <<'PY'
import os
import urllib.parse
print(urllib.parse.quote(os.environ["LITESTREAM_REPLICA_URL"], safe=""))
PY
)"
meta_url="sqlite3://$tmpdir/meta.db?litestream_write=true&litestream_replica_url=$replica_url_enc&litestream_sync_interval=$sync_interval&litestream_barrier_timeout=$barrier_timeout"

print_summary() {
  echo "workspace=$workspace"
  echo "tmpdir=$tmpdir"
  echo "cache_dir=${cache_dir:-<default>}"
  echo "data_storage=$data_storage"
  if [[ "$data_storage" == "file" ]]; then
    echo "bucket_dir=$bucket_dir"
  else
    echo "bucket_url=$bucket_url"
  fi
  echo "block_path=$block_path"
  echo "size_gb=$size_gb"
  echo "meta_url=$meta_url"
  echo "replica_url=$LITESTREAM_REPLICA_URL"
  echo "cold_start=$cold_start"
  echo "runs=$runs"
  echo "scenarios=$scenarios"
  echo
}

case "$cmd" in
  init)
    print_summary
    echo "==> format"
    cmd=("$JUICEFS_BIN" --log-level error --no-agent --no-color)
    if [[ "$data_storage" == "file" ]]; then
      "${cmd[@]}" format "$meta_url" "$volume_name" \
        --storage file \
        --bucket "$bucket_dir"
    else
      fmt=("${cmd[@]}" format "$meta_url" "$volume_name" \
        --storage "$data_storage" \
        --bucket "$bucket_url" \
        --access-key "$TENCENTCLOUD_SECRET_ID" \
        --secret-key "$TENCENTCLOUD_SECRET_KEY")
      if [[ -n "${TENCENTCLOUD_SESSION_TOKEN:-}" ]]; then
        fmt+=(--session-token "$TENCENTCLOUD_SESSION_TOKEN")
      fi
      "${fmt[@]}"
    fi
    echo
    echo "init done"
    echo "workspace=$workspace"
    echo "tmpdir=$tmpdir"
    ;;
  run)
    print_summary
    for ((i=1; i<=runs; i++)); do
      if [[ "$cold_start" == "1" ]]; then
        rm -f "$tmpdir/meta.db" "$tmpdir/meta.db-shm" "$tmpdir/meta.db-wal"
        rm -rf "$tmpdir/.litestream"
      fi
      echo "==> ext4readwritedemo ($i/$runs)"
      cmd=("$JUICEFS_BIN" --log-level error --no-agent --no-color)
      if [[ -n "$cache_dir" ]]; then
        cmd+=(--cache-dir "$cache_dir")
      fi
      "${cmd[@]}" ext4readwritedemo "$meta_url" \
        --block-path "$block_path" \
        --size-gb "$size_gb" \
        --scenarios "$scenarios"
      echo
    done
    echo "run done"
    echo "workspace=$workspace"
    echo "tmpdir=$tmpdir"
    ;;
esac
