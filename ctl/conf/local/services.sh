#!/usr/bin/env bash
# 脚本定义:
#   管理 ctl 本地 API / Service / Bypass 三服务的普通启动与热加载启动。
#   普通模式适合快速验证，热加载模式适合频繁改代码时持续联调。
#
# 参数定义:
#   start / stop / restart / status / logs
#     普通后台模式，直接用 `go run` 启动三服务。
#   dev-start / dev-stop / dev-restart / dev-status / dev-logs
#     热加载模式，使用 CompileDaemon 监听代码变更并自动重编译重启。
#
# 输出结果定义:
#   stdout 打印每个服务的 PID、日志路径和 metrics 端口。
#   普通模式与热加载模式的 PID / 日志分开存放在 /tmp/ctl-local 下。
#   退出码 0 表示成功，非 0 表示某个服务启动失败或参数非法。
#
# 用法:
#   ./conf/local/services.sh start
#   ./conf/local/services.sh dev-start
#   ./conf/local/services.sh logs api
#   ./conf/local/services.sh dev-logs service

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CTL_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MONO_DIR="$(cd "$CTL_DIR/.." && pwd)"
RENDER_SCRIPT="$CTL_DIR/scripts/render-secrets.sh"
CONF_DIR="${TMPDIR:-/tmp}/mono-rendered/ctl/local"
LOG_DIR="/tmp/ctl-local"
BIN_DIR="$LOG_DIR/bin"
GOBIN_DIR="${GOBIN:-$(go env GOPATH)/bin}"
COMPILE_DAEMON_BIN="$GOBIN_DIR/CompileDaemon"

mkdir -p "$LOG_DIR"
mkdir -p "$BIN_DIR"

ensure_local_conf() {
    if [[ ! -x "$RENDER_SCRIPT" ]]; then
        echo -e "  ${RED}render-secrets${NC} 未找到: $RENDER_SCRIPT"
        exit 1
    fi

    "$RENDER_SCRIPT" --env local >/dev/null
}

PID_API="$LOG_DIR/api.pid"
PID_SERVICE="$LOG_DIR/service.pid"
PID_BYPASS="$LOG_DIR/bypass.pid"
PID_API_DEV="$LOG_DIR/api-dev.pid"
PID_SERVICE_DEV="$LOG_DIR/service-dev.pid"
PID_BYPASS_DEV="$LOG_DIR/bypass-dev.pid"

LOG_API="$LOG_DIR/api.log"
LOG_SERVICE="$LOG_DIR/service.log"
LOG_BYPASS="$LOG_DIR/bypass.log"
LOG_API_DEV="$LOG_DIR/api-dev.log"
LOG_SERVICE_DEV="$LOG_DIR/service-dev.log"
LOG_BYPASS_DEV="$LOG_DIR/bypass-dev.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

