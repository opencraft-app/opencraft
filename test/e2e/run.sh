#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PROJECT="${LLMGATEWAY_E2E_PROJECT:-llmgateway-e2e}"
COMPOSE_FILE="$ROOT_DIR/test/e2e/compose.yaml"
STATE_FILE="$ROOT_DIR/test/e2e/.tmp/restart-state.json"
ENV_FILE="${LLMGATEWAY_E2E_ENV_FILE:-$ROOT_DIR/test/e2e/.env.local}"

cd "$ROOT_DIR"
mkdir -p "$(dirname "$STATE_FILE")"
rm -f "$STATE_FILE"

if [[ -f "$ENV_FILE" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "$ENV_FILE"
  set +a
fi

E2E_LIVE_ENV=()
for name in LLMGATEWAY_LIVE_API_KEY LLMGATEWAY_LIVE_BASE_URL LLMGATEWAY_LIVE_MODEL; do
  if [[ -n "${!name:-}" ]]; then
    E2E_LIVE_ENV+=("-e" "$name=${!name}")
  fi
done

cleanup() {
  rm -f "$STATE_FILE" "$STATE_FILE".ready.out "$STATE_FILE".slow.out
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down -v --remove-orphans
}
dump_logs() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -a || true
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" logs --no-color --tail=200 llmgateway llmgateway-control llmgateway-traffic llmgateway-worker llmgateway-worker-byok llmgateway-worker-observer newapi-a newapi-b || true
}
dump_llmgateway_container() {
  local cid="${1:-}"
  if [[ -z "$cid" ]]; then
    cid="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -q llmgateway 2>/dev/null || true)"
  fi
  if [[ -z "$cid" ]]; then
    return 0
  fi
  docker inspect "$cid" \
    --format 'llmgateway inspect: running={{.State.Running}} status={{.State.Status}} exit={{.State.ExitCode}} started={{.State.StartedAt}} finished={{.State.FinishedAt}} pid={{.State.Pid}}' || true
  docker logs --tail=80 "$cid" 2>&1 || true
}
run_e2e_client() {
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm -T --no-deps e2e sh -c "$1"
}
run_initial_e2e() {
  local cmd=(
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm
    -e LLMGATEWAY_E2E=1
    -e LLMGATEWAY_E2E_CLUSTER=/src/test/e2e/cluster.compose.yaml
    -e LLMGATEWAY_E2E_STATE_FILE=/src/test/e2e/.tmp/restart-state.json
  )
  if [[ ${#E2E_LIVE_ENV[@]} -gt 0 ]]; then
    cmd+=("${E2E_LIVE_ENV[@]}")
  fi
  cmd+=(e2e)
  "${cmd[@]}"
}
wait_for_e2e_inflight() {
  run_e2e_client '
    i=0
    while [ "$i" -lt 100 ]; do
      count="$(wget -q -O - http://llmgateway:18080/_llmgateway_e2e/inflight 2>/dev/null || true)"
      if [ "$count" = "1" ]; then
        exit 0
      fi
      i=$((i + 1))
      sleep 0.05
    done
    echo "timed out waiting for e2e slow request to become in-flight" >&2
    exit 1
  '
}
wait_for_readyz_draining() {
  run_e2e_client '
    i=0
    while [ "$i" -lt 100 ]; do
      output="$(wget -S -O - http://llmgateway:18080/readyz 2>&1 || true)"
      if echo "$output" | grep -q "HTTP/.* 503"; then
        exit 0
      fi
      i=$((i + 1))
      sleep 0.05
    done
    echo "timed out waiting for /readyz to report draining" >&2
    exit 1
  '
}
wait_for_file_contains() {
  local file="$1"
  local pattern="$2"
  local description="$3"
  for _ in $(seq 1 100); do
    if [[ -f "$file" ]] && grep -q "$pattern" "$file"; then
      return 0
    fi
    sleep 0.05
  done
  echo "timed out waiting for $description" >&2
  cat "$file" >&2 2>/dev/null || true
  return 1
}
run_sigterm_drain_e2e() {
  # 覆盖真实容器停机路径：慢请求在途 -> SIGTERM -> readyz 503 -> 慢请求完成 -> 进程 0 退出。
  local slow_output="$STATE_FILE.slow.out"
  local ready_output="$STATE_FILE.ready.out"
  rm -f "$slow_output" "$ready_output"

  run_e2e_client '
    echo readyz-watcher-started
    last_status=""
    i=0
    while [ "$i" -lt 200 ]; do
      output="$(wget -S -O - http://llmgateway:18080/readyz 2>&1 || true)"
      status="$(echo "$output" | sed -n "s/^  HTTP\\/.* \\([0-9][0-9][0-9]\\).*/\\1/p" | tail -n 1)"
      if [ -n "$status" ] && [ "$status" != "$last_status" ]; then
        echo "readyz-status=$status"
        last_status="$status"
      fi
      if [ "$status" = "503" ]; then
        echo readyz-draining-observed
        exit 0
      fi
      i=$((i + 1))
      sleep 0.05
    done
    echo "timed out waiting for /readyz to report draining" >&2
    exit 1
  ' >"$ready_output" 2>&1 &
  local ready_pid=$!
  wait_for_file_contains "$ready_output" "readyz-watcher-started" "readyz watcher to start"

  run_e2e_client "wget -q -O - 'http://llmgateway:18080/_llmgateway_e2e/sleep?duration=1500ms'" >"$slow_output" &
  local slow_pid=$!
  wait_for_e2e_inflight

  local cid
  cid="$(docker compose -p "$PROJECT" -f "$COMPOSE_FILE" ps -q llmgateway)"
  docker exec "$cid" kill -TERM 1
  if ! wait "$ready_pid"; then
    echo "readyz watcher failed:" >&2
    cat "$ready_output" >&2 2>/dev/null || true
    dump_llmgateway_container "$cid" >&2
    return 1
  fi

  wait "$slow_pid"
  if [[ "$(cat "$slow_output")" != "done" ]]; then
    echo "slow request did not complete cleanly: $(cat "$slow_output" 2>/dev/null || true)" >&2
    return 1
  fi

  local exit_code
  exit_code="$(docker wait "$cid")"
  if [[ "$exit_code" != "0" ]]; then
    echo "llmgateway exited with code $exit_code after SIGTERM" >&2
    return 1
  fi

  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --wait llmgateway llmgateway-control llmgateway-traffic llmgateway-worker llmgateway-worker-byok llmgateway-worker-observer
}
cleanup
trap 'status=$?; if [[ $status -ne 0 ]]; then dump_logs; fi; cleanup; exit $status' EXIT

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --build --wait llmgateway llmgateway-control llmgateway-traffic llmgateway-worker llmgateway-worker-byok llmgateway-worker-observer

run_initial_e2e

run_sigterm_drain_e2e

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" restart llmgateway
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --wait llmgateway llmgateway-control llmgateway-traffic llmgateway-worker llmgateway-worker-byok llmgateway-worker-observer

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm \
  -e LLMGATEWAY_E2E=1 \
  -e LLMGATEWAY_E2E_AFTER_RESTART=1 \
  -e LLMGATEWAY_E2E_CLUSTER=/src/test/e2e/cluster.compose.yaml \
  -e LLMGATEWAY_E2E_STATE_FILE=/src/test/e2e/.tmp/restart-state.json \
  e2e go test -tags=integration ./test/e2e -count=1 -v -run TestReproducibleComposeClusterStateSurvivesGatewayRestart

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" restart llmgateway-traffic
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --wait llmgateway-traffic

docker compose -p "$PROJECT" -f "$COMPOSE_FILE" run --rm \
  -e LLMGATEWAY_E2E=1 \
  -e LLMGATEWAY_E2E_AFTER_TRAFFIC_RESTART=1 \
  -e LLMGATEWAY_E2E_CLUSTER=/src/test/e2e/cluster.compose.yaml \
  -e LLMGATEWAY_E2E_STATE_FILE=/src/test/e2e/.tmp/restart-state.json \
  e2e go test -tags=integration ./test/e2e -count=1 -v -run TestReproducibleComposeSplitTrafficSurvivesTrafficRestart
