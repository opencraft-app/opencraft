#!/bin/bash
# 脚本定义:
#   统一管理 ctl 本地开发环境，覆盖依赖容器、sandbox port-forward、
#   ctl 三服务热加载、migration、seed、reset-db。
#   目标是提供单一入口，避免本地联调同时记多个脚本。
#
# 参数定义:
#   start/stop/logs/status/restart
#     仅管理本地 MySQL + Redis 依赖。
#   pf-start/pf-stop/pf-status
#     管理 sandbox-api / ingressproxy-router 的本地 port-forward。
#   app-start/app-stop/app-status/app-logs/app-restart
#     管理 ctl api/service/bypass 三服务热加载。
#   up/down/restart-all
#     一键管理 dependencies + port-forward + ctl 热加载三服务。
#   migrate/seed-quota/reset-db
#     管理本地数据库 schema 与默认配额。
#
# 输出结果定义:
#   stdout 打印关键步骤、PID、日志路径和本地端口。
#   退出码 0 表示成功，非 0 表示失败。
#   port-forward 和 app 热加载的日志 / pid 全部落在 /tmp/ctl-local。
#
# 用法:
#   ./ctl/conf/local/dev.sh up
#   ./ctl/conf/local/dev.sh app-logs api
#   ./ctl/conf/local/dev.sh pf-status
#   ./ctl/conf/local/dev.sh down

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
CTL_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
MONO_DIR="$(cd "$CTL_DIR/.." && pwd)"
RENDER_SCRIPT="$CTL_DIR/scripts/render-secrets.sh"
LOCAL_SECRET_ENV="$MONO_DIR/.secret/ctl/local.env"
RENDERED_LOCAL_ROOT="${TMPDIR:-/tmp}/mono-rendered/ctl/local"
COMPOSE_FILE="$RENDERED_LOCAL_ROOT/docker-compose.yml"
PROJECT_NAME="ctl-dev"
MYSQL_VOLUME="${PROJECT_NAME}_${PROJECT_NAME}-mysql-data"
REDIS_VOLUME="${PROJECT_NAME}_${PROJECT_NAME}-redis-data"
LOCAL_RUN_DIR="/tmp/ctl-local"
BIN_DIR="$LOCAL_RUN_DIR/bin"

PF_API_PID="$LOCAL_RUN_DIR/port-forward-sandbox-api.pid"
PF_PROCESS_PID="$LOCAL_RUN_DIR/port-forward-ingressproxy-router.pid"
PF_API_LOG="$LOCAL_RUN_DIR/port-forward-sandbox-api.log"
PF_PROCESS_LOG="$LOCAL_RUN_DIR/port-forward-ingressproxy-router.log"

PID_API_DEV="$LOCAL_RUN_DIR/api-dev.pid"
PID_SERVICE_DEV="$LOCAL_RUN_DIR/service-dev.pid"
PID_BYPASS_DEV="$LOCAL_RUN_DIR/bypass-dev.pid"
LOG_API_DEV="$LOCAL_RUN_DIR/api-dev.log"
LOG_SERVICE_DEV="$LOCAL_RUN_DIR/service-dev.log"
LOG_BYPASS_DEV="$LOCAL_RUN_DIR/bypass-dev.log"

DEFAULT_KUBECONFIG="$MONO_DIR/.secret/cls-8gnhos9p-config"
SANDBOX_NAMESPACE="${SANDBOX_NAMESPACE:-sandbox}"
SANDBOX_API_SERVICE="${SANDBOX_API_SERVICE:-svc/sandbox-api}"
SANDBOX_PROCESS_SERVICE="${SANDBOX_PROCESS_SERVICE:-svc/ingressproxy-router}"
SANDBOX_API_PORT="${SANDBOX_API_PORT:-18081}"
SANDBOX_PROCESS_PORT="${SANDBOX_PROCESS_PORT:-18082}"
KUBECONFIG_PATH="${KUBECONFIG:-}"
GOBIN_DIR="${GOBIN:-$(go env GOPATH)/bin}"
COMPILE_DAEMON_BIN="$GOBIN_DIR/CompileDaemon"

