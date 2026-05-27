#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  hack/ext4sdk_e2e.sh /path/to/juicefs-binary

Required environment:
  COS_BUCKET
  COS_REGION
  COS_ENDPOINT
  TENCENTCLOUD_SECRET_ID
  TENCENTCLOUD_SECRET_KEY

Optional environment:
  JFS_WORKSPACE_PREFIX  workspace prefix, default ext4e2e
  JFS_BLOCK_PATH        block file path, default /block.bin
  JFS_SIZE_GB           logical ext4 size in GiB, default 100
  JFS_E2E_PRIME_SCENARIOS  warm-prime scenarios after init, default stats
  JFS_E2E_COLD_RUNS     cold-start repetitions per matrix row, default 3
  JFS_E2E_WARM_RUNS     warm-start repetitions per matrix row, default 2
  JFS_KEEP_TMPDIR       keep temp dirs, default 0

This script runs several real-COS E2E matrices on top of ext4readwritedemo.
Each row initializes a fresh workspace, then executes repeated runs with
selected scenarios under either cold-start or warm-start behavior.
EOF
}

if [[ $# -ne 1 || "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit $([[ $# -eq 1 ]] && echo 0 || echo 1)
fi

bin="$1"
if [[ ! -x "$bin" ]]; then
  echo "error: binary not executable: $bin" >&2
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

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
demo_script="$script_dir/ext4readwritedemo.sh"
prefix="${JFS_WORKSPACE_PREFIX:-ext4e2e}"
prime_scenarios="${JFS_E2E_PRIME_SCENARIOS:-stats}"
cold_runs="${JFS_E2E_COLD_RUNS:-3}"
warm_runs="${JFS_E2E_WARM_RUNS:-2}"

run_case() {
  local name="$1"
  local scenarios="$2"
  local runs="$3"
  local cold="$4"
  local workspace="${prefix}-${name}"

  echo "==== case: $name"
  echo "workspace=$workspace"
  echo "scenarios=$scenarios"
  echo "runs=$runs cold_start=$cold"
  echo

  JFS_WORKSPACE="$workspace" \
  JFS_BLOCK_PATH="${JFS_BLOCK_PATH:-/block.bin}" \
  JFS_SIZE_GB="${JFS_SIZE_GB:-100}" \
  "$demo_script" init "$bin"

  echo "==== case prime: $name"
  JFS_WORKSPACE="$workspace" \
  JFS_BLOCK_PATH="${JFS_BLOCK_PATH:-/block.bin}" \
  JFS_SIZE_GB="${JFS_SIZE_GB:-100}" \
  JFS_COLD_START=0 \
  JFS_RUNS=1 \
  JFS_SCENARIOS="$prime_scenarios" \
  "$demo_script" run "$bin"

  JFS_WORKSPACE="$workspace" \
  JFS_BLOCK_PATH="${JFS_BLOCK_PATH:-/block.bin}" \
  JFS_SIZE_GB="${JFS_SIZE_GB:-100}" \
  JFS_COLD_START="$cold" \
  JFS_RUNS="$runs" \
  JFS_SCENARIOS="$scenarios" \
  "$demo_script" run "$bin"

  echo "==== case done: $name"
  echo
}

run_case "cold-core" "append,rename,crossrename_raw,crossrename,renamechain,truncate,seekwrite,multiseekwrite,reopen,stats" "$cold_runs" 1
run_case "cold-tree" "append,overwrite,tree,manyfiles,crossdirmix,remove,stats" "$cold_runs" 1
run_case "cold-large" "append,multiappend,largefile,largefilex,reopen,stats" "$cold_runs" 1
run_case "cold-accumulate" "append,multiappend,reopen,stats" "$cold_runs" 1
run_case "warm-mixed" "append,overwrite,rename,crossrename_raw,crossrename,renamechain,truncate,seekwrite,multiseekwrite,multiappend,manyfiles,crossdirmix,largefile,largefilex,reopen,tree,remove,stats" "$warm_runs" 0

echo "all ext4sdk e2e cases passed"
