#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
COMPOSE_FILE=${COMPOSE_FILE:-"$ROOT_DIR/docker-compose.e2e.yml"}
API_URL=${API_URL:-"http://localhost:8080"}
KEEP_COMPOSE=${KEEP_COMPOSE:-false}
SECRET_ENV=${SECRET_ENV:-"$ROOT_DIR/../.secret/sandbox/local.env"}

if command -v docker >/dev/null 2>&1; then
  if docker compose version >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker compose)
  elif command -v docker-compose >/dev/null 2>&1; then
    DOCKER_COMPOSE=(docker-compose)
  else
    echo "docker compose not found" >&2
    exit 1
  fi
else
  echo "docker not found" >&2
  exit 1
fi

if ! command -v curl >/dev/null 2>&1; then
  echo "curl not found" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq not found" >&2
  exit 1
fi

if [[ ! -f "$SECRET_ENV" ]]; then
  echo "missing $SECRET_ENV" >&2
  echo "copy sandbox/secret-templates/local.env.example and ask the team for real values" >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "$SECRET_ENV"
set +a

cleanup() {
  if [[ "$KEEP_COMPOSE" != "true" ]]; then
    "${DOCKER_COMPOSE[@]}" -f "$COMPOSE_FILE" down -v --remove-orphans
  fi
}
trap cleanup EXIT

"${DOCKER_COMPOSE[@]}" -f "$COMPOSE_FILE" up -d --build

echo "waiting for api..."
for _ in {1..120}; do

  if curl -fsS "$API_URL/pools" >/dev/null; then
    break
  fi
  echo curl -fsS "$API_URL/pools" >/dev/null
  sleep 1
done

if ! curl -fsS "$API_URL/pools" >/dev/null; then
  echo "api not ready" >&2
  exit 1
fi

echo "creating pool..."
pool_json=$(curl -fsS -X POST "$API_URL/pools" \
  -H 'Content-Type: application/json' \
  -d '{"name":"e2e-pool","description":"e2e","base_image":"img-21kiggw2","desired_capacity":1}')

pool_id=$(echo "$pool_json" | jq -r '.id')
if [[ -z "$pool_id" || "$pool_id" == "null" ]]; then
  echo "failed to create pool: $pool_json" >&2
  exit 1
fi

echo "waiting for CLEAN inventory..."
clean_id=""
for _ in {1..60}; do
  clean_id=$(curl -fsS "$API_URL/pools/$pool_id/instances" | jq -r '.[] | select(.state=="CLEAN") | .id' | head -n1)
  if [[ -n "$clean_id" && "$clean_id" != "null" ]]; then
    break
  fi
  sleep 1
done

if [[ -z "$clean_id" || "$clean_id" == "null" ]]; then
  echo "no CLEAN instance after refill" >&2
  exit 1
fi

echo "allocating instance..."
alloc_json=$(curl -fsS -X POST "$API_URL/pools/$pool_id/allocate")
alloc_id=$(echo "$alloc_json" | jq -r '.id')
alloc_state=$(echo "$alloc_json" | jq -r '.state')
if [[ "$alloc_state" != "ALLOCATED" ]]; then
  echo "unexpected allocate state: $alloc_json" >&2
  exit 1
fi

echo "releasing instance..."
release_json=$(curl -fsS -X POST "$API_URL/instances/$alloc_id/release")
release_state=$(echo "$release_json" | jq -r '.state')
if [[ "$release_state" != "DRY" ]]; then
  echo "unexpected release state: $release_json" >&2
  exit 1
fi

echo "waiting for CLEAN after reset..."
final_state=""
for _ in {1..90}; do
  final_state=$(curl -fsS "$API_URL/pools/$pool_id/instances" | jq -r --arg id "$alloc_id" '.[] | select(.id==$id) | .state')
  if [[ "$final_state" == "CLEAN" ]]; then
    break
  fi
  sleep 1
done

if [[ "$final_state" != "CLEAN" ]]; then
  echo "instance did not return to CLEAN: $final_state" >&2
  exit 1
fi

echo "e2e ok"