is_running() {
    local pidfile=$1
    [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

print_startup_hints() {
    echo ""
    echo "Prometheus targets:"
    echo "  API     http://localhost:9591/metrics"
    echo "  Service http://localhost:9592/metrics"
    echo "  Bypass  http://localhost:9593/metrics"
}

start_one() {
    local name=$1 main=$2 pidfile=$3 logfile=$4 port=$5

    if is_running "$pidfile"; then
        echo -e "  ${YELLOW}$name${NC} 已在运行 (PID $(cat "$pidfile"))"
        return
    fi

    cd "$CTL_DIR"
    nohup go run "./$main" -conf-dir "$CONF_DIR" > "$logfile" 2>&1 &
    local pid=$!
    echo "$pid" > "$pidfile"

    # 等待 metrics 端口就绪
    for i in $(seq 1 20); do
        if curl -sf "http://localhost:$port/metrics" > /dev/null 2>&1; then
            echo -e "  ${GREEN}$name${NC} 启动成功 (PID $pid, metrics :$port)"
            return
        fi
        sleep 1
    done
    echo -e "  ${RED}$name${NC} 启动超时，查看日志: $logfile"
    return 1
}

ensure_compile_daemon() {
    if [[ -x "$COMPILE_DAEMON_BIN" ]]; then
        return 0
    fi

    echo "CompileDaemon 未安装，正在安装到 $COMPILE_DAEMON_BIN ..."
    (
        cd "$CTL_DIR"
        GOBIN="$GOBIN_DIR" go install github.com/githubnemo/CompileDaemon@latest
    )

    if [[ ! -x "$COMPILE_DAEMON_BIN" ]]; then
        echo -e "  ${RED}CompileDaemon${NC} 安装失败"
        return 1
    fi
}

start_dev_one() {
    local name=$1 main=$2 pidfile=$3 logfile=$4 port=$5 bin_name=$6

    if is_running "$pidfile"; then
        echo -e "  ${YELLOW}$name${NC} 热加载已在运行 (PID $(cat "$pidfile"))"
        return 0
    fi

    ensure_compile_daemon

    local bin_path="$BIN_DIR/$bin_name"
    local build_cmd="cd '$CTL_DIR' && go build -o '$bin_path' './$main'"
    local run_cmd="'$bin_path' -conf-dir '$CONF_DIR'"
    local exclude_dir='.git,.idea,.vscode,tmp,node_modules,bin,dist'

    cd "$CTL_DIR"
    nohup "$COMPILE_DAEMON_BIN" \
        -graceful-kill=true \
        -exclude-dir="$exclude_dir" \
        -build="$build_cmd" \
        -command="$run_cmd" \
        > "$logfile" 2>&1 &
    local pid=$!
    echo "$pid" > "$pidfile"

    for i in $(seq 1 30); do
        if curl -sf "http://localhost:$port/metrics" > /dev/null 2>&1; then
            echo -e "  ${GREEN}$name${NC} 热加载启动成功 (PID $pid, metrics :$port)"
            echo "    log: $logfile"
            return 0
        fi
        sleep 1
    done

    echo -e "  ${RED}$name${NC} 热加载启动超时，查看日志: $logfile"
    return 1
}

stop_one() {
    local name=$1 pidfile=$2
    if is_running "$pidfile"; then
        local pid=$(cat "$pidfile")
        kill "$pid" 2>/dev/null
        # 等待进程退出
        for i in $(seq 1 10); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.5
        done
        kill -9 "$pid" 2>/dev/null || true
        rm -f "$pidfile"
        echo -e "  ${GREEN}$name${NC} 已停止"
    else
        rm -f "$pidfile"
        echo -e "  ${YELLOW}$name${NC} 未在运行"
    fi
}

status_one() {
    local name=$1 pidfile=$2 port=$3
    if is_running "$pidfile"; then
        local pid=$(cat "$pidfile")
        local metrics="DOWN"
        curl -sf "http://localhost:$port/metrics" > /dev/null 2>&1 && metrics="UP"
        echo -e "  ${GREEN}●${NC} $name  PID=$pid  metrics=:$port ($metrics)"
    else
        echo -e "  ${RED}○${NC} $name  未运行"
    fi
}

cmd_start() {
    ensure_local_conf
    echo "启动 CTL 三服务..."
    start_one "API"     "main/api"     "$PID_API"     "$LOG_API"     9591
    start_one "Service" "main/service" "$PID_SERVICE" "$LOG_SERVICE" 9592
    start_one "Bypass"  "main/bypass"  "$PID_BYPASS"  "$LOG_BYPASS"  9593
    print_startup_hints
}

cmd_dev_start() {
    ensure_local_conf
    echo "启动 CTL 三服务（热加载模式）..."
    start_dev_one "API"     "main/api"     "$PID_API_DEV"     "$LOG_API_DEV"     9591 "api-dev"
    start_dev_one "Service" "main/service" "$PID_SERVICE_DEV" "$LOG_SERVICE_DEV" 9592 "service-dev"
    start_dev_one "Bypass"  "main/bypass"  "$PID_BYPASS_DEV"  "$LOG_BYPASS_DEV"  9593 "bypass-dev"
    print_startup_hints
}

cmd_stop() {
    echo "停止 CTL 三服务..."
    stop_one "API"     "$PID_API"
    stop_one "Service" "$PID_SERVICE"
    stop_one "Bypass"  "$PID_BYPASS"
}

cmd_status() {
    echo "CTL 三服务状态:"
    status_one "API    " "$PID_API"     9591
    status_one "Service" "$PID_SERVICE" 9592
    status_one "Bypass " "$PID_BYPASS"  9593
}

cmd_dev_stop() {
    echo "停止 CTL 三服务（热加载模式）..."
    stop_one "API    " "$PID_API_DEV"
    stop_one "Service" "$PID_SERVICE_DEV"
    stop_one "Bypass " "$PID_BYPASS_DEV"
}

cmd_dev_status() {
    echo "CTL 三服务状态（热加载模式）:"
    status_one "API    " "$PID_API_DEV"     9591
    status_one "Service" "$PID_SERVICE_DEV" 9592
    status_one "Bypass " "$PID_BYPASS_DEV"  9593
}

cmd_logs() {
    local svc=${2:-all}
    case "$svc" in
        api)     tail -f "$LOG_API" ;;
        service) tail -f "$LOG_SERVICE" ;;
        bypass)  tail -f "$LOG_BYPASS" ;;
        all)     tail -f "$LOG_API" "$LOG_SERVICE" "$LOG_BYPASS" ;;
        *)       echo "用法: $0 logs [api|service|bypass|all]" ;;
    esac
}

cmd_dev_logs() {
    local svc=${2:-all}
    case "$svc" in
        api)     tail -f "$LOG_API_DEV" ;;
        service) tail -f "$LOG_SERVICE_DEV" ;;
        bypass)  tail -f "$LOG_BYPASS_DEV" ;;
        all)     tail -f "$LOG_API_DEV" "$LOG_SERVICE_DEV" "$LOG_BYPASS_DEV" ;;
        *)       echo "用法: $0 dev-logs [api|service|bypass|all]" ;;
    esac
}

case "${1:-help}" in
    start)   cmd_start ;;
    stop)    cmd_stop ;;
    restart) cmd_stop; sleep 1; cmd_start ;;
    status)  cmd_status ;;
    logs)    cmd_logs "$@" ;;
    dev-start)   cmd_dev_start ;;
    dev-stop)    cmd_dev_stop ;;
    dev-restart) cmd_dev_stop; sleep 1; cmd_dev_start ;;
    dev-status)  cmd_dev_status ;;
    dev-logs)    cmd_dev_logs "$@" ;;
    *)
        echo "用法: $0 {start|stop|restart|status|logs|dev-start|dev-stop|dev-restart|dev-status|dev-logs}"
        echo ""
        echo "普通模式:"
        echo "  start       启动 API + Service + Bypass"
        echo "  stop        停止所有"
        echo "  restart     重启所有"
        echo "  status      查看状态"
        echo "  logs        查看日志 (logs [api|service|bypass|all])"
        echo ""
        echo "热加载模式:"
        echo "  dev-start   使用 CompileDaemon 启动 API + Service + Bypass"
        echo "  dev-stop    停止热加载模式"
        echo "  dev-restart 重启热加载模式"
        echo "  dev-status  查看热加载模式状态"
        echo "  dev-logs    查看热加载日志 (dev-logs [api|service|bypass|all])"
        ;;
esac
