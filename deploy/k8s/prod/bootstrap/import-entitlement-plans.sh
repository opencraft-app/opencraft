#!/usr/bin/env bash
set -euo pipefail

CONTROL_URL="${1:-${LLMGATEWAY_CONTROL_URL:-}}"
PLAN_FILE="${2:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/entitlement-plans.json}"

: "${CONTROL_URL:?usage: LLMGATEWAY_CONTROL_URL=https://control.example.com import-entitlement-plans.sh}"
: "${LLMGATEWAY_CONTROL_TOKEN:?LLMGATEWAY_CONTROL_TOKEN is required}"

while IFS= read -r plan; do
  plan_id="$(jq -r '.id' <<<"${plan}")"
  plan_payload="$(jq -c 'del(.periods)' <<<"${plan}")"
  curl -fsS "${CONTROL_URL%/}/api/plans" \
    -H "Authorization: Bearer ${LLMGATEWAY_CONTROL_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary "${plan_payload}" >/dev/null
  while IFS= read -r period; do
    curl -fsS "${CONTROL_URL%/}/api/plans/${plan_id}/periods" \
      -H "Authorization: Bearer ${LLMGATEWAY_CONTROL_TOKEN}" \
      -H 'Content-Type: application/json' \
      --data-binary "${period}" >/dev/null
    printf 'registered entitlement plan period %s %s\n' "${plan_id}" "$(jq -r '"\(.period_value) \(.period_unit)"' <<<"${period}")"
  done < <(jq -c '.periods[]?' <<<"${plan}")
  curl -fsS "${CONTROL_URL%/}/api/plans/${plan_id}/sync" \
    -H "Authorization: Bearer ${LLMGATEWAY_CONTROL_TOKEN}" \
    -H 'Content-Type: application/json' \
    --data-binary '{"set_ids":[]}' >/dev/null
  printf 'queued entitlement plan %s\n' "${plan_id}"
done < <(jq -c '.[]' "${PLAN_FILE}")
