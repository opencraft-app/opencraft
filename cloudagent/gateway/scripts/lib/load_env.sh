#!/usr/bin/env bash

load_cloudagent_env() {
  local caller_root="$1"
  local repo_root
  local candidate

  if [ "${CLOUDAGENT_SKIP_ENV_FILE:-0}" = "1" ]; then
    if [ -z "${GATEWAY_AGS_TEMPLATE:-}" ] && [ -n "${RESPONSES_WRAPPER_AGS_TEMPLATE:-}" ]; then
      export GATEWAY_AGS_TEMPLATE="$RESPONSES_WRAPPER_AGS_TEMPLATE"
    fi
    return 0
  fi

  repo_root="$(cd "$caller_root/.." && pwd)"

  for candidate in "$repo_root/.env" "$caller_root/.env"; do
    if [ -f "$candidate" ]; then
      set -a
      # shellcheck disable=SC1090
      . "$candidate"
      set +a
      export CLOUDAGENT_ENV_FILE="$candidate"
      if [ -z "${GATEWAY_AGS_TEMPLATE:-}" ] && [ -n "${RESPONSES_WRAPPER_AGS_TEMPLATE:-}" ]; then
        export GATEWAY_AGS_TEMPLATE="$RESPONSES_WRAPPER_AGS_TEMPLATE"
      fi
      return 0
    fi
  done

  if [ -z "${GATEWAY_AGS_TEMPLATE:-}" ] && [ -n "${RESPONSES_WRAPPER_AGS_TEMPLATE:-}" ]; then
    export GATEWAY_AGS_TEMPLATE="$RESPONSES_WRAPPER_AGS_TEMPLATE"
  fi

  return 0
}