if [[ -z "$KUBECONFIG_PATH" || ! -f "$KUBECONFIG_PATH" ]]; then
    KUBECONFIG_PATH="$DEFAULT_KUBECONFIG"
fi

mkdir -p "$LOCAL_RUN_DIR" "$BIN_DIR"

color_green()  { echo -e "\033[0;32m$*\033[0m"; }
color_yellow() { echo -e "\033[0;33m$*\033[0m"; }
color_red()    { echo -e "\033[0;31m$*\033[0m"; }
color_blue()   { echo -e "\033[0;34m$*\033[0m"; }

ensure_local_runtime() {
    if [[ ! -x "$RENDER_SCRIPT" ]]; then
        color_red "Error: render script not found or not executable: $RENDER_SCRIPT"
        exit 1
    fi

    "$RENDER_SCRIPT" --env local >/dev/null

    if [[ ! -f "$LOCAL_SECRET_ENV" ]]; then
        color_red "Error: secret file not found: $LOCAL_SECRET_ENV"
        color_red "Ask the team for the .secret directory package before running ctl."
        exit 1
    fi

    set -a
    # shellcheck disable=SC1090
    source "$LOCAL_SECRET_ENV"
    set +a
}

ensure_local_compose_file() {
    if [[ -f "$COMPOSE_FILE" ]]; then
        return 0
    fi
    ensure_local_runtime
}

is_pid_running() {
    local pidfile=$1
    [[ -f "$pidfile" ]] && kill -0 "$(cat "$pidfile")" 2>/dev/null
}

port_listening() {
    local port=$1
    ss -ltn "( sport = :$port )" 2>/dev/null | grep -q ":$port"
}

check_docker() {
    if ! command -v docker &>/dev/null; then
        color_red "Error: docker is not installed"
        exit 1
    fi
    if ! docker compose version &>/dev/null 2>&1; then
        if ! docker-compose version &>/dev/null 2>&1; then
            color_red "Error: docker-compose is not available"
            exit 1
        fi
        COMPOSE_CMD="docker-compose"
    else
        COMPOSE_CMD="docker compose"
    fi
}

check_kubectl() {
    if ! command -v kubectl &>/dev/null; then
        color_red "Error: kubectl is not installed"
        exit 1
    fi
    if [[ ! -f "$KUBECONFIG_PATH" ]]; then
        color_red "Error: kubeconfig not found: $KUBECONFIG_PATH"
        exit 1
    fi
}

ensure_compile_daemon() {
    if [[ -x "$COMPILE_DAEMON_BIN" ]]; then
        return 0
    fi

    color_blue "CompileDaemon not found, installing to $COMPILE_DAEMON_BIN ..."
    (
        cd "$CTL_DIR"
        GOBIN="$GOBIN_DIR" go install github.com/githubnemo/CompileDaemon@latest
    )

    if [[ ! -x "$COMPILE_DAEMON_BIN" ]]; then
        color_red "Error: failed to install CompileDaemon"
        exit 1
    fi
}

do_start() {
    ensure_local_runtime
    check_docker
    color_green "Starting ctl local dependencies..."

    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" up -d

    echo ""
    color_green "Waiting for services to be healthy..."
    wait_for_mysql
    wait_for_redis

    echo ""
    color_green "=== ctl local dependencies ready ==="
    echo "  MySQL: 127.0.0.1:13306"
    echo "  Redis: 127.0.0.1:16379"
    echo ""
    color_yellow "Next:"
    echo "  cd $CTL_DIR && ./conf/local/dev.sh up"
}

do_stop() {
    ensure_local_compose_file
    check_docker
    color_yellow "Stopping ctl local dependencies..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" down
    color_green "Dependencies stopped."
}

do_logs() {
    ensure_local_compose_file
    check_docker
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" logs -f --tail=50
}

do_status() {
    ensure_local_compose_file
    check_docker
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" ps
}

do_restart() {
    do_stop
    sleep 2
    do_start
}

