#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ENV_FILE="${ENV_FILE:-${ROOT_DIR}/.env}"
IMPORT_SCRIPT="${ROOT_DIR}/infra_pulumi/observability/beijing-sandbox/grafana/import-dashboard-via-k8s.sh"
DEFAULT_DASHBOARD="${ROOT_DIR}/infra_pulumi/observability/beijing-sandbox/grafana/sandbox-overview.json"

if [[ ! -f "${IMPORT_SCRIPT}" ]]; then
  echo "import script not found: ${IMPORT_SCRIPT}" >&2
  exit 1
fi

if [[ ! -f "${ENV_FILE}" ]]; then
  echo "env file not found: ${ENV_FILE}" >&2
  echo "Create ${ROOT_DIR}/.env from ${ROOT_DIR}/.env.example first." >&2
  exit 1
fi

set -a
# shellcheck disable=SC1090
source "${ENV_FILE}"
set +a

DASHBOARD_PATH="${1:-${DEFAULT_DASHBOARD}}"

if [[ ! -f "${DASHBOARD_PATH}" ]]; then
  echo "dashboard file not found: ${DASHBOARD_PATH}" >&2
  exit 1
fi

export KUBECONFIG="${SANDBOX_GRAFANA_KUBECONFIG:-${KUBECONFIG:-}}"
export GRAFANA_URL="${SANDBOX_GRAFANA_URL:-http://10.15.230.21:8080}"
export GRAFANA_USERNAME="${SANDBOX_GRAFANA_USERNAME:-admin}"
export GRAFANA_PASSWORD="${SANDBOX_GRAFANA_PASSWORD:?SANDBOX_GRAFANA_PASSWORD is required}"
export K8S_NAMESPACE="${SANDBOX_GRAFANA_K8S_NAMESPACE:-sandbox}"

exec "${IMPORT_SCRIPT}" "${DASHBOARD_PATH}"
