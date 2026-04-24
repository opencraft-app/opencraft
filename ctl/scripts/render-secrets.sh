#!/usr/bin/env bash
set -euo pipefail

# 脚本定义:
#   从仓库内的模板配置和仓库外的 .secret env 文件渲染 ctl 运行时配置。
#   适用于本地开发和测试环境部署前的配置准备，不修改 repo-tracked 文件。
#
# 参数定义:
#   --env <local|test>
#     必填，指定渲染的目标环境。
#   --secret-file <path>
#     可选，覆盖默认的 .secret env 文件路径。
#   --output-dir <path>
#     可选，覆盖默认的渲染输出目录。
#   -h, --help
#     显示帮助。
#
# 输出结果定义:
#   成功时在 /tmp/mono-rendered/ctl/<env>/ 下生成可直接运行的配置文件，并打印输出目录。
#   退出码 0 表示成功，非 0 表示缺少 secret 文件、模板变量缺失或渲染失败。
#
# 用法:
#   bash ctl/scripts/render-secrets.sh --env local
#   bash ctl/scripts/render-secrets.sh --env test --secret-file /secure/ctl-test.env

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTL_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MONO_DIR="$(cd "$CTL_DIR/.." && pwd)"

ENV_NAME=""
SECRET_FILE=""
OUTPUT_DIR=""

usage() {
    cat <<'EOF'
Usage:
  bash ctl/scripts/render-secrets.sh --env <local|test> [--secret-file <path>] [--output-dir <path>]

Description:
  Render ctl runtime configs from repo templates plus repo-external .secret env files.
  The script never writes back to repo-tracked config files.

Outputs:
  local -> /tmp/mono-rendered/ctl/local/{common,rewrite,docker-compose*.yml}
  test  -> /tmp/mono-rendered/ctl/test/{common,rewrite}

Options:
  --env <local|test>      Target environment to render.
  --secret-file <path>    Override the default .secret env file path.
  --output-dir <path>     Override the default rendered output root.
  -h, --help              Show this help text.

Examples:
  bash ctl/scripts/render-secrets.sh --env local
  bash ctl/scripts/render-secrets.sh --env test --output-dir /tmp/ctl-test-conf
EOF
}

log_info() {
    echo "[INFO] $*"
}

log_error() {
    echo "[ERROR] $*" >&2
}

require_cmd() {
    local cmd=$1
    if ! command -v "$cmd" >/dev/null 2>&1; then
        log_error "missing command: $cmd"
        exit 1
    fi
}

render_file() {
    local src=$1
    local dst=$2

    python3 - "$src" "$dst" <<'PY'
from pathlib import Path
import os
import re
import sys

src = Path(sys.argv[1])
dst = Path(sys.argv[2])
text = src.read_text()
pattern = re.compile(r"\$\{([A-Z0-9_]+)\}")
missing = sorted({match.group(1) for match in pattern.finditer(text) if match.group(1) not in os.environ})
if missing:
    print(f"[ERROR] missing variables for {src}: {', '.join(missing)}", file=sys.stderr)
    sys.exit(1)
rendered = pattern.sub(lambda match: os.environ[match.group(1)], text)
dst.parent.mkdir(parents=True, exist_ok=True)
dst.write_text(rendered)
PY
}

default_secret_file() {
    case "$ENV_NAME" in
        local) echo "$MONO_DIR/.secret/ctl/local.env" ;;
        test) echo "$MONO_DIR/.secret/ctl/test.env" ;;
        *)
            log_error "unsupported env: $ENV_NAME"
            exit 1
            ;;
    esac
}

default_output_dir() {
    local tmp_root=${TMPDIR:-/tmp}
    echo "$tmp_root/mono-rendered/ctl/$ENV_NAME"
}

destination_path() {
    local src=$1
    local relative=${src#"$CTL_DIR/conf/$ENV_NAME/"}
    if [[ "$relative" != "$src" ]]; then
        echo "$OUTPUT_DIR/$relative"
        return 0
    fi

    relative=${src#"$CTL_DIR/conf/local/"}
    if [[ "$relative" != "$src" ]]; then
        echo "$OUTPUT_DIR/$relative"
        return 0
    fi

    log_error "cannot derive destination path for template: $src"
    exit 1
}

render_templates() {
    local templates=()
    case "$ENV_NAME" in
        local)
            templates=(
                "$CTL_DIR/conf/local/common/server_conf.toml"
                "$CTL_DIR/conf/local/rewrite/server_conf_rewrite.toml"
                "$CTL_DIR/conf/local/docker-compose.yml"
                "$CTL_DIR/conf/local/docker-compose.monitoring.yml"
            )
            ;;
        test)
            templates=(
                "$CTL_DIR/conf/test/common/server_conf.toml"
                "$CTL_DIR/conf/test/rewrite/server_conf_rewrite.toml"
            )
            ;;
        *)
            log_error "unsupported env: $ENV_NAME"
            exit 1
            ;;
    esac

    mkdir -p "$OUTPUT_DIR"
    for src in "${templates[@]}"; do
        local dst
        dst=$(destination_path "$src")
        render_file "$src" "$dst"
    done
}

while [[ $# -gt 0 ]]; do
    case "$1" in
        --env)
            ENV_NAME=${2:-}
            shift 2
            ;;
        --secret-file)
            SECRET_FILE=${2:-}
            shift 2
            ;;
        --output-dir)
            OUTPUT_DIR=${2:-}
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            log_error "unknown argument: $1"
            usage
            exit 1
            ;;
    esac
done

if [[ -z "$ENV_NAME" ]]; then
    log_error "--env is required"
    usage
    exit 1
fi

require_cmd python3

if [[ -z "$SECRET_FILE" ]]; then
    SECRET_FILE=$(default_secret_file)
fi
if [[ -z "$OUTPUT_DIR" ]]; then
    OUTPUT_DIR=$(default_output_dir)
fi

if [[ ! -f "$SECRET_FILE" ]]; then
    log_error "secret file not found: $SECRET_FILE"
    log_error "ask the team for the .secret directory package before running ctl"
    exit 1
fi

set -a
# shellcheck disable=SC1090
source "$SECRET_FILE"
set +a

render_templates
log_info "rendered ctl $ENV_NAME config to $OUTPUT_DIR"