start_port_forward() {
    local name=$1 service_ref=$2 local_port=$3 remote_port=$4 pidfile=$5 logfile=$6

    if is_pid_running "$pidfile"; then
        color_yellow "$name port-forward already running (PID $(cat "$pidfile"))"
        return 0
    fi
    if port_listening "$local_port"; then
        color_yellow "$name local port $local_port is already listening; skip new port-forward"
        return 0
    fi

    nohup env KUBECONFIG="$KUBECONFIG_PATH" \
        kubectl port-forward -n "$SANDBOX_NAMESPACE" "$service_ref" "$local_port:$remote_port" \
        >"$logfile" 2>&1 &
    local pid=$!
    echo "$pid" > "$pidfile"

    for _ in $(seq 1 20); do
        if port_listening "$local_port"; then
            color_green "$name port-forward ready on :$local_port (PID $pid)"
            return 0
        fi
        sleep 1
    done

    color_red "Error: $name port-forward startup timed out, log: $logfile"
    return 1
}

stop_port_forward() {
    local name=$1 pidfile=$2
    if is_pid_running "$pidfile"; then
        local pid
        pid=$(cat "$pidfile")
        kill "$pid" 2>/dev/null || true
        for _ in $(seq 1 10); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.5
        done
        kill -9 "$pid" 2>/dev/null || true
        rm -f "$pidfile"
        color_green "$name port-forward stopped"
        return 0
    fi
    rm -f "$pidfile"
    color_yellow "$name port-forward not running"
}

show_port_forward_status() {
    local name=$1 pidfile=$2 port=$3
    if is_pid_running "$pidfile"; then
        color_green "  [UP] $name pid=$(cat "$pidfile") local_port=:$port"
        return 0
    fi
    if port_listening "$port"; then
        color_yellow "  [BUSY] $name local_port=:$port is listening, but not owned by this script"
        return 0
    fi
    color_red "  [DOWN] $name local_port=:$port"
}

do_pf_start() {
    check_kubectl
    color_green "Starting sandbox port-forward..."
    color_blue "Using KUBECONFIG=$KUBECONFIG_PATH"
    start_port_forward "sandbox-api" "$SANDBOX_API_SERVICE" "$SANDBOX_API_PORT" 80 "$PF_API_PID" "$PF_API_LOG"
    start_port_forward "ingressproxy-router" "$SANDBOX_PROCESS_SERVICE" "$SANDBOX_PROCESS_PORT" 80 "$PF_PROCESS_PID" "$PF_PROCESS_LOG"
}

do_pf_stop() {
    color_yellow "Stopping sandbox port-forward..."
    stop_port_forward "sandbox-api" "$PF_API_PID"
    stop_port_forward "ingressproxy-router" "$PF_PROCESS_PID"
}

do_pf_status() {
    echo "Sandbox port-forward status:"
    show_port_forward_status "sandbox-api" "$PF_API_PID" "$SANDBOX_API_PORT"
    show_port_forward_status "ingressproxy-router" "$PF_PROCESS_PID" "$SANDBOX_PROCESS_PORT"
}

start_app_dev_one() {
    local name=$1 main=$2 pidfile=$3 logfile=$4 port=$5 bin_name=$6

    if is_pid_running "$pidfile"; then
        color_yellow "$name hot-reload already running (PID $(cat "$pidfile"))"
        return 0
    fi

    ensure_compile_daemon

    local bin_path="$BIN_DIR/$bin_name"
    local wrapper_path="$BIN_DIR/run-$bin_name.sh"
    local build_cmd="go build -o $bin_path ./$main"
    local run_cmd="$wrapper_path"
    local exclude_dir='.git,.idea,.vscode,tmp,node_modules,bin,dist'

    cat >"$wrapper_path" <<EOF
#!/usr/bin/env bash
exec "$bin_path" -conf-dir "$RENDERED_LOCAL_ROOT"
EOF
    chmod +x "$wrapper_path"

    (
        cd "$CTL_DIR"
        nohup "$COMPILE_DAEMON_BIN" \
            -graceful-kill=true \
            -exclude-dir="$exclude_dir" \
            -build="$build_cmd" \
            -command="$run_cmd" \
            >"$logfile" 2>&1 &
        echo $! > "$pidfile"
    )

    local pid
    pid=$(cat "$pidfile")
    for _ in $(seq 1 30); do
        if curl -sf "http://localhost:$port/metrics" >/dev/null 2>&1; then
            color_green "$name hot-reload ready on metrics :$port (PID $pid)"
            return 0
        fi
        sleep 1
    done

    color_red "Error: $name hot-reload startup timed out, log: $logfile"
    return 1
}

