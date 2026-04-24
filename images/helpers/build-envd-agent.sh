#!/usr/bin/env bash
# =============================================================================
# LightClaw envd 本地构建脚本（辅助脚本）
#
# 定义:
#   在本地为当前目标系统构建 `envd` 二进制（基于官方 sandbox envd 源码），
#   并输出到 `images/bin/envd`，供 `images/build.sh` 上传到远端后安装。
#
# 角色:
#   - 非主入口
#   - 供 `images/deploy-build.sh` 依赖调用
#
# 参数定义:
#   --output <path>     可选，输出二进制路径，默认 images/bin/envd
#   --go-bin <path>     可选，指定 go 命令，默认从 PATH 查找
#   -h, --help          显示帮助
#
# 输出结果定义:
#   - 生成一个 Linux 二进制文件（默认关闭 CGO，避免目标机 glibc 版本不兼容）
#   - stdout 打印构建输入与产物路径
#   - 退出码 0 表示成功，非 0 表示失败
#
# 示例:
#   bash images/helpers/build-envd-agent.sh
#   bash images/helpers/build-envd-agent.sh --output /tmp/envd
# =============================================================================

set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  bash images/helpers/build-envd-agent.sh [options]

Description:
  Build the official sandbox envd binary for LightClaw images.

Options:
  --output <path>          Output binary path. Default: images/bin/envd
  --go-bin <path>          Go executable to use. Default: go from PATH
  --go-build-cache <path>  Go build cache path. Default: /tmp/lightclaw-go-build-cache
  --enable-cgo             Enable CGO. Default: disabled for better runtime compatibility
  -h, --help               Show this help message

Outputs:
  Writes a Linux binary for the current architecture to the selected output path.

Examples:
  bash images/helpers/build-envd-agent.sh
  bash images/helpers/build-envd-agent.sh --output /tmp/envd
EOF
}

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
IMAGES_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
REPO_ROOT="$(cd "${IMAGES_DIR}/.." && pwd)"
SOURCE_DIR="${IMAGES_DIR}/envd"
OUTPUT_PATH="${IMAGES_DIR}/bin/envd"
GO_BIN="${GO_BIN:-$(command -v go || true)}"
GO_BUILD_CACHE="${GO_BUILD_CACHE:-/tmp/lightclaw-go-build-cache}"
CGO_ENABLED_VALUE=0

while [ $# -gt 0 ]; do
  case "$1" in
    --output)
      OUTPUT_PATH="$2"
      shift 2
      ;;
    --go-bin)
      GO_BIN="$2"
      shift 2
      ;;
    --go-build-cache)
      GO_BUILD_CACHE="$2"
      shift 2
      ;;
    --enable-cgo)
      CGO_ENABLED_VALUE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "ERROR: unknown argument: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "${GO_BIN}" ] || [ ! -x "${GO_BIN}" ]; then
  echo "ERROR: go executable not found; set --go-bin or ensure go is in PATH" >&2
  exit 1
fi

if [ ! -f "${SOURCE_DIR}/go.mod" ] || [ ! -f "${SOURCE_DIR}/main.go" ]; then
  echo "ERROR: envd source not found in ${SOURCE_DIR}" >&2
  exit 1
fi

COMMIT_SHA="$(cd "${REPO_ROOT}" && git rev-parse --short HEAD 2>/dev/null || echo "unknown")"

mkdir -p "$(dirname "${OUTPUT_PATH}")"
mkdir -p "${GO_BUILD_CACHE}"

echo "INFO: building envd (official sandbox envd)"
echo "INFO: source=${SOURCE_DIR}"
echo "INFO: go_bin=${GO_BIN}"
echo "INFO: output=${OUTPUT_PATH}"
echo "INFO: cgo_enabled=${CGO_ENABLED_VALUE}"
echo "INFO: go_build_cache=${GO_BUILD_CACHE}"
echo "INFO: commit_sha=${COMMIT_SHA}"

(
  cd "${SOURCE_DIR}"
  GOWORK=off \
  GOCACHE="${GO_BUILD_CACHE}" \
  GOOS=linux \
  GOARCH=amd64 \
  CGO_ENABLED="${CGO_ENABLED_VALUE}" \
  "${GO_BIN}" build \
    -trimpath \
    -ldflags="-s -w -X=main.commitSHA=${COMMIT_SHA}" \
    -o "${OUTPUT_PATH}" \
    .
)

chmod 0755 "${OUTPUT_PATH}"
echo "INFO: build complete output=${OUTPUT_PATH}"
