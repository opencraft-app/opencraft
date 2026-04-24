#!/usr/bin/env bash
set -euo pipefail

# 脚本定义:
#   统一加载 repo-external .secret/sandbox/local.env 后执行 sandbox docker compose。
#   用于本地开发，避免在仓库内维护 repo-local 敏感 env 文件。
#
# 参数定义:
#   up/down/ps/logs/config
#     透传给 docker compose 的常用子命令。
#   -- <extra args>
#     追加传给 docker compose。
#
# 输出结果定义:
#   stdout/stderr 打印 compose 执行结果。
#   exit 0 表示成功；非 0 表示 secret 缺失或 docker compose 执行失败。
#
# 调用示例:
#   ./sandbox/scripts/dev-compose.sh up --build
#   ./sandbox/scripts/dev-compose.sh logs api

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SANDBOX_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
MONO_DIR="$(cd "${SANDBOX_DIR}/.." && pwd)"
SECRET_ENV="${MONO_DIR}/.secret/sandbox/local.env"
COMPOSE_FILE="${SANDBOX_DIR}/docker-compose.yml"

usage() {
  cat <<'EOF'
Usage:
  ./sandbox/scripts/dev-compose.sh [up|down|ps|logs|config] [-- extra args]

Description:
  Load .secret/sandbox/local.env, then run sandbox docker compose.

Examples:
  ./sandbox/scripts/dev-compose.sh up --build
  ./sandbox/scripts/dev-compose.sh logs api
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi

if [[ ! -f "${SECRET_ENV}" ]]; then
  echo "ERROR: missing ${SECRET_ENV}" >&2
  echo "Copy sandbox/secret-templates/local.env.example and ask the team for real values." >&2
  exit 1
fi

if docker compose version >/dev/null 2>&1; then
  DOCKER_COMPOSE=(docker compose)
elif command -v docker-compose >/dev/null 2>&1; then
  DOCKER_COMPOSE=(docker-compose)
else
  echo "ERROR: docker compose not found" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${SECRET_ENV}"
set +a

cd "${SANDBOX_DIR}"
"${DOCKER_COMPOSE[@]}" -f "${COMPOSE_FILE}" "$@"