stop_app_dev_one() {
    local name=$1 pidfile=$2
    if is_pid_running "$pidfile"; then
        local pid
        pid=$(cat "$pidfile")
        kill "$pid" 2>/dev/null || true
        for _ in $(seq 1 10); do
            kill -0 "$pid" 2>/dev/null || break
            sleep 0.5
        done
        kill -9 "$pid" 2>/dev/null || true
        rm -f "$pidfile"
        color_green "$name hot-reload stopped"
        return 0
    fi
    rm -f "$pidfile"
    color_yellow "$name hot-reload not running"
}

show_app_dev_status_one() {
    local name=$1 pidfile=$2 port=$3
    if is_pid_running "$pidfile"; then
        local metrics="DOWN"
        curl -sf "http://localhost:$port/metrics" >/dev/null 2>&1 && metrics="UP"
        color_green "  [UP] $name pid=$(cat "$pidfile") metrics=:$port ($metrics)"
        return 0
    fi
    color_red "  [DOWN] $name metrics=:$port"
}

do_app_start() {
    ensure_local_runtime
    color_green "Starting ctl hot-reload services..."
    start_app_dev_one "api" "main/api" "$PID_API_DEV" "$LOG_API_DEV" 9591 "api-dev"
    start_app_dev_one "service" "main/service" "$PID_SERVICE_DEV" "$LOG_SERVICE_DEV" 9592 "service-dev"
    start_app_dev_one "bypass" "main/bypass" "$PID_BYPASS_DEV" "$LOG_BYPASS_DEV" 9593 "bypass-dev"
}

do_app_stop() {
    color_yellow "Stopping ctl hot-reload services..."
    stop_app_dev_one "api" "$PID_API_DEV"
    stop_app_dev_one "service" "$PID_SERVICE_DEV"
    stop_app_dev_one "bypass" "$PID_BYPASS_DEV"
}

do_app_status() {
    echo "CTL hot-reload services status:"
    show_app_dev_status_one "api" "$PID_API_DEV" 9591
    show_app_dev_status_one "service" "$PID_SERVICE_DEV" 9592
    show_app_dev_status_one "bypass" "$PID_BYPASS_DEV" 9593
}

do_app_logs() {
    local svc=${2:-all}
    case "$svc" in
        api) tail -f "$LOG_API_DEV" ;;
        service) tail -f "$LOG_SERVICE_DEV" ;;
        bypass) tail -f "$LOG_BYPASS_DEV" ;;
        all) tail -f "$LOG_API_DEV" "$LOG_SERVICE_DEV" "$LOG_BYPASS_DEV" ;;
        *)
            echo "Usage: $0 app-logs [api|service|bypass|all]"
            exit 1
            ;;
    esac
}

do_migrate() {
    ensure_local_runtime
    check_docker
    color_green "Applying ctl migrations to local MySQL..."
    local max_attempts=10
    local i=0
    while [ $i -lt $max_attempts ]; do
        if (cd "$CTL_DIR" && make migrate-up-local); then
            color_green "Local migrations applied."
            return 0
        fi
        i=$((i + 1))
        color_yellow "Migration attempt ${i}/${max_attempts} failed, retrying..."
        sleep 2
    done
    color_red "Error: failed to apply local migrations after ${max_attempts} attempts"
    exit 1
}

do_seed_quota() {
    ensure_local_runtime
    check_docker
    color_green "Seeding local quota for default dev user..."
    (cd "$CTL_DIR" && make seed-local-quota)
    color_green "Local quota seeded."
}

