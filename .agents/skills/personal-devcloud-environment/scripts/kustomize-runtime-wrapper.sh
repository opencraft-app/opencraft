#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REAL_KUSTOMIZE="${PERSONAL_DEV_REAL_KUSTOMIZE:?PERSONAL_DEV_REAL_KUSTOMIZE is required}"

if [[ "${1:-}" != "build" ]]; then
  exec "$REAL_KUSTOMIZE" "$@"
fi

args=("$@")
target="${args[${#args[@]}-1]}"
component="${target%/}"
component="${component##*/}"
case "$component" in
  auth | trade | ctl) ;;
  *) exec "$REAL_KUSTOMIZE" "$@" ;;
esac

site="${PERSONAL_DEV_RUNTIME_SITE:?PERSONAL_DEV_RUNTIME_SITE is required}"
public_host="${PERSONAL_DEV_RUNTIME_PUBLIC_HOST:?PERSONAL_DEV_RUNTIME_PUBLIC_HOST is required}"
protocol="${PERSONAL_DEV_RUNTIME_PROTOCOL:-http}"
gateway_url="$protocol://$public_host:8085"
frontend_url="$protocol://$public_host:5173"
fake_qq_url="$protocol://$public_host:19010"

if [[ "$site" == "intl" ]]; then
  jifei_user_id="${PERSONAL_DEV_RUNTIME_JIFEI_USER_ID:-450860000002}"
  trade_region="${PERSONAL_DEV_RUNTIME_TRADE_REGION:-ap-singapore}"
  shadow_platform=intlSaaSLightvela
elif [[ "$site" == "cn" ]]; then
  jifei_user_id="${PERSONAL_DEV_RUNTIME_JIFEI_USER_ID:-330500000003}"
  trade_region="${PERSONAL_DEV_RUNTIME_TRADE_REGION:-ap-guangzhou}"
  shadow_platform=lightvela
else
  printf 'runtime kustomize wrapper: unsupported site %s\n' "$site" >&2
  exit 1
fi

"$REAL_KUSTOMIZE" "$@" |
  python3 "$SCRIPT_DIR/render-runtime-config.py" \
    --component "$component" \
    --site "$site" \
    --public-host "$public_host" \
    --frontend-url "$frontend_url" \
    --gateway-url "$gateway_url" \
    --fake-qq-url "$fake_qq_url" \
    --jifei-gateway "${PERSONAL_DEV_RUNTIME_JIFEI_GATEWAY:?PERSONAL_DEV_RUNTIME_JIFEI_GATEWAY is required}" \
    --billing-apigw-url "${PERSONAL_DEV_RUNTIME_BILLING_APIGW_URL:?PERSONAL_DEV_RUNTIME_BILLING_APIGW_URL is required}" \
    --jifei-user-id "$jifei_user_id" \
    --trade-region "$trade_region" \
    --shadow-platform "$shadow_platform"
