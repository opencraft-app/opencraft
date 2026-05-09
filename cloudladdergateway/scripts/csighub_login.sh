#!/usr/bin/env bash
set -euo pipefail

REGISTRY_HOST="${REGISTRY_HOST:-csighub.tencentyun.com}"
CSIGHUB_ENV_FILE="${CSIGHUB_ENV_FILE:-}"

load_allowed_env_file() {
  local env_file="$1"
  [[ -f "$env_file" ]] || {
    echo "CSIGHUB_ENV_FILE does not exist: $env_file" >&2
    exit 1
  }

  local line key value
  while IFS= read -r line; do
    [[ "$line" =~ ^export[[:space:]]+([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]] || continue
    key="${BASH_REMATCH[1]}"
    case "$key" in
      CSIGHUB_USERNAME|CSIGHUB_PASSWORD|TCR_USERNAME|TCR_PASSWORD|TENCENTCLOUD_SECRET_ID|TENCENTCLOUD_SECRET_KEY|TC_REGION|TCR_INSTANCEID|REGISTRY_NAME)
        value="${BASH_REMATCH[2]}"
        value="${value%$'\r'}"
        if [[ "$value" == \"*\" && "$value" == *\" ]]; then
          value="${value:1:${#value}-2}"
        elif [[ "$value" == \'*\' && "$value" == *\' ]]; then
          value="${value:1:${#value}-2}"
        fi
        export "$key=$value"
        ;;
    esac
  done < "$env_file"
}

login_with_password() {
  local username="$1"
  local password="$2"
  printf '%s' "$password" | docker login "$REGISTRY_HOST" --username "$username" --password-stdin >/dev/null
  printf 'Logged in to %s as %s\n' "$REGISTRY_HOST" "$username"
}

login_with_tencentcloud_token() {
  local region="${TC_REGION:-ap-beijing}"
  local registry_id="${TCR_INSTANCEID:-}"

  [[ -n "$registry_id" ]] || {
    echo "TCR_INSTANCEID is required for Tencent Cloud token login" >&2
    exit 1
  }
  [[ -n "${TENCENTCLOUD_SECRET_ID:-}" && -n "${TENCENTCLOUD_SECRET_KEY:-}" ]] || {
    echo "TENCENTCLOUD_SECRET_ID and TENCENTCLOUD_SECRET_KEY are required for Tencent Cloud token login" >&2
    exit 1
  }
  command -v tccli >/dev/null || {
    echo "tccli is required for Tencent Cloud token login" >&2
    exit 1
  }

  local token_json username token
  token_json="$(tccli tcr CreateInstanceToken \
    --RegistryId "$registry_id" \
    --TokenType temp \
    --region "$region")"
  username="$(printf '%s' "$token_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Username"])')"
  token="$(printf '%s' "$token_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["Token"])')"
  login_with_password "$username" "$token"
}

if [[ -n "$CSIGHUB_ENV_FILE" ]]; then
  load_allowed_env_file "$CSIGHUB_ENV_FILE"
fi

if [[ -n "${CSIGHUB_USERNAME:-}" && -n "${CSIGHUB_PASSWORD:-}" ]]; then
  login_with_password "$CSIGHUB_USERNAME" "$CSIGHUB_PASSWORD"
elif [[ -n "${TCR_USERNAME:-}" && -n "${TCR_PASSWORD:-}" ]]; then
  login_with_password "$TCR_USERNAME" "$TCR_PASSWORD"
else
  login_with_tencentcloud_token
fi
