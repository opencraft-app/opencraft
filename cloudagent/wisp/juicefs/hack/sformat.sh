#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  hack/sformat.sh WORKSPACE [-- extra sformat args...]

Examples:
  hack/sformat.sh demo1
  hack/sformat.sh demo1 -- --force
  hack/sformat.sh demo1 -- --volume-name demo-volume --trash-days 0

Behavior:
  - exports the default COS environment
  - auto-builds a local juicefs binary if JFS_BIN does not exist
  - runs `juicefs sformat WORKSPACE`

Optional environment:
  JFS_BIN            binary path, default /tmp/juicefs-smount
  JFS_BUILD          set 0 to skip auto-build, default 1
  JFS_META_BASE      local sqlite working-db base path, default /tmp/jfs-smount-meta
  JFS_LOCAL_ROOT     derive local meta path under this root
  JFS_PREFIX         remote prefix root, default workspace
EOF
}

if [[ ${1:-} == "-h" || ${1:-} == "--help" || $# -lt 1 ]]; then
  usage
  exit $([[ $# -ge 1 ]] && echo 0 || echo 1)
fi

workspace="$1"
shift

extra_args=()
if [[ ${1:-} == "--" ]]; then
  shift
fi
if [[ $# -gt 0 ]]; then
  extra_args=("$@")
fi

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
bin="${JFS_BIN:-/tmp/juicefs-smount}"
build="${JFS_BUILD:-1}"
meta_base="${JFS_META_BASE:-/tmp/jfs-smount-meta}"
prefix="${JFS_PREFIX:-workspace}"
local_root="${JFS_LOCAL_ROOT:-}"
tmpdir="${TMPDIR:-/tmp}"
cache_root="${HOME:-/tmp}"
gotoolchain="${JFS_GOTOOLCHAIN:-go1.25.8}"
gosumdb="${GOSUMDB:-sum.golang.org}"

backend="${REMOTE_BACKEND:-}"
if [[ "$backend" != "smh" && "${SMH_ENABLED:-}" != "true" ]]; then
  : "${COS_BUCKET:?COS_BUCKET is required when REMOTE_BACKEND is not smh}"
  : "${COS_REGION:?COS_REGION is required when REMOTE_BACKEND is not smh}"
  : "${COS_ENDPOINT:?COS_ENDPOINT is required when REMOTE_BACKEND is not smh}"
  : "${TENCENTCLOUD_SECRET_ID:?TENCENTCLOUD_SECRET_ID is required when REMOTE_BACKEND is not smh}"
  : "${TENCENTCLOUD_SECRET_KEY:?TENCENTCLOUD_SECRET_KEY is required when REMOTE_BACKEND is not smh}"
  export AWS_ACCESS_KEY_ID="${AWS_ACCESS_KEY_ID:-$TENCENTCLOUD_SECRET_ID}"
  export AWS_SECRET_ACCESS_KEY="${AWS_SECRET_ACCESS_KEY:-$TENCENTCLOUD_SECRET_KEY}"
  export AWS_REGION="${AWS_REGION:-$COS_REGION}"
  export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$COS_REGION}"
  export LITESTREAM_S3_ENDPOINT="${LITESTREAM_S3_ENDPOINT:-$COS_ENDPOINT}"
fi

need_build=0
if [[ ! -x "$bin" ]]; then
  need_build=1
elif ! "$bin" sformat --help >/dev/null 2>&1; then
  need_build=1
fi

if [[ "$need_build" == "1" ]]; then
  if [[ "$build" != "1" ]]; then
    echo "error: binary not found and JFS_BUILD=0: $bin" >&2
    exit 1
  fi
  mkdir -p "$(dirname "$bin")"
  mkdir -p "$tmpdir/juicefs-tmp-go-build" "$cache_root/.cache/go-build"
  (
    cd "$repo_root"
    TMPDIR="$tmpdir/juicefs-tmp-go-build" \
    GOCACHE="$cache_root/.cache/go-build" \
    GOTOOLCHAIN="$gotoolchain" \
    GOSUMDB="$gosumdb" \
    GOFLAGS=-mod=mod \
    go build -tags 'litestreamvfs vfs' -o "$bin" ./
  )
fi

mkdir -p "$meta_base"

echo "workspace=$workspace"
echo "meta_base=$meta_base"
echo "prefix=$prefix"
echo "bin=$bin"
echo

cmd=("$bin" sformat "$workspace" --workspace-prefix "$prefix")

if [[ -n "$local_root" ]]; then
  cmd+=(--local-root "$local_root")
else
  cmd+=(--meta-base "$meta_base")
fi

if [[ ${#extra_args[@]} -gt 0 ]]; then
  cmd+=("${extra_args[@]}")
fi

exec "${cmd[@]}"
