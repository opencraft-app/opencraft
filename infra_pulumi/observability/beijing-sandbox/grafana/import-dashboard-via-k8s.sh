#!/usr/bin/env bash

set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required" >&2
  exit 1
fi

if ! command -v kubectl >/dev/null 2>&1; then
  echo "kubectl is required" >&2
  exit 1
fi

DASHBOARD_PATH="${1:-sandbox-overview.json}"
if [[ ! -f "${DASHBOARD_PATH}" ]]; then
  echo "dashboard file not found: ${DASHBOARD_PATH}" >&2
  exit 1
fi

GRAFANA_URL="${GRAFANA_URL:-http://10.15.230.21:8080}"
GRAFANA_USERNAME="${GRAFANA_USERNAME:-admin}"
GRAFANA_PASSWORD="${GRAFANA_PASSWORD:?GRAFANA_PASSWORD is required}"
K8S_NAMESPACE="${K8S_NAMESPACE:-sandbox}"

payload="$(jq -n --slurpfile dashboard "${DASHBOARD_PATH}" '{dashboard:$dashboard[0], folderId:0, overwrite:true}')"
payload_b64="$(printf '%s' "${payload}" | base64 | tr -d '\n')"
pod_name="grafana-dashboard-import-$(date +%s)"

kubectl -n "${K8S_NAMESPACE}" run "${pod_name}" \
  --image=curlimages/curl:8.8.0 \
  --rm -i --restart=Never \
  --env="GRAFANA_URL=${GRAFANA_URL}" \
  --env="GRAFANA_USERNAME=${GRAFANA_USERNAME}" \
  --env="GRAFANA_PASSWORD=${GRAFANA_PASSWORD}" \
  --env="PAYLOAD_B64=${payload_b64}" \
  --command -- sh -lc '
    set -euo pipefail
    printf "%s" "$PAYLOAD_B64" | base64 -d >/tmp/payload.json
    curl -fsS \
      -u "$GRAFANA_USERNAME:$GRAFANA_PASSWORD" \
      -H "Content-Type: application/json" \
      -X POST \
      "$GRAFANA_URL/api/dashboards/db" \
      --data @/tmp/payload.json
  '
