#!/usr/bin/env bash
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

KUBECONFIG_ARG=()
if [[ -n "${KUBECONFIG:-}" ]]; then
  KUBECONFIG_ARG=(--kubeconfig "$KUBECONFIG")
fi

NAMESPACE="${LLMGATEWAY_NAMESPACE:-llmgateway}"
FLEET="${LLMGATEWAY_FLEET:-prod}"

secret_json="$(kubectl "${KUBECONFIG_ARG[@]}" -n "$NAMESPACE" get secret cloud-load-newapi -o json)"
dec() {
  printf '%s' "$secret_json" | jq -r --arg k "$1" '.data[$k]' | base64 -d
}

redis_host() {
  python3 -c 'import sys,urllib.parse as u; p=u.urlsplit(sys.argv[1]); print(p.hostname or "")' "$1"
}

export SHARD_A_MYSQL_HOST="$(dec SHARD_A_MYSQL_HOST)"
export SHARD_B_MYSQL_HOST="$(dec SHARD_B_MYSQL_HOST)"
export SHARD_A_REDIS_HOST="$(redis_host "$(dec NEWAPI_A_REDIS_CONN)")"
export SHARD_B_REDIS_HOST="$(redis_host "$(dec NEWAPI_B_REDIS_CONN)")"

patch="$(envsubst < "$SCRIPT_DIR/llmfleet-shards-patch.json.template")"
kubectl "${KUBECONFIG_ARG[@]}" -n "$NAMESPACE" patch llmfleet "$FLEET" --type=merge --patch "$patch"