do_reset_db() {
    check_docker
    color_yellow "Resetting local MySQL/Redis volumes..."
    $COMPOSE_CMD -f "$COMPOSE_FILE" -p "$PROJECT_NAME" down
    docker volume rm -f "$MYSQL_VOLUME" "$REDIS_VOLUME" >/dev/null 2>&1 || true
    do_start
    do_migrate
    do_seed_quota
    echo ""
    color_green "=== ctl local database reset complete ==="
}

do_up() {
    do_start
    do_pf_start
    do_app_start
    echo ""
    color_green "=== ctl local full environment ready ==="
    echo "  API health:         http://127.0.0.1:9590/health"
    echo "  Sandbox API PF:     http://127.0.0.1:${SANDBOX_API_PORT}/health"
    echo "  Sandbox Process PF: http://127.0.0.1:${SANDBOX_PROCESS_PORT}"
    echo ""
    color_yellow "Logs:"
    echo "  cd $CTL_DIR && ./conf/local/dev.sh app-logs api"
}

do_down() {
    color_yellow "Stopping ctl local full environment..."
    do_app_stop || true
    do_pf_stop
    do_stop
}

wait_for_mysql() {
    local max_attempts=30
    local i=0
    while [ $i -lt $max_attempts ]; do
        if docker exec ctl-dev-mysql mysqladmin ping -h localhost --silent 2>/dev/null; then
            color_green "  [OK] MySQL is ready"
            return 0
        fi
        i=$((i + 1))
        printf "  ... waiting for MySQL (%d/%d)\r" "$i" "$max_attempts"
        sleep 1
    done
    echo ""
    color_red "Error: MySQL did not become ready in time"
    exit 1
}

wait_for_redis() {
    ensure_local_runtime
    local max_attempts=30
    local i=0
    while [ $i -lt $max_attempts ]; do
        if docker exec ctl-dev-redis redis-cli -a "$CTL_LOCAL_REDIS_PASSWORD" ping 2>/dev/null | grep -q PONG; then
            color_green "  [OK] Redis is ready"
            return 0
        fi
        i=$((i + 1))
        printf "  ... waiting for Redis (%d/%d)\r" "$i" "$max_attempts"
        sleep 1
    done
    echo ""
    color_red "Error: Redis did not become ready in time"
    exit 1
}

case "${1:-start}" in
    start) do_start ;;
    stop) do_stop ;;
    logs) do_logs ;;
    status) do_status ;;
    restart) do_restart ;;
    pf-start) do_pf_start ;;
    pf-stop) do_pf_stop ;;
    pf-status) do_pf_status ;;
    app-start) do_app_start ;;
    app-stop) do_app_stop ;;
    app-status) do_app_status ;;
    app-logs) do_app_logs "$@" ;;
    app-restart) do_app_stop; sleep 1; do_app_start ;;
    up) do_up ;;
    down) do_down ;;
    restart-all) do_down; sleep 2; do_up ;;
    migrate) do_migrate ;;
    seed-quota) do_seed_quota ;;
    reset-db) do_reset_db ;;
    *)
        cat <<EOF
Usage: $0 {start|stop|logs|status|restart|pf-start|pf-stop|pf-status|app-start|app-stop|app-status|app-logs|app-restart|up|down|restart-all|migrate|seed-quota|reset-db}

Description:
  start/stop/status/restart       Manage local MySQL + Redis only.
  pf-start/pf-stop/pf-status      Manage sandbox port-forward.
  app-start/app-stop/app-status   Manage ctl hot-reload services.
  app-logs/app-restart            Inspect or restart ctl hot-reload services.
  up/down/restart-all             One-command local stack control.
  migrate/seed-quota/reset-db     Database maintenance helpers.

Outputs:
  Port-forward logs:
    $PF_API_LOG
    $PF_PROCESS_LOG
  Hot-reload logs:
    $LOG_API_DEV
    $LOG_SERVICE_DEV
    $LOG_BYPASS_DEV

Examples:
  $0 up
  $0 app-status
  $0 pf-status
  $0 app-logs api
  $0 down
EOF
        exit 1
        ;;
esac
