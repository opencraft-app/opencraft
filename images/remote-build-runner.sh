#!/usr/bin/env bash
set -euo pipefail

# 脚本定义:
#   在远端主机上作为后台 job runner 执行镜像构建命令，并把状态、stdout、stderr
#   落到工作目录，供本地轮询。
#
# 参数定义:
#   --workdir <path>        远端执行目录
#   --status-file <path>    JSON 状态文件路径
#   --stdout-file <path>    标准输出日志路径
#   --stderr-file <path>    标准错误日志路径
#   --phase-file <path>     当前阶段文件路径
#   --                      后续参数为实际执行命令
#
# 输出结果定义:
#   - 写入 status.json，状态包含 running/succeeded/failed
#   - 写入 stdout/stderr 日志文件
#   - exit 0 仅代表 runner 自身正常结束；业务命令退出码写入 status 文件
#
# 调用示例:
#   bash remote-build-runner.sh \
#     --workdir /opt/lightclaw-image \
#     --status-file /opt/lightclaw-image/.build-status.json \
#     --stdout-file /opt/lightclaw-image/.build-stdout.log \
#     --stderr-file /opt/lightclaw-image/.build-stderr.log \
#     -- bash ./build.sh --app-only

usage() {
  cat <<'EOF'
Usage:
  bash remote-build-runner.sh --workdir <path> --status-file <path> --stdout-file <path> --stderr-file <path> -- <command...>

Description:
  Run a build command on the remote host as a managed background job and write
  JSON status plus stdout/stderr logs for polling.

Options:
  --workdir <path>        Remote working directory
  --status-file <path>    Status JSON path
  --stdout-file <path>    Stdout log path
  --stderr-file <path>    Stderr log path
  --phase-file <path>     Phase text path
  -h, --help              Show help

Outputs:
  Writes status/log files and exits after the wrapped command finishes.

Examples:
  bash remote-build-runner.sh --workdir /opt/lightclaw-image --status-file /opt/lightclaw-image/.build-status.json --stdout-file /opt/lightclaw-image/.build-stdout.log --stderr-file /opt/lightclaw-image/.build-stderr.log -- bash ./build.sh --app-only
EOF
}

log_error() { echo "ERROR: $*" >&2; }

WORKDIR=""
STATUS_FILE=""
STDOUT_FILE=""
STDERR_FILE=""
PHASE_FILE=""
declare -a COMMAND=()

while [ $# -gt 0 ]; do
  case "$1" in
    --workdir)
      WORKDIR="$2"
      shift 2
      ;;
    --status-file)
      STATUS_FILE="$2"
      shift 2
      ;;
    --stdout-file)
      STDOUT_FILE="$2"
      shift 2
      ;;
    --stderr-file)
      STDERR_FILE="$2"
      shift 2
      ;;
    --phase-file)
      PHASE_FILE="$2"
      shift 2
      ;;
    --)
      shift
      COMMAND=("$@")
      break
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      log_error "unknown argument: $1"
      usage >&2
      exit 1
      ;;
  esac
done

if [ -z "${WORKDIR}" ] || [ -z "${STATUS_FILE}" ] || [ -z "${STDOUT_FILE}" ] || [ -z "${STDERR_FILE}" ] || [ -z "${PHASE_FILE}" ]; then
  log_error "missing required arguments"
  usage >&2
  exit 1
fi

if [ "${#COMMAND[@]}" -eq 0 ]; then
  log_error "missing command after --"
  usage >&2
  exit 1
fi

mkdir -p "$(dirname "${STATUS_FILE}")" "$(dirname "${STDOUT_FILE}")" "$(dirname "${STDERR_FILE}")" "$(dirname "${PHASE_FILE}")"

write_status() {
  local state="$1"
  local exit_code="$2"
  local tmp_file="${STATUS_FILE}.tmp"
  STATE="$state" EXIT_CODE="$exit_code" WORKDIR_VALUE="$WORKDIR" STATUS_FILE_VALUE="$STATUS_FILE" \
  STDOUT_FILE_VALUE="$STDOUT_FILE" STDERR_FILE_VALUE="$STDERR_FILE" PHASE_FILE_VALUE="$PHASE_FILE" \
  python3 - "${COMMAND[@]}" <<'PY' > "${tmp_file}"
import json
import os
import sys
from datetime import datetime, timezone

def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")

payload = {
    "state": os.environ["STATE"],
    "workdir": os.environ["WORKDIR_VALUE"],
    "status_file": os.environ["STATUS_FILE_VALUE"],
    "stdout_file": os.environ["STDOUT_FILE_VALUE"],
    "stderr_file": os.environ["STDERR_FILE_VALUE"],
    "phase_file": os.environ["PHASE_FILE_VALUE"],
    "command": sys.argv[1:],
    "updated_at": now(),
}

exit_code = os.environ.get("EXIT_CODE", "")
if exit_code != "":
    payload["exit_code"] = int(exit_code)

started_at_path = os.environ.get("STATUS_FILE_VALUE", "") + ".started_at"
if os.path.exists(started_at_path):
    with open(started_at_path, "r", encoding="utf-8") as f:
        payload["started_at"] = f.read().strip()
if payload["state"] in ("succeeded", "failed"):
    payload["finished_at"] = now()

phase_path = os.environ["PHASE_FILE_VALUE"]
if os.path.exists(phase_path):
    with open(phase_path, "r", encoding="utf-8") as f:
        phase = f.read().strip()
        if phase:
            payload["phase"] = phase

print(json.dumps(payload, ensure_ascii=False, indent=2))
PY
  mv "${tmp_file}" "${STATUS_FILE}"
}

started_at_file="${STATUS_FILE}.started_at"
date -u +"%Y-%m-%dT%H:%M:%S%:z" > "${started_at_file}"
: > "${STDOUT_FILE}"
: > "${STDERR_FILE}"
: > "${PHASE_FILE}"
echo "starting" > "${PHASE_FILE}"
write_status "running" ""

cd "${WORKDIR}"
set +e
echo "running" > "${PHASE_FILE}"
"${COMMAND[@]}" >"${STDOUT_FILE}" 2>"${STDERR_FILE}"
exit_code=$?
set -e

if [ "${exit_code}" -eq 0 ]; then
  echo "finished" > "${PHASE_FILE}"
  write_status "succeeded" "${exit_code}"
else
  echo "failed" > "${PHASE_FILE}"
  write_status "failed" "${exit_code}"
fi

exit "${exit_code}"
