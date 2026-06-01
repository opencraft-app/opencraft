#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

GO_BIN="${GO_BIN:-go}"
TEST_RUN='TestLocalRuntimeHostLinuxCommandPrefixE2E'

if [[ "$(uname -s)" == "Linux" && -z "${CLOUDAGENT_LOCAL_LINUX_COMMAND_PREFIX:-}" ]]; then
  echo "[e2e-local-runtime-host] using native Linux runtime host"
  shared_root="${CLOUDAGENT_LOCAL_LINUX_SHARED_ROOT:-$(mktemp -d "${TMPDIR:-/tmp}/cloudagent-local-linux-e2e.XXXXXX")}"
  cleanup_native() {
    if [[ -z "${CLOUDAGENT_LOCAL_LINUX_SHARED_ROOT:-}" ]]; then
      rm -rf "$shared_root"
    fi
  }
  trap cleanup_native EXIT
  CLOUDAGENT_LOCAL_RUNTIME_HOST_LINUX_E2E=1 \
  CLOUDAGENT_LOCAL_LINUX_SHARED_ROOT="$shared_root" \
  CLOUDAGENT_LOCAL_LINUX_COMMAND_PREFIX="env /bin/sh -lc" \
    "$GO_BIN" test -count=1 ./internal/wrapper -run "$TEST_RUN" -v
  exit 0
fi

if [[ -n "${CLOUDAGENT_LOCAL_LINUX_COMMAND_PREFIX:-}" ]]; then
  echo "[e2e-local-runtime-host] using provided CLOUDAGENT_LOCAL_LINUX_COMMAND_PREFIX"
  CLOUDAGENT_LOCAL_RUNTIME_HOST_LINUX_E2E=1 \
    "$GO_BIN" test -count=1 ./internal/wrapper -run "$TEST_RUN" -v
  exit 0
fi

if [[ "${CLOUDAGENT_LOCAL_RUNTIME_HOST_DOCKER:-}" != "1" ]]; then
  cat >&2 <<'EOF'
[e2e-local-runtime-host] local_wisp is Linux-native.

Run this target on a Linux host/VM, or provide a Linux command prefix, for example:

  CLOUDAGENT_LOCAL_LINUX_COMMAND_PREFIX='ssh cloudagent-vm /bin/sh -lc' \
  CLOUDAGENT_LOCAL_LINUX_SHARED_ROOT=/mnt/cloudagent-local-runtime \
  make e2e-local-runtime-host

Docker is only a compatibility runner for non-Linux developer machines. To use it explicitly:

  CLOUDAGENT_LOCAL_RUNTIME_HOST_DOCKER=1 make e2e-local-runtime-host
EOF
  exit 2
fi

if ! command -v docker >/dev/null 2>&1; then
  cat >&2 <<'EOF'
[e2e-local-runtime-host] docker compatibility runner was requested but docker is missing.

Install/start Docker, run this target on Linux, or provide a Linux command prefix, for example:

  CLOUDAGENT_LOCAL_LINUX_COMMAND_PREFIX='ssh cloudagent-vm /bin/sh -lc' make e2e-local-runtime-host

The prefix must execute commands in a Linux environment that can see
CLOUDAGENT_LOCAL_LINUX_SHARED_ROOT at the same absolute path as the host.
EOF
  exit 2
fi

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/cloudagent-local-linux-e2e.XXXXXX")"
container=""
cleanup() {
  if [[ -n "$container" ]]; then
    docker rm -f "$container" >/dev/null 2>&1 || true
  fi
  rm -rf "$work_dir"
}
trap cleanup EXIT

container="$(docker run -d --rm \
  -v "$work_dir:$work_dir" \
  -w "$work_dir" \
  alpine:3.20 \
  sleep 3600)"

echo "[e2e-local-runtime-host] docker container=$container shared_root=$work_dir"
CLOUDAGENT_LOCAL_RUNTIME_HOST_LINUX_E2E=1 \
CLOUDAGENT_LOCAL_LINUX_SHARED_ROOT="$work_dir" \
CLOUDAGENT_LOCAL_LINUX_COMMAND_PREFIX="docker exec $container /bin/sh -lc" \
  "$GO_BIN" test -count=1 ./internal/wrapper -run "$TEST_RUN" -v
