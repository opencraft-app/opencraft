#!/usr/bin/env bash
set -euo pipefail

# Ensure script works even when invoked from another directory.
ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
cd "$ROOT_DIR"

API_BASE_URL=${API_BASE_URL:-http://127.0.0.1:8080}
PROCESS_BASE_URL=${PROCESS_BASE_URL:-http://21.255.92.10:16167} #http://127.0.0.1:8082}
TEMPLATE_ID=${TEMPLATE_ID:-pool-1}
SANDBOX_TIMEOUT=${SANDBOX_TIMEOUT:-3600}
ENVD_PORT=${ENVD_PORT:-49983}
SANDBOX_USER=${SANDBOX_USER:-root}
RUN_CMD=${RUN_CMD:-"df -h"}
PROCESS_TIMEOUT=${PROCESS_TIMEOUT:-30m}
REQUEST_TIMEOUT=${REQUEST_TIMEOUT:-30s}
IDLE_TIMEOUT=${IDLE_TIMEOUT:-60s}
LOOP=${LOOP:-true}
LOOP_INTERVAL=${LOOP_INTERVAL:-0s}
LOOP_MAX=${LOOP_MAX:-0}


ARGS=()
if [[ "$LOOP" == "true" ]]; then
  ARGS+=(-loop -loop-interval "$LOOP_INTERVAL" -loop-max "$LOOP_MAX")
fi

go run ./cmd/sandboxcli "${ARGS[@]}" \
  -api-base-url "$API_BASE_URL" \
  -template-id "$TEMPLATE_ID" \
  -sandbox-timeout "$SANDBOX_TIMEOUT" \
  -process-base-url "$PROCESS_BASE_URL" \
  -envd-port "$ENVD_PORT" \
  -user "$SANDBOX_USER" \
  -cmd "$RUN_CMD" \
  -process-timeout "$PROCESS_TIMEOUT" \
  -request-timeout "$REQUEST_TIMEOUT" \
  -idle-timeout "$IDLE_TIMEOUT" \
  -keep-on-error \
  "$@"
